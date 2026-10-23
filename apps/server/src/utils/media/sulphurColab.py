# Sulphur 2 (an LTX-2.3 22B fine-tune) pipeline executed on a Colab GPU session by sulphur.ts.
# Inputs, named sulin_<SULPHUR_JOB>_*: /content/sulin_<job>_prompt.txt (or prompts.json for a long take), optional
# first.* and last.* frames, an optional control.* structure video (depth, pose or edges) for the IC-LoRA Union Control,
# an optional audio.* soundtrack locked into the audio stream, optional loras.json with its LoRA files, and the
# SULPHUR_* environment variables.
# Output: /content/sulphurOut/<job>/final.mp4 and timings.json, followed by a COLAB_DONE line on success.
# Every render samples twice, as Sulphur's own distilled workflow does: eight steps at half size on the dev GGUF with the
# distill LoRA at 0.7, then the x2 latent upscaler and three refining steps with the LoRA at 0.5. A long take (more than
# one segment) renders its segments in a row, one prompt each: every segment after the first opens on the last 25
# frames of the one before, held unchanged, and drops them when the segments are joined into one take without cuts.
import json
import math
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

# Seconds since the job started at the end of each phase, written to timings.json beside the video.
jobStarted = time.time()
timings = {}


def mark(phase):
    timings[phase] = round(time.time() - jobStarted, 1)

# Weights are public: download anonymously, without telemetry and without probing Colab secrets for an HF token.
os.environ.update(HF_HUB_DISABLE_TELEMETRY="1", HF_HUB_DISABLE_IMPLICIT_TOKEN="1", DO_NOT_TRACK="1")

inputs = Path("/content")
# Each job's files carry its own name, so a session that renders several clips never mixes one job's inputs, or
# ComfyUI's per-name caches of images, audio and LoRAs, into the next.
job = os.environ["SULPHUR_JOB"]
prefix = f"sulin_{job}_"
outputs = Path("/content/sulphurOut") / job
comfy = Path("/content/sulphurRuntime/ComfyUI")
ggufNode = comfy / "custom_nodes" / "ComfyUI-GGUF"
# Pinned to the revisions this pipeline was written against, the weights' repos too, so a changed upload upstream never
# reaches a render unnoticed. The projection, video VAE and audio VAE are Kijai's split copies of LTX-2.3's own, which
# Sulphur 2 keeps unchanged (compared tensor by tensor against both full checkpoints on 2026-10-24).
comfyCommit = "7f7fd918ed0815c5d5ef2ccfe44bfc8e72cfd217"
# city96/ComfyUI-GGUF (Apache-2.0), fetched at run time.
ggufCommit = "6ea2651e7df66d7585f6ffee804b20e92fb38b8a"
ggufPackage = "0.19.0"
weightRevisions = {
    "vantagewithai/Sulphur-2-Base-GGUF": "b5f8a0caffa2e42e5acfcb4b3bbf4f6572fb580d",
    "SulphurAI/Sulphur-2-base": "65587bbb38c700622f9434a16e732c8b280c115e",
    "Comfy-Org/ltx-2": "ccde4ba417d7900669fd56dd292a883cee11ff37",
    "Kijai/LTX2.3_comfy": "6d980fde0d330f2fed6ff8dfdfddb06d88a004e5",
    "Lightricks/LTX-2.3": "c1521179de480464f366a98a9d9b2acc4cc097b9",
    "Lightricks/LTX-2.3-22b-IC-LoRA-Union-Control": "20a580c8606c06a0988d40375a61309e0fe5893d",
}
diffusion = "sulphur_dev-Q8_0.gguf"
distill = "ltx-2.3-22b-distilled-lora-1.1_fro90_ceil72_condsafe.safetensors"
encoder = "gemma_3_12B_it.safetensors"
projection = "ltx-2.3_text_projection_bf16.safetensors"
videoVae = "LTX23_video_vae_bf16.safetensors"
audioVae = "LTX23_audio_vae_bf16.safetensors"
upscaler = "ltx-2.3-spatial-upscaler-x2-1.1.safetensors"
controlLora = "ltx-2.3-22b-ic-lora-union-control-ref0.5.safetensors"
# The projection and audio VAE load through LTX's loaders, which read the checkpoints folder.
weights = [
    ("vantagewithai/Sulphur-2-Base-GGUF", diffusion, "diffusion_models"),
    ("SulphurAI/Sulphur-2-base", f"distill_loras/{distill}", "loras"),
    ("Comfy-Org/ltx-2", f"split_files/text_encoders/{encoder}", "text_encoders"),
    ("Kijai/LTX2.3_comfy", f"text_encoders/{projection}", "checkpoints"),
    ("Kijai/LTX2.3_comfy", f"vae/{videoVae}", "vae"),
    ("Kijai/LTX2.3_comfy", f"vae/{audioVae}", "checkpoints"),
    ("Lightricks/LTX-2.3", upscaler, "latent_upscale_models"),
    ("Lightricks/LTX-2.3-22b-IC-LoRA-Union-Control", controlLora, "loras"),
]
entries = [(repo, weightRevisions[repo], remote, str(comfy / "models" / folder / Path(remote).name)) for repo, remote, folder in weights]

seed = int(os.environ["SULPHUR_SEED"])
resolution = os.environ["SULPHUR_RESOLUTION"]
duration = int(os.environ["SULPHUR_DURATION"])
segments = int(os.environ.get("SULPHUR_SEGMENTS", "1"))
length = int(os.environ["SULPHUR_SEGMENT_FRAMES"])
audio = os.environ["SULPHUR_AUDIO"] == "1"
ratioWidth, ratioHeight = (int(part) for part in os.environ["SULPHUR_RATIO"].split(":"))
shortSides = {"480p": 480, "720p": 720, "1080p": 1080}
frames = round(duration * 24)
# Every segment after the first repeats the last 25 frames (one second and a frame, on the VAE's 8n+1 grid) of the one
# before, which its output drops.
contextFrames = 25
assert resolution in shortSides and ratioWidth > 0 and ratioHeight > 0
assert 25 <= length <= 481 and (length - 1) % 8 == 0 and segments * (length - contextFrames) + contextFrames >= frames
assert (segments == 1 and 1 <= duration <= 20) or (2 <= segments <= 9 and duration <= 120)


def even(value):
    return round(value / 2) * 2


def ceil128(value):
    return math.ceil(value / 128) * 128


def sized(shortSide, rounding):
    # Applies the requested ratio to a short side, keeping the long side on the given rounding rule.
    if ratioWidth >= ratioHeight:
        return rounding(shortSide * ratioWidth / ratioHeight), shortSide
    return shortSide, rounding(shortSide * ratioHeight / ratioWidth)


outputWidth, outputHeight = sized(shortSides[resolution], even)
# The full size is a multiple of 128 so the half-size first pass stays on the latent's 32-pixel grid and the IC-LoRA's
# half-size guide on the pass's own; ffmpeg crops the result to the exact output size.
generateWidth, generateHeight = ceil128(outputWidth), ceil128(outputHeight)


def fetch(directory, url, commit):
    head = directory / ".git/HEAD"
    if head.exists() and head.read_text().strip() == commit:
        return
    subprocess.run(["git", "init", "-q", str(directory)], check=True)
    subprocess.run(["git", "-C", str(directory), "fetch", "-q", "--depth", "1", url, commit], check=True)
    subprocess.run(["git", "-C", str(directory), "checkout", "-q", "FETCH_HEAD"], check=True)


from modelPreparation import downloadWeights, installComfy, installPackages, installationIdentity

if os.environ.get("TOONFLOW_PREFETCH_ONLY") == "1":
    downloadWeights(entries)
    print("COLAB_DONE")
    raise SystemExit(0)
installation = installationIdentity("comfy", comfyCommit)
if not (comfy / "toonflowReady").exists() or (comfy / "toonflowReady").read_text() != installation:
    installComfy(comfy, comfyCommit)
    (comfy / "toonflowReady").write_text(installation)
from importlib.metadata import version, PackageNotFoundError
try:
    installedGguf = version("gguf")
except PackageNotFoundError:
    installedGguf = None
if installedGguf != ggufPackage:
    installPackages(sys.executable, "comfy", [f"gguf=={ggufPackage}"])
fetch(ggufNode, "https://github.com/city96/ComfyUI-GGUF.git", ggufCommit)
import torch
import requests
print("GPU:", torch.cuda.get_device_name(0), round(torch.cuda.get_device_properties(0).total_memory / 2**30, 1), "GiB")
print(f"plan: {resolution} {outputWidth}x{outputHeight}, sample {generateWidth}x{generateHeight}, {segments} x {length} frames")
# A dubbed track is locked into the audio stream: its latent is held with a zero noise mask, so the model draws the
# picture, mouths included, to that exact sound.
(comfy / "custom_nodes" / "toonflow_sulphur.py").write_text("""
import torch


class ToonflowLockedAudio:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"samples": ("LATENT",)}}

    RETURN_TYPES = ("LATENT",)
    FUNCTION = "lock"
    CATEGORY = "toonflow"

    def lock(self, samples):
        locked = dict(samples)
        locked["noise_mask"] = torch.zeros_like(samples["samples"])
        return (locked,)


NODE_CLASS_MAPPINGS = {"ToonflowLockedAudio": ToonflowLockedAudio}
""")

downloadWeights(entries)

if os.environ.get("TOONFLOW_DOWNLOAD_ONLY") == "1":
    print("COLAB_DONE")
    raise SystemExit(0)

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

# The machine is set up above this line; warmSulphur runs only that part, ahead of the first clip.
mark("setup")
info = requests.get(base + "/object_info", timeout=30).json()
missing = [name for name in ["UnetLoaderGGUF", "ToonflowLockedAudio", "GetICLoRAParameters", "LTXAVTextEncoderLoader"] if name not in info]
if missing:
    raise RuntimeError(f"ComfyUI did not register {', '.join(missing)}:\n" + log.read_text()[-3000:])
timings["recipe"] = {"model": "sulphur2Q8", "comfyCommit": comfyCommit, "ggufCommit": ggufCommit, "weightRevisions": weightRevisions,
                     "passes": [{"steps": 8, "distillStrength": 0.7, "scale": 0.5}, {"steps": 3, "distillStrength": 0.5, "scale": 1}]}
firstFrame = next(inputs.glob(f"{prefix}first.*"), None)
lastFrame = next(inputs.glob(f"{prefix}last.*"), None)
controlSource = next(inputs.glob(f"{prefix}control.*"), None)
track = next(inputs.glob(f"{prefix}audio.*"), None)
(comfy / "input").mkdir(exist_ok=True)
for image in filter(None, [firstFrame, lastFrame]):
    shutil.copy(image, comfy / "input" / image.name)
# Each segment covers frames start to start + length of the take; a single render is one segment from frame 0.
starts = [index * (length - contextFrames) for index in range(segments)]
take = segments * (length - contextFrames) + contextFrames
if controlSource:
    # The control video becomes the take's length at 24 fps, its last frame held when it is shorter; only its structure
    # reaches the clip.
    controlTake = Path(f"/content/sulphurControl_{job}.mp4")
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", str(controlSource), "-vf", f"fps=24,tpad=stop_mode=clone:stop_duration={take / 24 + 1:.3f}",
                    "-frames:v", str(take), "-an", "-c:v", "libx264", "-crf", "12", "-pix_fmt", "yuv420p", str(controlTake)], check=True)
if track:
    # Silence pads the soundtrack to the whole take, so every segment's window holds sound or silence, never nothing.
    trackTake = Path(f"/content/sulphurTrack_{job}.wav")
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", str(track), "-af", f"apad=whole_dur={take / 24:.4f}", "-t", f"{take / 24:.4f}",
                    "-ar", "48000", "-ac", "2", str(trackTake)], check=True)


def window(segment):
    # The control frames and soundtrack seconds a segment covers, cut into ComfyUI's input folder.
    start = starts[segment - 1]
    control = sound = None
    if controlSource:
        control = f"sulphurControl{job}_{segment}.mp4"
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", str(controlTake), "-vf", f"select='between(n,{start},{start + length - 1})',setpts=N/24/TB",
                        "-frames:v", str(length), "-an", "-c:v", "libx264", "-crf", "12", "-pix_fmt", "yuv420p", str(comfy / "input" / control)], check=True)
    if track:
        sound = f"sulphurTrack{job}_{segment}.wav"
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", str(trackTake), "-ss", f"{start / 24:.4f}", "-t", f"{length / 24:.4f}",
                        "-ar", "48000", "-ac", "2", str(comfy / "input" / sound)], check=True)
    return control, sound


prompts = json.loads((inputs / f"{prefix}prompts.json").read_text()) if segments > 1 else [(inputs / f"{prefix}prompt.txt").read_text()]
assert len(prompts) == segments

# LoRAs ride on the base model before the distill LoRA, at their strength. Each is named by its content and stays on the
# machine, so the session's later clips use it without another upload.
characterLoras = json.loads((inputs / f"{prefix}loras.json").read_text()) if (inputs / f"{prefix}loras.json").exists() else []
for entry in characterLoras:
    assert "/" not in entry["name"] and entry["name"].startswith("sulphurLora_")
    target = comfy / "models" / "loras" / entry["name"]
    if not target.exists():
        shutil.copy(inputs / entry["name"], target)
videoFormat = {"format": "mp4", "format.codec": "h264", "format.codec.encoding": "re-encode", "format.codec.encoding.crf": 16}
# Sulphur's own negative prompt; at CFG 1 it is encoded but has no effect.
negativePrompt = "pc game, console game, video game, cartoon, childish, ugly"


def segmentGraph(segment, prompt, control, sound, context):
    # The render of one segment (numbered from 1); the first is the whole clip of a single render.
    graph = {
        "unet": {"class_type": "UnetLoaderGGUF", "inputs": {"unet_name": diffusion}},
        "clip": {"class_type": "LTXAVTextEncoderLoader", "inputs": {"text_encoder": encoder, "ckpt_name": projection, "device": "default"}},
        "vae": {"class_type": "VAELoader", "inputs": {"vae_name": videoVae}},
        "audioVae": {"class_type": "LTXVAudioVAELoader", "inputs": {"ckpt_name": audioVae}},
        "upscaler": {"class_type": "LatentUpscaleModelLoader", "inputs": {"model_name": upscaler}},
        "positive": {"class_type": "CLIPTextEncode", "inputs": {"clip": ["clip", 0], "text": prompt}},
        "negative": {"class_type": "CLIPTextEncode", "inputs": {"clip": ["clip", 0], "text": negativePrompt}},
        "conditioning": {"class_type": "LTXVConditioning", "inputs": {"positive": ["positive", 0], "negative": ["negative", 0], "frame_rate": 24.0}},
        "audioTemplate": {"class_type": "LTXVEmptyLatentAudio", "inputs": {"frames_number": length, "frame_rate": 24, "batch_size": 1, "audio_vae": ["audioVae", 0]}},
        "sampler": {"class_type": "KSamplerSelect", "inputs": {"sampler_name": "euler_ancestral_cfg_pp"}},
    }
    model = ["unet", 0]
    for index, entry in enumerate(characterLoras):
        graph[f"lora{index}"] = {"class_type": "LoraLoaderModelOnly", "inputs": {"model": model, "lora_name": entry["name"], "strength_model": float(entry["strength"])}}
        model = [f"lora{index}", 0]
    models = []
    for name, strength in (("distillFirst", 0.7), ("distillSecond", 0.5)):
        graph[name] = {"class_type": "LoraLoaderModelOnly", "inputs": {"model": model, "lora_name": distill, "strength_model": strength}}
        models.append([name, 0])
    if control:
        # The Union Control IC-LoRA reads its guide at half the pass's size, a factor its metadata carries.
        for index, name in enumerate(("controlFirst", "controlSecond")):
            graph[name] = {"class_type": "LoraLoaderModelOnly", "inputs": {"model": models[index], "lora_name": controlLora, "strength_model": 1.0}}
            models[index] = [name, 0]
        graph["controlParameters"] = {"class_type": "GetICLoRAParameters", "inputs": {"iclora_model": models[0]}}
        graph["controlFile"] = {"class_type": "LoadVideo", "inputs": {"file": control}}
        graph["controlFrames"] = {"class_type": "GetVideoComponents", "inputs": {"video": ["controlFile", 0]}}
    if sound:
        graph["trackFile"] = {"class_type": "LoadAudio", "inputs": {"audio": sound}}
        graph["trackLatent"] = {"class_type": "LTXVAudioVAEEncode", "inputs": {"audio": ["trackFile", 0], "audio_vae": ["audioVae", 0]}}
        graph["trackLocked"] = {"class_type": "ToonflowLockedAudio", "inputs": {"samples": ["trackLatent", 0]}}
    # The opening the segment is held to: the end of the segment before, or the pinned first frame, compressed as the
    # recipe does so it reads like a video frame.
    opening = None
    if context:
        graph["contextFile"] = {"class_type": "LoadVideo", "inputs": {"file": context}}
        graph["contextFrames"] = {"class_type": "GetVideoComponents", "inputs": {"video": ["contextFile", 0]}}
        opening = ["contextFrames", 0]
    elif firstFrame and segment == 1:
        graph["firstImage"] = {"class_type": "LoadImage", "inputs": {"image": firstFrame.name}}
        graph["first"] = {"class_type": "LTXVPreprocess", "inputs": {"image": ["firstImage", 0], "img_compression": 38}}
        opening = ["first", 0]
    closing = None
    if lastFrame and segment == segments:
        graph["lastImage"] = {"class_type": "LoadImage", "inputs": {"image": lastFrame.name}}
        graph["last"] = {"class_type": "LTXVPreprocess", "inputs": {"image": ["lastImage", 0], "img_compression": 38}}
        closing = ["last", 0]

    def sample(name, latent, model, sigmas, noiseSeed, openingStrength, audioLatent):
        # One pass: holds the opening in place, appends the closing frame and control guides, samples the joint picture
        # and sound latent and crops the guides off again.
        if opening:
            graph[f"{name}Opening"] = {"class_type": "LTXVImgToVideoInplace", "inputs": {"vae": ["vae", 0], "image": opening, "latent": latent, "strength": openingStrength, "bypass": False}}
            latent = [f"{name}Opening", 0]
        positive, negative = ["conditioning", 0], ["conditioning", 1]
        for guide, image, frameIndex in (("Closing", closing, -1), ("Control", ["controlFrames", 0] if control else None, 0)):
            if not image:
                continue
            graph[f"{name}{guide}"] = {"class_type": "LTXVAddGuide", "inputs": {
                "positive": positive, "negative": negative, "vae": ["vae", 0], "latent": latent, "image": image, "frame_idx": frameIndex, "strength": 1.0,
                **({"iclora_parameters": ["controlParameters", 0]} if guide == "Control" else {})}}
            positive, negative, latent = [f"{name}{guide}", 0], [f"{name}{guide}", 1], [f"{name}{guide}", 2]
        graph[f"{name}Joint"] = {"class_type": "LTXVConcatAVLatent", "inputs": {"video_latent": latent, "audio_latent": audioLatent}}
        joint = [f"{name}Joint", 0]
        if sound:
            graph[f"{name}Locked"] = {"class_type": "LTXVConcatAVLatent", "inputs": {"video_latent": joint, "audio_latent": ["trackLocked", 0]}}
            joint = [f"{name}Locked", 0]
        if sigmas is None:
            graph[f"{name}Sigmas"] = {"class_type": "LTXVScheduler", "inputs": {"steps": 8, "max_shift": 4.0, "base_shift": 1.5, "stretch": True, "terminal": 0.1, "latent": joint}}
        else:
            graph[f"{name}Sigmas"] = {"class_type": "ManualSigmas", "inputs": {"sigmas": sigmas}}
        graph.update({
            f"{name}Noise": {"class_type": "RandomNoise", "inputs": {"noise_seed": noiseSeed}},
            f"{name}Guider": {"class_type": "CFGGuider", "inputs": {"model": model, "positive": positive, "negative": negative, "cfg": 1.0}},
            f"{name}Sample": {"class_type": "SamplerCustomAdvanced", "inputs": {"noise": [f"{name}Noise", 0], "guider": [f"{name}Guider", 0], "sampler": ["sampler", 0], "sigmas": [f"{name}Sigmas", 0], "latent_image": joint}},
            f"{name}Split": {"class_type": "LTXVSeparateAVLatent", "inputs": {"av_latent": [f"{name}Sample", 0]}},
            f"{name}Crop": {"class_type": "LTXVCropGuides", "inputs": {"positive": positive, "negative": negative, "latent": [f"{name}Split", 0]}},
        })
        return [f"{name}Crop", 2], [f"{name}Split", 1]

    segmentSeed = seed + 1000 * (segment - 1)
    graph["firstLatent"] = {"class_type": "EmptyLTXVLatentVideo", "inputs": {"width": generateWidth // 2, "height": generateHeight // 2, "length": length, "batch_size": 1}}
    video, sound1 = sample("first", ["firstLatent", 0], models[0], None, segmentSeed, 0.8, ["audioTemplate", 0])
    graph["upscaled"] = {"class_type": "LTXVLatentUpsampler", "inputs": {"samples": video, "upscale_model": ["upscaler", 0], "vae": ["vae", 0]}}
    video, sound2 = sample("second", ["upscaled", 0], models[1], "0.85, 0.7250, 0.4219, 0.0", segmentSeed + 1, 1.0, sound1)
    graph.update({
        "decoded": {"class_type": "VAEDecodeTiled", "inputs": {"samples": video, "vae": ["vae", 0], "tile_size": 768, "overlap": 64, "temporal_size": 4096, "temporal_overlap": 4}},
        "decodedAudio": {"class_type": "LTXVAudioVAEDecode", "inputs": {"samples": sound2, "audio_vae": ["audioVae", 0]}},
        "video": {"class_type": "CreateVideo", "inputs": {"images": ["decoded", 0], "audio": ["decodedAudio", 0], "fps": 24}},
        "save": {"class_type": "SaveVideo", "inputs": {"video": ["video", 0], "filename_prefix": f"toonflow/sulphur_{job}_{segment}", **videoFormat}},
    })
    return graph


# Segments render one after another: each opens on the end of the one before.
rendered = []
context = None
for segment, prompt in enumerate(prompts, start=1):
    control, sound = window(segment)
    response = requests.post(base + "/prompt", json={"prompt": segmentGraph(segment, prompt, control, sound, context)}, timeout=60)
    if not response.ok:
        raise RuntimeError(response.text[-4000:])
    promptId = response.json()["prompt_id"]
    while True:
        history = requests.get(f"{base}/history/{promptId}", timeout=30).json().get(promptId)
        if history and history.get("status", {}).get("completed") is not None:
            break
        time.sleep(10)
    if history["status"].get("status_str") != "success":
        raise RuntimeError(str(history["status"].get("messages"))[-3000:] + "\n" + log.read_text()[-3000:])
    saved = sorted((comfy / "output" / "toonflow").glob(f"sulphur_{job}_{segment}_*.mp4"))
    # ComfyUI reports success for a graph whose save node it skipped, such as one with a loop in it.
    if not saved:
        raise RuntimeError(f"Segment {segment} saved no video: " + json.dumps(history.get("outputs", {}))[-2000:] + "\n" + log.read_text()[-3000:])
    rendered.append(saved[-1])
    if segment < segments:
        context = f"sulphurContext{job}_{segment}.mp4"
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", str(saved[-1]), "-vf", f"select='gte(n,{length - contextFrames})',setpts=N/24/TB",
                        "-frames:v", str(contextFrames), "-an", "-c:v", "libx264", "-crf", "10", "-pix_fmt", "yuv420p", str(comfy / "input" / context)], check=True)
    mark(f"segment{segment}")

outputs.mkdir(parents=True, exist_ok=True)
produced = rendered[0]
if segments > 1:
    # The segments join with the repeated opening of each later one cut off, picture and sound alike; the finish below
    # cuts the take to its duration.
    produced = Path(f"/content/sulphurJoined_{job}.mp4")
    cut = contextFrames / 24
    parts = [f"[{index}:v]{'' if not index else f'trim=start_frame={contextFrames},'}setpts=PTS-STARTPTS[v{index}];"
             f"[{index}:a]{'' if not index else f'atrim=start={cut:.4f},'}asetpts=PTS-STARTPTS[a{index}]" for index in range(segments)]
    joined = ";".join(parts) + ";" + "".join(f"[v{index}][a{index}]" for index in range(segments)) + f"concat=n={segments}:v=1:a=1[v][a]"
    subprocess.run(["ffmpeg", "-v", "error", "-y", *[argument for path in rendered for argument in ("-i", str(path))], "-filter_complex", joined,
                    "-map", "[v]", "-map", "[a]", "-c:v", "libx264", "-crf", "12", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k", str(produced)], check=True)
finish = f"scale={outputWidth}:{outputHeight}:force_original_aspect_ratio=increase:flags=lanczos,crop={outputWidth}:{outputHeight}"
# A locked soundtrack is muxed as the file it came in, not as the audio VAE's decode of it, which is not exact; silence
# pads it to the clip's length.
sound = ["-i", str(track), "-map", "0:v", "-map", "1:a", "-af", "apad"] if track and audio else []
subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", str(produced), *sound, "-t", str(duration), "-vf", finish,
                "-c:v", "libx264", "-crf", "16", "-preset", "slow", "-pix_fmt", "yuv420p",
                *(["-c:a", "aac", "-b:a", "192k"] if audio else ["-an"]),
                "-movflags", "+faststart", str(outputs / "final.mp4")], check=True)
mark("encode")
import hashlib
videoBytes = (outputs / "final.mp4").read_bytes()
timings["artifact"] = {"path": str(outputs / "final.mp4"), "bytes": len(videoBytes), "sha256": hashlib.sha256(videoBytes).hexdigest()}
(outputs / "timings.json").write_text(json.dumps(timings))
# The job's inputs and intermediate files are deleted so a long session does not fill the disk.
for leftover in [*inputs.glob(f"{prefix}*"), *(comfy / "input").glob(f"*{job}*"), *inputs.glob(f"sulphur*_{job}*"), *rendered]:
    leftover.unlink(missing_ok=True)
print("COLAB_DONE", resolution, f"{outputWidth}x{outputHeight}")
