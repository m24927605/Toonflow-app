# MiniMax H3 Ref2VA pipeline executed on a Colab GPU session by minimaxH3.ts.
# Inputs, named h3in_<H3_JOB>_*: /content/h3in_<job>_prompt.txt, optional ref_* images, vid_* videos, aud_* audio,
# first.* and last.* frames, an optional control.* structure video
# (depth, pose or edges) for the Fun ControlNet Union 2.0, and the H3_* environment variables.
# Output: /content/h3out/final.mp4, followed by a COLAB_DONE line on success.
# 480p samples just above the target size; 720p samples at the model's native ~768p and downscales;
# 1080p upscales the 768p video latent with the LBH 3D latent upscaler and resamples it.
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
# Pinned to the revisions this pipeline was verified with.
comfyCommit = "7f7fd918ed0815c5d5ef2ccfe44bfc8e72cfd217"
upscalerCommit = "40316cf008b2fd8663263270669eb4da23f89d2c"

seed = int(os.environ["H3_SEED"])
resolution = os.environ["H3_RESOLUTION"]
duration = int(os.environ["H3_DURATION"])
audio = os.environ["H3_AUDIO"] == "1"
# Sampling steps that attend to the reference videos. A previs is flat Three.js footage: attended to throughout, H3
# copies its look, so it is dropped once the early steps have set the layout, motion and camera (Code Video Model's
# early-step conditioning, https://code-video-model.github.io).
steps = 4
videoSteps = int(os.environ["H3_VIDEO_STEPS"])
ratioWidth, ratioHeight = (int(part) for part in os.environ["H3_RATIO"].split(":"))
shortSides = {"480p": 480, "720p": 720, "1080p": 1080}
assert resolution in shortSides and 4 <= duration <= 15 and 1 <= videoSteps <= steps and ratioWidth > 0 and ratioHeight > 0


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
generateWidth, generateHeight = (ceil32(outputWidth), ceil32(outputHeight)) if resolution == "480p" else sized(768, ceil32)
upscaleWidth, upscaleHeight = ceil32(outputWidth), ceil32(outputHeight)
frames = round(duration * 24)
# Snapped up to the model's 17k+5 grid and kept within its trained 124–362 frames; ffmpeg trims to the duration.
length = max(124, frames + (5 - frames % 17) % 17)

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

import requests
from huggingface_hub import hf_hub_download

capability = torch.cuda.get_device_capability(0)
cudaMajor = int((torch.version.cuda or "0").split(".")[0])
variant = "int8_convrot" if cudaMajor >= 13 and capability >= (8, 0) else "fp8_scaled" if capability >= (8, 9) else "bf16"
diffusion = f"minimax_h3_ref2va_pruned_{variant}.safetensors"
videoVae = "minimax_h3_video_vae_int8_convrot.safetensors" if variant == "int8_convrot" else "minimax_h3_video_vae_fp16.safetensors"
lora = "minimax_h3_ref2v_turbo_4step_v0.1_comfyui_bf16.safetensors"
upscaler = "minimax_h3_latent_upscaler_3d_conv_v1_fp16.safetensors"
controlPatch = f"minimax_h3_fun_controlnet_union_2.0_pruned_{'int8_convrot' if variant == 'int8_convrot' else 'bf16'}.safetensors"
controlSource = next(inputs.glob(f"{prefix}control.*"), None)
print("Ref2VA variant:", variant)

weights = [
    ("Comfy-Org/MiniMax-H3", f"diffusion_models/{diffusion}", "diffusion_models"),
    ("Comfy-Org/MiniMax-H3", f"loras/{lora}", "loras"),
    ("Comfy-Org/MiniMax-H3", "text_encoders/qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors", "text_encoders"),
    ("Comfy-Org/MiniMax-H3", f"vae/{videoVae}", "vae"),
    ("Comfy-Org/MiniMax-H3", "vae/minimax_h3_audio_vae_fp32.safetensors", "vae"),
]
if controlSource:
    weights.append(("Comfy-Org/MiniMax-H3", f"model_patches/{controlPatch}", "model_patches"))
if refine:
    weights.append(("LBH-123-AI/Minimax_h3_latent_Upscaler", f"minimax_h3_latent_upscaler_3d_conv_v1/{upscaler}", "latent_upscale_models"))
for repo, remote, folder in weights:
    target = comfy / "models" / folder / Path(remote).name
    if target.exists():
        continue
    downloaded = Path(hf_hub_download(repo_id=repo, filename=remote, local_dir="/content/hf"))
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.move(downloaded, target)

refs = sorted(inputs.glob(f"{prefix}ref_*"))
firstFrame = next(inputs.glob(f"{prefix}first.*"), None)
lastFrame = next(inputs.glob(f"{prefix}last.*"), None)
(comfy / "input").mkdir(exist_ok=True)
for image in [*refs, *filter(None, [firstFrame, lastFrame])]:
    shutil.copy(image, comfy / "input" / image.name)
# Reference videos are re-encoded to 24 fps, silent and at most 15 s, the shape H3 expects for <Video N>.
videos = []
for index, source in enumerate(sorted(inputs.glob(f"{prefix}vid_*"))):
    target = comfy / "input" / f"h3vid{job}_{index}.mp4"
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", str(source), "-r", "24", "-t", "15", "-an", "-c:v", "libx264", "-pix_fmt", "yuv420p", str(target)], check=True)
    seconds = float(subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(target)], capture_output=True, text=True, check=True).stdout)
    if seconds < 2:
        raise ValueError(f"reference video {index + 1} is shorter than 2 seconds")
    videos.append(target.name)
# Standalone reference audio (<Audio N>), resampled to the audio VAE's 32 kHz stereo; a clip marked fully_copy in the
# prompt becomes the soundtrack and the speaker lip-syncs to it.
audios = []
for index, source in enumerate(sorted(inputs.glob(f"{prefix}aud_*"))):
    target = comfy / "input" / f"h3aud{job}_{index}.wav"
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", str(source), "-ar", "32000", "-ac", "2", str(target)], check=True)
    audios.append(target.name)
if controlSource:
    # The control video only drives structure and motion; its look never reaches the output.
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", str(controlSource), "-r", "24", "-t", "15", "-an", "-c:v", "libx264", "-pix_fmt", "yuv420p",
                    str(comfy / "input" / f"h3control{job}.mp4")], check=True)
prompt = (inputs / f"{prefix}prompt.txt").read_text()

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

videoFormat = {"format": "mp4", "format.codec": "h264", "format.codec.encoding": "re-encode", "format.codec.encoding.crf": 16}
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
    "9": {"class_type": "RandomNoise", "inputs": {"noise_seed": seed}},
    "10": {"class_type": "KSamplerSelect", "inputs": {"sampler_name": "euler"}},
    "11": {"class_type": "BasicScheduler", "inputs": {"model": ["2", 0], "scheduler": "beta", "steps": steps, "denoise": 1.0}},
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
graph["14"] = {"class_type": "VAEDecodeAudio", "inputs": {"samples": sampled, "vae": ["5", 0]}}
for index, ref in enumerate(refs):
    graph[f"ref{index}"] = {"class_type": "LoadImage", "inputs": {"image": ref.name}}
for index, name in enumerate(audios):
    graph[f"aud{index}"] = {"class_type": "LoadAudio", "inputs": {"audio": name}}
for index, name in enumerate(videos):
    graph[f"vidFile{index}"] = {"class_type": "LoadVideo", "inputs": {"file": name}}
    graph[f"vid{index}"] = {"class_type": "GetVideoComponents", "inputs": {"video": [f"vidFile{index}", 0]}}
# Official Union 2.0 setting: strength 1.0 over the whole schedule; the patched model feeds both passes.
model = ["2", 0]
if controlSource:
    graph.update({
        "cvFile": {"class_type": "LoadVideo", "inputs": {"file": f"h3control{job}.mp4"}},
        "cv": {"class_type": "GetVideoComponents", "inputs": {"video": ["cvFile", 0]}},
        "30": {"class_type": "ModelPatchLoader", "inputs": {"name": controlPatch}},
        "31": {"class_type": "MiniMaxH3FunControlNetApply", "inputs": {
            "model": ["2", 0], "model_patch": ["30", 0], "vae": ["4", 0], "strength": 1.0, "start_percent": 0.0, "end_percent": 1.0, "control_video": ["cv", 0]}},
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


graph["8"] = {"class_type": "BasicGuider", "inputs": {"model": model, "conditioning": guided("guide", ["7", 1])}}
if early:
    graph["8b"] = {"class_type": "BasicGuider", "inputs": {"model": model, "conditioning": guided("baseGuide", ["7", 1], "7b")}}
videoLatent = sampled
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
graph.update({
    "13": {"class_type": "VAEDecode", "inputs": {"samples": videoLatent, "vae": ["4", 0]}},
    "15": {"class_type": "CreateVideo", "inputs": {"images": ["13", 0], "audio": ["14", 0], "fps": 24}},
    "16": {"class_type": "SaveVideo", "inputs": {"video": ["15", 0], "filename_prefix": "toonflow/h3", **videoFormat}},
})

# LoRAs ride after the Turbo LoRA at their strength; every node that used the Turbo model takes the last one.
characterModel = ["2", 0]
loraStrengths = json.loads((inputs / f"{prefix}loras.json").read_text()) if (inputs / f"{prefix}loras.json").exists() else []
for index, source in enumerate(sorted(inputs.glob(f"{prefix}lora_*.safetensors"))):
    shutil.copy(source, comfy / "models" / "loras" / f"character_{job}_{index}.safetensors")
    graph[f"lora{index}"] = {"class_type": "LoraLoaderModelOnly", "inputs": {"model": characterModel, "lora_name": f"character_{job}_{index}.safetensors", "strength_model": float(loraStrengths[index]) if index < len(loraStrengths) else 1.0}}
    characterModel = [f"lora{index}", 0]
if characterModel != ["2", 0]:
    for key, node in graph.items():
        if not key.startswith("lora"):
            node["inputs"] = {name: characterModel if value == ["2", 0] else value for name, value in node["inputs"].items()}
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

produced = sorted((comfy / "output" / "toonflow").glob("h3_*.mp4"))[-1]
outputs.mkdir(exist_ok=True)
finish = f"scale={outputWidth}:{outputHeight}:force_original_aspect_ratio=increase:flags=lanczos,crop={outputWidth}:{outputHeight}"
subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", str(produced), "-t", str(duration), "-vf", finish,
                "-c:v", "libx264", "-crf", "16", "-preset", "slow", "-pix_fmt", "yuv420p",
                *(["-c:a", "aac", "-b:a", "192k"] if audio else ["-an"]),
                "-movflags", "+faststart", str(outputs / "final.mp4")], check=True)
# The job's inputs are deleted so a long session does not fill the disk.
for leftover in [*inputs.glob(f"{prefix}*"), *(comfy / "input").glob(f"*{job}*"), *(comfy / "models" / "loras").glob(f"character_{job}_*")]:
    leftover.unlink(missing_ok=True)
print("COLAB_DONE", resolution, f"{outputWidth}x{outputHeight}")
