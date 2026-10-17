# MiniMax H3 Ref2VA pipeline executed on a Colab GPU session by minimaxH3.ts.
# Inputs, named h3in_<H3_JOB>_*: /content/h3in_<job>_prompt.txt, optional ref_* images, vid_* videos, aud_* audio,
# first.* and last.* frames, an optional control.* structure video
# (depth, pose or edges) for the Fun ControlNet Union 2.0, and the H3_* environment variables.
# Output: /content/h3out/final.mp4, followed by a COLAB_DONE line on success.
# A long take (H3_SEGMENTS above 1, longer than one 15-second render) is rendered as that many segments in a row, one
# prompt each from h3in_<job>_prompts.json: every segment after the first continues the last 22 frames of the one before
# through H3 Motion Context, sampled once under the same conditioning as the first; the segments are joined into one
# take without cuts.
# 480p samples just above the target size; 720p samples at the model's native ~768p and downscales;
# 1080p upscales the 768p video latent with the LBH 3D latent upscaler and resamples it.
# Faces too small for the model to draw their eyes are then redrawn: each is tracked, cropped and enlarged, resampled
# lightly by H3 from the same references and LoRAs, and pasted back.
import json
import math
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

import torch

# Weights are public: download anonymously, without telemetry and without probing Colab secrets for an HF token.
os.environ.update(HF_HUB_DISABLE_TELEMETRY="1", HF_HUB_DISABLE_IMPLICIT_TOKEN="1", DO_NOT_TRACK="1")

inputs = Path("/content")
# Each job's files carry its own name, so a session that renders several clips never mixes one job's inputs, or
# ComfyUI's per-name caches of images, audio and LoRAs, into the next.
job = os.environ["H3_JOB"]
prefix = f"h3in_{job}_"
outputs = Path("/content/h3out")
comfy = Path("/content/ComfyUI")
upscalerNode = comfy / "custom_nodes" / "Comfyui_Minimax_h3_latent_Upscaler"
motionContextNode = comfy / "custom_nodes" / "ComfyUI-H3-Motion-Context"
# Pinned to the revisions this pipeline was verified with, the weights' repos too, so a changed upload upstream never
# reaches a render unnoticed.
comfyCommit = "7f7fd918ed0815c5d5ef2ccfe44bfc8e72cfd217"
upscalerCommit = "40316cf008b2fd8663263270669eb4da23f89d2c"
# NikoDemon80/ComfyUI-H3-Motion-Context (GPL-3.0, fetched at run time, not distributed).
motionContextCommit = "5335715abe54c1a9bfbe3494da29aae3e8635ce3"
weightRevisions = {
    "Comfy-Org/MiniMax-H3": "e5eb578a89295337b8ff433a035929ce0279e0b6",
    "LBH-123-AI/Minimax_h3_latent_Upscaler": "3f941d5d182014dd5c0a5e16330420ee2d4aa0c6",
    "lightx2v/Minimax-h3-Turbo": "a29e57d195f80ead07c89f89e55ecf2911e893c5",
    "opencv/face_detection_yunet": "3cc26e7f1014a5ee5d74a42acee58bafc9d0a310",
}

seed = int(os.environ["H3_SEED"])
resolution = os.environ["H3_RESOLUTION"]
duration = int(os.environ["H3_DURATION"])
segments = int(os.environ.get("H3_SEGMENTS", "1"))
audio = os.environ["H3_AUDIO"] == "1"
# Sampling steps that attend to the reference videos. A previs is flat Three.js footage: attended to throughout, H3
# copies its look, so it is dropped once the early steps have set the layout, motion and camera (Code Video Model's
# early-step conditioning, https://code-video-model.github.io). The Ref2VA Turbo 8-step v1.0 768p LoRA samples eight
# evenly spaced steps at video shift 6 and audio shift 3, as it was distilled at 1344x768 (ModelTC/Minimax-H3-Turbo); the
# 4-step v0.1 preview it replaces, distilled at 544p, left faces soft at 768p.
steps = 8
shifts = (6.0, 3.0)
videoSteps = int(os.environ["H3_VIDEO_STEPS"])
ratioWidth, ratioHeight = (int(part) for part in os.environ["H3_RATIO"].split(":"))
shortSides = {"480p": 480, "720p": 720, "1080p": 1080}
assert resolution in shortSides and 1 <= videoSteps <= steps and ratioWidth > 0 and ratioHeight > 0
# The 1080p pass upscales each render on its own, which a chain carried over in the sample latent cannot follow.
assert (segments == 1 and 4 <= duration <= 15) or (2 <= segments <= 8 and duration <= 120 and resolution != "1080p")


def ceil32(value):
    return math.ceil(value / 32) * 32


def sized(shortSide, rounding):
    # Applies the requested ratio to a short side, keeping the long side on the given rounding rule.
    if ratioWidth >= ratioHeight:
        return rounding(shortSide * ratioWidth / ratioHeight), shortSide
    return shortSide, rounding(shortSide * ratioHeight / ratioWidth)


def even(value):
    return round(value / 2) * 2


outputWidth, outputHeight = sized(shortSides[resolution], even)
refine = resolution == "1080p"
# The model needs dimensions in steps of 32; ffmpeg trims the result to the exact output size.
# Above 480p the model samples at the 768p it and the Turbo LoRA were trained at, 1344x768 for 16:9, the long side
# rounded down so the canvas stays within that area.
generateWidth, generateHeight = (ceil32(outputWidth), ceil32(outputHeight)) if resolution == "480p" else sized(768, lambda value: math.floor(value / 32) * 32)
upscaleWidth, upscaleHeight = ceil32(outputWidth), ceil32(outputHeight)
frames = round(duration * 24)
# Every segment after the first repeats the last 22 frames of the one before, which its output drops.
contextFrames = 22


def snapped(value):
    # Up to the model's 17k+5 grid and its trained minimum of 124 frames.
    return max(124, value + (5 - value % 17) % 17)


# Every segment of a long take is the length minimaxH3.ts planned, whose segments cover the take; ffmpeg trims to the
# duration.
length = snapped(frames) if segments == 1 else int(os.environ["H3_SEGMENT_LENGTH"])
assert 124 <= length <= 362 and (length - 5) % 17 == 0 and segments * (length - contextFrames) + contextFrames >= frames

def fetch(directory, url, commit):
    subprocess.run(["git", "init", "-q", str(directory)], check=True)
    subprocess.run(["git", "-C", str(directory), "fetch", "-q", "--depth", "1", url, commit], check=True)
    subprocess.run(["git", "-C", str(directory), "checkout", "-q", "FETCH_HEAD"], check=True)


print("GPU:", torch.cuda.get_device_name(0), round(torch.cuda.get_device_properties(0).total_memory / 2**30, 1), "GiB")
print(f"plan: {resolution} {outputWidth}x{outputHeight}, sample {generateWidth}x{generateHeight}, {length} frames, refine {refine}")

if not comfy.exists():
    fetch(comfy, "https://github.com/Comfy-Org/ComfyUI.git", comfyCommit)
    subprocess.run([sys.executable, "-m", "pip", "install", "-q", "-r", str(comfy / "requirements.txt"), "huggingface_hub", "hf_xet", "requests"], check=True)
if refine and not upscalerNode.exists():
    fetch(upscalerNode, "https://github.com/LBH-123-AI/Comfyui_Minimax_h3_latent_Upscaler.git", upscalerCommit)
# The motion context nodes are installed with the machine, before ComfyUI starts, so a warm machine can render a long
# take too; they need nothing beyond ComfyUI.
if not motionContextNode.exists():
    fetch(motionContextNode, "https://github.com/NikoDemon80/ComfyUI-H3-Motion-Context.git", motionContextCommit)

import requests
from huggingface_hub import hf_hub_download

capability = torch.cuda.get_device_capability(0)
cudaMajor = int((torch.version.cuda or "0").split(".")[0])
variant = "int8_convrot" if cudaMajor >= 13 and capability >= (8, 0) else "fp8_scaled" if capability >= (8, 9) else "bf16"
diffusion = f"minimax_h3_ref2va_pruned_{variant}.safetensors"
videoVae = "minimax_h3_video_vae_int8_convrot.safetensors" if variant == "int8_convrot" else "minimax_h3_video_vae_fp16.safetensors"
lora = "minimax_h3_ref2v_turbo_8step_v1.0_768p_comfyui_bf16.safetensors"
upscaler = "minimax_h3_latent_upscaler_3d_conv_v1_fp16.safetensors"
controlPatch = f"minimax_h3_fun_controlnet_union_2.0_pruned_{'int8_convrot' if variant == 'int8_convrot' else 'bf16'}.safetensors"
controlSource = next(inputs.glob(f"{prefix}control.*"), None)
print("Ref2VA variant:", variant)

weights = [
    ("Comfy-Org/MiniMax-H3", f"diffusion_models/{diffusion}", "diffusion_models"),
    ("lightx2v/Minimax-h3-Turbo", lora, "loras"),
    ("Comfy-Org/MiniMax-H3", "text_encoders/qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors", "text_encoders"),
    ("Comfy-Org/MiniMax-H3", f"vae/{videoVae}", "vae"),
    ("Comfy-Org/MiniMax-H3", "vae/minimax_h3_audio_vae_fp32.safetensors", "vae"),
]
if controlSource:
    weights.append(("Comfy-Org/MiniMax-H3", f"model_patches/{controlPatch}", "model_patches"))
if refine:
    weights.append(("LBH-123-AI/Minimax_h3_latent_Upscaler", f"minimax_h3_latent_upscaler_3d_conv_v1/{upscaler}", "latent_upscale_models"))
# OpenCV's YuNet face detector (MIT), which finds the faces to redraw.
faceDetector = "face_detection_yunet_2023mar.onnx"
weights.append(("opencv/face_detection_yunet", faceDetector, "facedetection"))
for repo, remote, folder in weights:
    target = comfy / "models" / folder / Path(remote).name
    if target.exists():
        continue
    downloaded = Path(hf_hub_download(repo_id=repo, filename=remote, revision=weightRevisions[repo], local_dir="/content/hf"))
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.move(downloaded, target)


base = "http://127.0.0.1:8188"
log = Path("/content/comfyui.log")
try:
    requests.get(base + "/system_stats", timeout=2).raise_for_status()
except requests.RequestException:
    launch = [sys.executable, "main.py", "--listen", "127.0.0.1", "--port", "8188", "--disable-auto-launch"]
    if torch.cuda.get_device_properties(0).total_memory < 48 * 2**30:
        launch.append("--lowvram")
    server = subprocess.Popen(launch, cwd=comfy, stdout=open(log, "a"), stderr=subprocess.STDOUT)
    for _ in range(300):
        if server.poll() is not None:
            raise RuntimeError(log.read_text()[-4000:])
        try:
            requests.get(base + "/system_stats", timeout=2).raise_for_status()
            break
        except requests.RequestException:
            time.sleep(2)
    else:
        raise TimeoutError("ComfyUI did not start")

# The machine is set up above this line; warmMinimaxH3 runs only that part, ahead of the first clip.
refs = sorted(inputs.glob(f"{prefix}ref_*"))
firstFrame = next(inputs.glob(f"{prefix}first.*"), None)
lastFrame = next(inputs.glob(f"{prefix}last.*"), None)
assert segments == 1 or not (firstFrame or lastFrame or controlSource), "A long take takes no first, last or control frames"
(comfy / "input").mkdir(exist_ok=True)
for image in [*refs, *filter(None, [firstFrame, lastFrame])]:
    shutil.copy(image, comfy / "input" / image.name)
# Each segment covers frames start to start + length of the take; a single render is one segment from frame 0.
starts = [index * (length - contextFrames) for index in range(segments)]


def clipped(source, target, start, audioOnly=False, span=None):
    # The part of a reference a segment covers, or `span` frames from `start`. Videos become 24 fps, silent and at
    # least two seconds, the shape H3 expects for <Video N> (a previs shorter than that, such as a brief shot's, holds
    # its last frame); audio becomes the audio VAE's 32 kHz stereo.
    seconds = span / 24 if span is not None else min(length, frames - start) / 24 if segments > 1 else 15
    window = ["-ss", f"{start / 24:.3f}", "-t", f"{seconds:.3f}"]
    if audioOnly:
        subprocess.run(["ffmpeg", "-v", "error", "-y", *window, "-i", str(source), "-ar", "32000", "-ac", "2", str(target)], check=True)
        return target.name
    subprocess.run(["ffmpeg", "-v", "error", "-y", *window, "-i", str(source), "-r", "24", "-an", "-c:v", "libx264", "-pix_fmt", "yuv420p", str(target)], check=True)
    seconds = float(subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(target)], capture_output=True, text=True, check=True).stdout)
    if seconds < 2:
        padded = target.with_name(f"pad{target.name}")
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", str(target), "-vf", f"tpad=stop_mode=clone:stop_duration={2.1 - seconds:.2f}",
                        "-an", "-c:v", "libx264", "-pix_fmt", "yuv420p", str(padded)], check=True)
        target = padded
    return target.name


# Reference videos and standalone reference audio (<Video N>, <Audio N>) per segment; audio marked fully_copy in the
# prompt becomes the soundtrack and the speaker lip-syncs to it.
segmentVideos = [[clipped(source, comfy / "input" / f"h3vid{job}_{segment}_{index}.mp4", start)
                  for index, source in enumerate(sorted(inputs.glob(f"{prefix}vid_*")))] for segment, start in enumerate(starts)]
segmentAudios = [[clipped(source, comfy / "input" / f"h3aud{job}_{segment}_{index}.wav", start, True)
                  for index, source in enumerate(sorted(inputs.glob(f"{prefix}aud_*")))] for segment, start in enumerate(starts)]
if controlSource:
    # The control video only drives structure and motion; its look never reaches the output.
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", str(controlSource), "-r", "24", "-t", "15", "-an", "-c:v", "libx264", "-pix_fmt", "yuv420p",
                    str(comfy / "input" / f"h3control{job}.mp4")], check=True)
prompts = json.loads((inputs / f"{prefix}prompts.json").read_text()) if segments > 1 else [(inputs / f"{prefix}prompt.txt").read_text()]
assert len(prompts) == segments

# LoRAs ride after the Turbo LoRA at their strength. Each is named by its content and stays on the machine, so the
# session's later clips use it without another upload.
characterLoras = json.loads((inputs / f"{prefix}loras.json").read_text()) if (inputs / f"{prefix}loras.json").exists() else []
for entry in characterLoras:
    assert "/" not in entry["name"] and entry["name"].startswith("h3lora_")
    target = comfy / "models" / "loras" / entry["name"]
    if not target.exists():
        shutil.copy(inputs / entry["name"], target)
videoFormat = {"format": "mp4", "format.codec": "h264", "format.codec.encoding": "re-encode", "format.codec.encoding.crf": 16}
# Where each segment of a long take saves its latent for the next: output/h3ctx_<job>/clip_0000<n>.safetensors.
contextFolder = f"h3ctx_{job}"


def segmentGraph(segment, prompt, videos, audios):
    # The render of one segment (numbered from 1); the first is the whole clip of a single render.
    graph = {
        "1": {"class_type": "UNETLoader", "inputs": {"unet_name": diffusion, "weight_dtype": "default"}},
        "2": {"class_type": "LoraLoaderModelOnly", "inputs": {"model": ["1", 0], "lora_name": lora, "strength_model": 1.0}},
        "3": {"class_type": "CLIPLoader", "inputs": {"clip_name": "qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors", "type": "minimax", "device": "default"}},
        "4": {"class_type": "VAELoader", "inputs": {"vae_name": videoVae}},
        "5": {"class_type": "VAELoader", "inputs": {"vae_name": "minimax_h3_audio_vae_fp32.safetensors"}},
        "7": {"class_type": "MiniMaxH3ReferenceToVideo", "inputs": {
            "clip": ["3", 0], "vae": ["4", 0], "audio_vae": ["5", 0], "prompt": prompt,
            "width": generateWidth, "height": generateHeight, "length": length, "ref_image_size": "match",
            **{f"ref_images.ref_image_{index}": [f"ref{index}", 0] for index in range(len(refs))},
            **{f"ref_videos.ref_video_{index}": [f"vid{index}", 0] for index in range(len(videos))},
            **{f"ref_audios.ref_audio_{index}": [f"aud{index}", 0] for index in range(len(audios))}}},
        "9": {"class_type": "RandomNoise", "inputs": {"noise_seed": seed + 1000 * (segment - 1)}},
        "10": {"class_type": "KSamplerSelect", "inputs": {"sampler_name": "euler"}},
        "2s": {"class_type": "MiniMaxH3SigmaShift", "inputs": {"model": ["2", 0], "shift_video": shifts[0], "shift_audio": shifts[1]}},
        "11": {"class_type": "BasicScheduler", "inputs": {"model": ["2s", 0], "scheduler": "simple", "steps": steps, "denoise": 1.0}},
        "12": {"class_type": "SamplerCustomAdvanced", "inputs": {"noise": ["9", 0], "guider": ["8", 0], "sampler": ["10", 0], "sigmas": ["11", 0], "latent_image": ["7", 1]}},
    }
    sampled = ["12", 0]
    early = bool(videos) and videoSteps < steps
    if early:
        # The same request without the reference videos conditions the remaining steps, continuing the first sampler's
        # latent without new noise.
        withoutVideos = json.loads(json.dumps(graph["7"]))
        withoutVideos["inputs"] = {name: value for name, value in withoutVideos["inputs"].items() if not name.startswith("ref_videos.")}
        graph.update({
            "7b": withoutVideos,
            "17": {"class_type": "SplitSigmas", "inputs": {"sigmas": ["11", 0], "step": videoSteps}},
            "18": {"class_type": "DisableNoise", "inputs": {}},
            "19": {"class_type": "SamplerCustomAdvanced", "inputs": {"noise": ["18", 0], "guider": ["8b", 0], "sampler": ["10", 0], "sigmas": ["17", 1], "latent_image": ["12", 0]}},
        })
        graph["12"]["inputs"]["sigmas"] = ["17", 0]
        sampled = ["19", 0]
    for index, ref in enumerate(refs):
        graph[f"ref{index}"] = {"class_type": "LoadImage", "inputs": {"image": ref.name}}
    for index, name in enumerate(audios):
        graph[f"aud{index}"] = {"class_type": "LoadAudio", "inputs": {"audio": name}}
    for index, name in enumerate(videos):
        graph[f"vidFile{index}"] = {"class_type": "LoadVideo", "inputs": {"file": name}}
        graph[f"vid{index}"] = {"class_type": "GetVideoComponents", "inputs": {"video": [f"vidFile{index}", 0]}}
    # Official Union 2.0 setting: strength 1.0 over the whole schedule; the patched model feeds both passes.
    model = ["2s", 0]
    if controlSource:
        graph.update({
            "cvFile": {"class_type": "LoadVideo", "inputs": {"file": f"h3control{job}.mp4"}},
            "cv": {"class_type": "GetVideoComponents", "inputs": {"video": ["cvFile", 0]}},
            "30": {"class_type": "ModelPatchLoader", "inputs": {"name": controlPatch}},
            "31": {"class_type": "MiniMaxH3FunControlNetApply", "inputs": {
                "model": ["2s", 0], "model_patch": ["30", 0], "vae": ["4", 0], "strength": 1.0, "start_percent": 0.0, "end_percent": 1.0, "control_video": ["cv", 0]}},
        })
        model = ["31", 0]
        graph["11"]["inputs"]["model"] = model
    for name, image in (("first", firstFrame), ("last", lastFrame)):
        if image:
            graph[f"{name}Frame"] = {"class_type": "LoadImage", "inputs": {"image": image.name}}

    def guided(prefix, latent, source="7"):
        # Pins the first frame at frame 0 and the last frame at the last frame that survives the final trim.
        # Guides are encoded at the latent's own size, so the 1080p refine pass gets its own chain.
        conditioning = [source, 0]
        for name, image, frameIndex in (("first", firstFrame, 0), ("last", lastFrame, frames - 1)):
            if image:
                graph[f"{prefix}{name}"] = {"class_type": "MiniMaxH3AddGuide", "inputs": {
                    "positive": conditioning, "vae": ["4", 0], "latent": latent, "image": [f"{name}Frame", 0], "frame_idx": frameIndex}}
                conditioning = [f"{prefix}{name}", 0]
        return conditioning

    def continued(key, conditioning, source="7"):
        # After the first segment, the last 22 frames and last second of sound of the one before are pinned as the head
        # of this one, never denoised, so picture, motion and sound carry on; output 1 is how many frames to drop.
        if segment == 1:
            return conditioning
        graph[key] = {"class_type": "MiniMaxH3MotionContext", "inputs": {
            "conditioning": conditioning, "vae": ["4", 0], "latent": [source, 1], "context_length": str(contextFrames),
            "audio_context_length": 24, "context_latent": ["context", 0]}}
        return [key, 0]

    if segment > 1:
        graph["context"] = {"class_type": "MiniMaxH3MotionContextLoadLatent", "inputs": {"latent_path": contextFolder, "clip_index": segment - 1}}
    graph["8"] = {"class_type": "BasicGuider", "inputs": {"model": model, "conditioning": continued("motion", guided("guide", ["7", 1]))}}
    if early:
        graph["8b"] = {"class_type": "BasicGuider", "inputs": {"model": model, "conditioning": continued("motionB", guided("baseGuide", ["7", 1], "7b"), "7b")}}
    videoLatent = sampled
    if segments > 1:
        graph["save"] = {"class_type": "MiniMaxH3MotionContextSaveLatent", "inputs": {"latent": videoLatent, "filename_prefix": f"{contextFolder}/clip", "clip_index": segment}}
    if refine:
        # Second-pass schedule from the LBH r2v example; the soundtrack stays from the first pass.
        graph.update({
            "20": {"class_type": "LTXVSeparateAVLatent", "inputs": {"av_latent": sampled}},
            "21": {"class_type": "MinimaxH3LatentUpscaler3D", "inputs": {
                "latent": ["20", 0], "model_name": upscaler, "mode": "target dimensions", "mode.width": upscaleWidth, "mode.height": upscaleHeight,
                "align": 32, "enable_temporal_chunking": True, "force_unload": True, "device": "cuda", "precision": "fp16"}},
            "22": {"class_type": "LTXVConcatAVLatent", "inputs": {"video_latent": ["21", 0], "audio_latent": ["20", 1]}},
            "23": {"class_type": "MiniMaxH3SigmaShift", "inputs": {"model": model, "shift_video": 12.0, "shift_audio": 3.0}},
            "24": {"class_type": "BasicGuider", "inputs": {"model": ["23", 0], "conditioning": guided("refineGuide", ["22", 0], "7b" if early else "7")}},
            "25": {"class_type": "ManualSigmas", "inputs": {"sigmas": "0.9035, 0.6316, 0.3158, 0.0000"}},
            "26": {"class_type": "SamplerCustomAdvanced", "inputs": {"noise": ["9", 0], "guider": ["24", 0], "sampler": ["10", 0], "sigmas": ["25", 0], "latent_image": ["22", 0]}},
        })
        videoLatent = ["26", 0]
    images, sound = ["13", 0], ["14", 0]
    graph.update({
        "13": {"class_type": "VAEDecode", "inputs": {"samples": videoLatent, "vae": ["4", 0]}},
        "14": {"class_type": "VAEDecodeAudio", "inputs": {"samples": sampled, "vae": ["5", 0]}},
    })
    if segment > 1:
        # The repeated head comes off picture and sound alike.
        graph["trim"] = {"class_type": "MiniMaxH3MotionContextTrim", "inputs": {"images": images, "trim_frames": ["motion", 1], "audio": sound, "fps": 24.0, "match_tail": True}}
        images, sound = ["trim", 0], ["trim", 1]
    graph.update({
        "15": {"class_type": "CreateVideo", "inputs": {"images": images, "audio": sound, "fps": 24}},
        "16": {"class_type": "SaveVideo", "inputs": {"video": ["15", 0], "filename_prefix": f"toonflow/h3_{job}_{segment}", **videoFormat}},
    })
    return withCharacters(graph)


def withCharacters(graph):
    # Every node that used the Turbo model takes the last character LoRA.
    characterModel = ["2", 0]
    for index, entry in enumerate(characterLoras):
        graph[f"lora{index}"] = {"class_type": "LoraLoaderModelOnly", "inputs": {"model": characterModel, "lora_name": entry["name"], "strength_model": float(entry["strength"])}}
        characterModel = [f"lora{index}", 0]
    if characterModel != ["2", 0]:
        for key, node in graph.items():
            if not key.startswith("lora"):
                node["inputs"] = {name: characterModel if value == ["2", 0] else value for name, value in node["inputs"].items()}
    return graph


def runGraph(graph, name):
    # Queues a graph, waits for it and returns the video its save node wrote under output/toonflow/<name>_*.
    response = requests.post(base + "/prompt", json={"prompt": graph}, timeout=60)
    if not response.ok:
        raise RuntimeError(response.text[-4000:])
    promptId = response.json()["prompt_id"]
    while True:
        history = requests.get(f"{base}/history/{promptId}", timeout=30).json().get(promptId)
        if history and history.get("status", {}).get("completed") is not None:
            break
        time.sleep(15)
    if history["status"].get("status_str") != "success":
        raise RuntimeError(str(history["status"].get("messages"))[-3000:] + "\n" + log.read_text()[-3000:])
    saved = sorted((comfy / "output" / "toonflow").glob(f"{name}_*.mp4"))
    # ComfyUI reports success for a graph whose save node it skipped, such as one with a loop in it.
    if not saved:
        raise RuntimeError(f"{name} saved no video: " + json.dumps(history.get("outputs", {}))[-2000:] + "\n" + log.read_text()[-3000:])
    return saved[-1]


# Segments render one after another: each needs the latent the one before saved.
rendered = []
for segment, (prompt, videos, audios) in enumerate(zip(prompts, segmentVideos, segmentAudios), start=1):
    rendered.append(runGraph(segmentGraph(segment, prompt, videos, audios), f"h3_{job}_{segment}"))

outputs.mkdir(exist_ok=True)
produced = rendered[0]
if segments > 1:
    # The segments join without re-encoding; the finish below cuts the take to its duration.
    joined = Path(f"/content/h3joined_{job}.txt")
    joined.write_text("".join(f"file '{path}'\n" for path in rendered))
    produced = Path(f"/content/h3joined_{job}.mp4")
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "concat", "-safe", "0", "-i", str(joined), "-c", "copy", str(produced)], check=True)

# Face redraw. A face under about four of the model's 32-pixel latent cells tall comes out with smeared or doubled eyes,
# so each such face is tracked over the clip, cropped square at faceCrop times its height, enlarged to faceCanvas and
# sampled again by H3 from its own picture, with the clip's references, LoRAs, prompt and dubbed track, over the last
# steps of the schedule only, so the face gains detail but keeps its pose and motion; it is then pasted back under a
# feathered ellipse, its colour matched to the frame. The approach of ComfyUI-H3-FaceRefine (MIT), built from core nodes.
# ACT: The size limit, crop, canvas and starting step come from community reports and one film's measurements, not a
# sweep; tune them on more films. A redraw that fails leaves the clip as rendered.
smallFace = 0.125 * generateHeight
faceCrop = 3.0
faceCanvas = 512
# The redraw starts at step 5 of 8, sigma about 0.78 at shift 6: lower keeps a smeared eye, higher redraws the person.
faceStartStep = 5
faceFade = 6


def mediaSeconds(path):
    return float(subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(path)], capture_output=True, text=True, check=True).stdout)


def smoothed(values, window):
    # A Gaussian moving average over one run of frames, the edges held.
    import numpy as np
    sigma = window / 6
    radius = int(3 * sigma)
    kernel = np.exp(-0.5 * (np.arange(-radius, radius + 1) / sigma) ** 2)
    kernel /= kernel.sum()
    padded = np.pad(np.asarray(values, dtype=float), radius, mode="edge")
    return np.convolve(padded, kernel, mode="valid")


def faceTracks(frames):
    # Each person's face over the clip: YuNet finds the faces in every frame, each joins the track whose last face is
    # nearest and of a like size, gaps of up to half a second are filled, and centre and size are smoothed.
    import cv2
    import numpy as np
    height, width = frames[0].shape[:2]
    detector = cv2.FaceDetectorYN.create(str(comfy / "models" / "facedetection" / faceDetector), "", (width, height), 0.6, 0.3, 50)
    tracks = []
    for index, frame in enumerate(frames):
        faces = detector.detect(frame)[1]
        for x, y, w, h in ([] if faces is None else faces[:, :4]):
            centre = (x + w / 2, y + h / 2)
            near = [track for track in tracks if index - track["last"] <= 12 and index not in track["boxes"]
                    and 0.6 < h / track["boxes"][track["last"]][2] < 1.6
                    and math.dist(centre, track["boxes"][track["last"]][:2]) < 0.75 * track["boxes"][track["last"]][2]]
            track = min(near, key=lambda item: math.dist(centre, item["boxes"][item["last"]][:2]), default=None)
            if track is None:
                track = {"boxes": {}}
                tracks.append(track)
            track["boxes"][index] = (*centre, h)
            track["last"] = index
    runs = []
    for track in tracks:
        if len(track["boxes"]) < 24:
            continue
        known = sorted(track["boxes"])
        # Runs of frames with a face, across gaps of at most 12 frames.
        start = known[0]
        for previous, current in zip(known + [None], known[1:] + [None]):
            if current is not None and current - previous <= 12:
                continue
            frameIndexes = np.arange(start, previous + 1)
            if len(frameIndexes) >= 24:
                boxes = np.array([np.interp(frameIndexes, known, [track["boxes"][index][axis] for index in known]) for axis in range(3)])
                runs.append({"start": start, "x": smoothed(boxes[0], 21), "y": smoothed(boxes[1], 21), "h": smoothed(boxes[2], 51)})
            start = current
    return runs


def cropTransform(x, y, h):
    # The affine map from the frame to the square canvas around a face, a little above its centre to keep the hair.
    import numpy as np
    side = faceCrop * h
    scale = faceCanvas / side
    left, top = x - side / 2, y - 0.1 * h - side / 2
    return np.array([[scale, 0, -left * scale], [0, scale, -top * scale]], dtype=np.float32)


def redrawRun(frames, run, number, refPrompt):
    # Redraws one face over one run of frames, in windows the model can sample, crossfaded where they overlap.
    import cv2
    import numpy as np
    height, width = frames[0].shape[:2]
    count = len(run["h"])
    windows = []
    first = 0
    while True:
        last = min(count, first + 362)
        windows.append((first, last))
        if last == count:
            break
        first = last - 17
    for window, (first, last) in enumerate(windows):
        frameCount = last - first
        length = max(124, frameCount + (5 - frameCount % 17) % 17)
        name = f"h3face{job}_{number}_{window}"
        crop = comfy / "input" / f"{name}.mp4"
        writer = cv2.VideoWriter(str(crop), cv2.VideoWriter_fourcc(*"mp4v"), 24, (faceCanvas, faceCanvas))
        maps = []
        for offset in range(length):
            index = min(first + offset, last - 1)
            matrix = cropTransform(run["x"][index], run["y"][index], run["h"][index])
            if offset < frameCount:
                maps.append(matrix)
            writer.write(cv2.warpAffine(frames[run["start"] + index], matrix, (faceCanvas, faceCanvas), flags=cv2.INTER_CUBIC, borderMode=cv2.BORDER_REPLICATE))
        writer.release()
        start = run["start"] + first
        # The dubbed track over this window's own frames; a track that ends before the window is left out.
        sound = [clipped(source, comfy / "input" / f"{name}_{index}.wav", start, True, length)
                 for index, source in enumerate(sorted(inputs.glob(f"{prefix}aud_*"))) if start / 24 + 0.1 < mediaSeconds(source)]
        graph = {
            "1": {"class_type": "UNETLoader", "inputs": {"unet_name": diffusion, "weight_dtype": "default"}},
            "2": {"class_type": "LoraLoaderModelOnly", "inputs": {"model": ["1", 0], "lora_name": lora, "strength_model": 1.0}},
            "2s": {"class_type": "MiniMaxH3SigmaShift", "inputs": {"model": ["2", 0], "shift_video": shifts[0], "shift_audio": shifts[1]}},
            "3": {"class_type": "CLIPLoader", "inputs": {"clip_name": "qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors", "type": "minimax", "device": "default"}},
            "4": {"class_type": "VAELoader", "inputs": {"vae_name": videoVae}},
            "5": {"class_type": "VAELoader", "inputs": {"vae_name": "minimax_h3_audio_vae_fp32.safetensors"}},
            "cropFile": {"class_type": "LoadVideo", "inputs": {"file": crop.name}},
            "crop": {"class_type": "GetVideoComponents", "inputs": {"video": ["cropFile", 0]}},
            "7": {"class_type": "MiniMaxH3ReferenceToVideo", "inputs": {
                "clip": ["3", 0], "vae": ["4", 0], "audio_vae": ["5", 0], "prompt": refPrompt(start),
                "width": faceCanvas, "height": faceCanvas, "length": length, "ref_image_size": "match",
                **{f"ref_images.ref_image_{index}": [f"ref{index}", 0] for index in range(len(refs))},
                **{f"ref_audios.ref_audio_{index}": [f"aud{index}", 0] for index in range(len(sound))}}},
            # The crop, encoded, takes the place of the empty video latent; the sound stream is sampled and dropped.
            "encoded": {"class_type": "VAEEncode", "inputs": {"pixels": ["crop", 0], "vae": ["4", 0]}},
            "split": {"class_type": "LTXVSeparateAVLatent", "inputs": {"av_latent": ["7", 1]}},
            "joined": {"class_type": "LTXVConcatAVLatent", "inputs": {"video_latent": ["encoded", 0], "audio_latent": ["split", 1]}},
            "8": {"class_type": "BasicGuider", "inputs": {"model": ["2s", 0], "conditioning": ["7", 0]}},
            "9": {"class_type": "RandomNoise", "inputs": {"noise_seed": seed + 500 + number}},
            "10": {"class_type": "KSamplerSelect", "inputs": {"sampler_name": "euler"}},
            "11": {"class_type": "BasicScheduler", "inputs": {"model": ["2s", 0], "scheduler": "simple", "steps": steps, "denoise": 1.0}},
            "tail": {"class_type": "SplitSigmas", "inputs": {"sigmas": ["11", 0], "step": faceStartStep}},
            "12": {"class_type": "SamplerCustomAdvanced", "inputs": {"noise": ["9", 0], "guider": ["8", 0], "sampler": ["10", 0], "sigmas": ["tail", 1], "latent_image": ["joined", 0]}},
            "13": {"class_type": "VAEDecode", "inputs": {"samples": ["12", 0], "vae": ["4", 0]}},
            "15": {"class_type": "CreateVideo", "inputs": {"images": ["13", 0], "fps": 24}},
            "16": {"class_type": "SaveVideo", "inputs": {"video": ["15", 0], "filename_prefix": f"toonflow/{name}", **videoFormat}},
        }
        for index, ref in enumerate(refs):
            graph[f"ref{index}"] = {"class_type": "LoadImage", "inputs": {"image": ref.name}}
        for index, wav in enumerate(sound):
            graph[f"aud{index}"] = {"class_type": "LoadAudio", "inputs": {"audio": wav}}
        reader = cv2.VideoCapture(str(runGraph(withCharacters(graph), name)))
        for offset, matrix in enumerate(maps):
            ok, redrawn = reader.read()
            if not ok:
                break
            index = first + offset
            # Fades in and out at the run's ends and across the overlap with the window before.
            weight = min(1.0, (index + 1) / faceFade, (count - index) / faceFade, (offset + 1) / 17 if window else 1.0)
            source = frames[run["start"] + index]
            original = cv2.warpAffine(source, matrix, (faceCanvas, faceCanvas), flags=cv2.INTER_CUBIC, borderMode=cv2.BORDER_REPLICATE)
            # A feathered ellipse over the face, about its own size, inside the canvas.
            h = run["h"][index] * faceCanvas / (faceCrop * run["h"][index])
            mask = np.zeros((faceCanvas, faceCanvas), np.float32)
            cv2.ellipse(mask, (faceCanvas // 2, int(faceCanvas / 2 + 0.1 * h)), (int(0.7 * h), int(0.95 * h)), 0, 0, 360, 1.0, -1)
            mask = cv2.GaussianBlur(mask, (0, 0), 0.15 * h)
            inside = mask > 0.5
            redrawn = redrawn.astype(np.float32)
            # The redrawn face takes the frame's colour and contrast under the mask.
            for channel in range(3):
                values, target = redrawn[..., channel][inside], original[..., channel][inside].astype(np.float32)
                redrawn[..., channel] = (redrawn[..., channel] - values.mean()) / (values.std() + 1e-6) * target.std() + target.mean()
            inverse = cv2.invertAffineTransform(matrix)
            pasted = cv2.warpAffine(np.clip(redrawn, 0, 255), inverse, (width, height), flags=cv2.INTER_CUBIC)
            alpha = cv2.warpAffine(mask * weight, inverse, (width, height), flags=cv2.INTER_LINEAR)[..., None]
            # Cubic warping overshoots past 0 and 255 at sharp edges such as pupils, so the blend is clipped.
            frames[run["start"] + index] = np.clip(np.rint(source * (1 - alpha) + pasted * alpha), 0, 255).astype(np.uint8)
        reader.release()


def redrawFaces(video):
    # The clip with every small face redrawn, or None when no face needs it.
    import cv2
    import numpy as np
    reader = cv2.VideoCapture(str(video))
    frames = []
    while True:
        ok, frame = reader.read()
        if not ok:
            break
        frames.append(frame)
    reader.release()
    runs = [run for run in faceTracks(frames) if np.median(run["h"]) < smallFace]
    print(f"faces to redraw: {len(runs)}", [(run["start"], len(run["h"]), round(float(np.median(run["h"])))) for run in runs])
    if not runs:
        return None
    started = time.time()
    # Each frame of a long take belongs to the segment whose own frames hold it, whose prompt describes it.
    refPrompt = lambda frame: prompts[min(segments - 1, max(0, frame - contextFrames) // (length - contextFrames))] if segments > 1 else prompts[0]
    for number, run in enumerate(runs):
        redrawRun(frames, run, number, refPrompt)
    height, width = frames[0].shape[:2]
    target = Path(f"/content/h3faces_{job}.mp4")
    encoder = subprocess.Popen(["ffmpeg", "-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "bgr24", "-s", f"{width}x{height}", "-r", "24", "-i", "-",
                                "-i", str(video), "-map", "0:v", "-map", "1:a?", "-c:v", "libx264", "-crf", "14", "-pix_fmt", "yuv420p", "-c:a", "copy",
                                str(target)], stdin=subprocess.PIPE)
    for frame in frames:
        encoder.stdin.write(frame.tobytes())
    encoder.stdin.close()
    if encoder.wait():
        raise RuntimeError("The redrawn faces could not be encoded")
    print(f"faces redrawn in {round(time.time() - started)} s")
    return target


try:
    produced = redrawFaces(produced) or produced
except Exception as error:
    print("FACE_REDRAW_FAILED", repr(error)[-2000:], log.read_text()[-2000:])
finish = f"scale={outputWidth}:{outputHeight}:force_original_aspect_ratio=increase:flags=lanczos,crop={outputWidth}:{outputHeight}"
subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", str(produced), "-t", str(duration), "-vf", finish,
                "-c:v", "libx264", "-crf", "16", "-preset", "slow", "-pix_fmt", "yuv420p",
                *(["-c:a", "aac", "-b:a", "192k"] if audio else ["-an"]),
                "-movflags", "+faststart", str(outputs / "final.mp4")], check=True)
# The job's inputs and saved latents are deleted so a long session does not fill the disk.
for leftover in [*inputs.glob(f"{prefix}*"), *(comfy / "input").glob(f"*{job}*"), *(comfy / "output" / "toonflow").glob(f"*{job}*"),
                 *inputs.glob(f"h3joined_{job}*"), *inputs.glob(f"h3faces_{job}*")]:
    leftover.unlink(missing_ok=True)
shutil.rmtree(comfy / "output" / contextFolder, ignore_errors=True)
print("COLAB_DONE", resolution, f"{outputWidth}x{outputHeight}")
