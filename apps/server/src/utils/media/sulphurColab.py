# Sulphur 2 (an LTX-2.3 22B fine-tune) pipeline executed on a Colab GPU session by sulphur.ts.
# Inputs, named sulin_<SULPHUR_JOB>_*: /content/sulin_<job>_prompt.txt (or prompts.json for a long take), optional
# first.* and last.* frames, an optional control.* structure video (depth, pose or edges) for the IC-LoRA Union Control,
# an optional audio.* soundtrack locked into the audio stream, optional loras.json with its LoRA files, and the
# SULPHUR_* environment variables.
# Output: /content/sulphurOut/<job>/final.mp4 and timings.json, followed by a COLAB_DONE line on success.
# Every render follows Sulphur's own distilled workflows (workflows/ltx23_t2v distilled.json and ltx23_i2v distilled.json
# in SulphurAI/Sulphur-2-base) node for node, except that the full Sulphur dev bf16 model replaces the LTX-2.3 dev fp8
# checkpoint and the Sulphur LoRA on it, which the model card offers as the alternative: it is the model the character
# LoRAs are trained on. SageAttention, eight steps at half size with the distill LoRA at 0.7, then the x2 latent
# upscaler 1.0 and three refining steps with the distill LoRA at 0.5, lcm without an opening and euler_ancestral_cfg_pp
# with one. A long take (more than
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
kjNode = comfy / "custom_nodes" / "ComfyUI-KJNodes"
# Pinned to the revisions this pipeline was written against, the weights' repos too, so a changed upload upstream never
# reaches a render unnoticed. The x2 upscaler 1.0 the workflows name was removed from Lightricks/LTX-2.3 on 2026-08-10, so
# it comes from the last revision that still had it.
comfyCommit = "7f7fd918ed0815c5d5ef2ccfe44bfc8e72cfd217"
# kijai/ComfyUI-KJNodes (GPL-3.0) for the workflows' SageAttention patch, fetched at run time with its requirements.
kjCommit = "eaa8fee753faf37d1539804d89a46d3e0f40963d"
kjRequirements = ["pillow>=10.3.0", "color-matcher", "matplotlib", "mss", "opencv-python-headless"]
sagePackage = "1.0.6"
weightRevisions = {
    "SulphurAI/Sulphur-2-base": "65587bbb38c700622f9434a16e732c8b280c115e",
    "Comfy-Org/ltx-2": "ccde4ba417d7900669fd56dd292a883cee11ff37",
    "Lightricks/LTX-2.3": "7caa482d5cd10a2eae6b34cb48f093ebc45a263e",
    "Lightricks/LTX-2.3-22b-IC-LoRA-Union-Control": "20a580c8606c06a0988d40375a61309e0fe5893d",
}
# The model card's "use the lora or use the full models": the full model, as loraColab.py trains on it.
checkpoint = "sulphur_dev_bf16.safetensors"
distill = "ltx-2.3-22b-distilled-lora-1.1_fro90_ceil72_condsafe.safetensors"
encoder = "gemma_3_12B_it_fp4_mixed.safetensors"
upscaler = "ltx-2.3-spatial-upscaler-x2-1.0.safetensors"
controlLora = "ltx-2.3-22b-ic-lora-union-control-ref0.5.safetensors"
negativePrompt = "pc game, console game, video game, cartoon, childish, ugly"
weights = [
    ("SulphurAI/Sulphur-2-base", checkpoint, "checkpoints"),
    ("SulphurAI/Sulphur-2-base", f"distill_loras/{distill}", "loras"),
    ("Comfy-Org/ltx-2", f"split_files/text_encoders/{encoder}", "text_encoders"),
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
# The distilled workflows, or the base text-to-video one (workflows/ltx23_t2v base.json): fifty euler_ancestral steps
# at CFG 3.6 without the distill LoRA at half size, then five lcm refining steps with the distill LoRA at 0.5.
workflow = os.environ.get("SULPHUR_WORKFLOW", "distilled")
assert workflow in ("distilled", "base")
baseWorkflow = workflow == "base"
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
# The workflows sample the first pass at half the requested size, which the latent floors to its 32-pixel grid. With a
# control video, which they have no part for, the full size is a multiple of 128 instead, so the IC-LoRA's half-size
# guide lands on that pass's grid. ffmpeg scales and crops the result to the exact output size.
controlled = any(inputs.glob(f"{prefix}control.*"))
generateWidth, generateHeight = (ceil128(outputWidth), ceil128(outputHeight)) if controlled else (outputWidth, outputHeight)


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
    installedSage = version("sageattention")
except PackageNotFoundError:
    installedSage = None
if installedSage != sagePackage:
    installPackages(sys.executable, "comfy", [f"sageattention=={sagePackage}", *kjRequirements])
fetch(kjNode, "https://github.com/kijai/ComfyUI-KJNodes.git", kjCommit)
import torch
import requests
print("GPU:", torch.cuda.get_device_name(0), round(torch.cuda.get_device_properties(0).total_memory / 2**30, 1), "GiB")
print(f"plan: {resolution} {outputWidth}x{outputHeight}, sample {generateWidth}x{generateHeight}, {segments} x {length} frames")
# A dubbed track is locked into the audio stream: its latent is held with a zero noise mask, so the model draws the
# picture, mouths included, to that exact sound.
toonflowNodes = """
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


# The image-to-video workflow's ImageScaleDownBy, from comfyui-art-venture (MIT, sipherxyz, 210dc072): a centre crop to
# the target aspect, then a LANCZOS resize of each image to its size times scale_by.
class ImageScaleDownBy:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"images": ("IMAGE",), "scale_by": ("FLOAT", {"default": 0.5, "min": 0.01, "max": 1.0, "step": 0.01})}}

    RETURN_TYPES = ("IMAGE",)
    FUNCTION = "scale"
    CATEGORY = "toonflow"

    def scale(self, images, scale_by):
        import numpy
        from PIL import Image
        width, height = int(images.shape[2] * scale_by), int(images.shape[1] * scale_by)
        oldWidth, oldHeight = images.shape[2], images.shape[1]
        oldAspect, newAspect = oldWidth / oldHeight, width / height
        x = y = 0
        if oldAspect > newAspect:
            x = round((oldWidth - oldWidth * (newAspect / oldAspect)) / 2)
        elif oldAspect < newAspect:
            y = round((oldHeight - oldHeight * (oldAspect / newAspect)) / 2)
        results = []
        for image in images[:, y:oldHeight - y, x:oldWidth - x, :]:
            picture = Image.fromarray(numpy.clip(255.0 * image.cpu().numpy(), 0, 255).astype(numpy.uint8)).convert("RGB")
            picture = picture.resize((width, height), Image.Resampling.LANCZOS)
            results.append(torch.from_numpy(numpy.array(picture).astype(numpy.float32) / 255.0).unsqueeze(0))
        return (torch.cat(results, dim=0),)


NODE_CLASS_MAPPINGS = {"ToonflowLockedAudio": ToonflowLockedAudio, "ImageScaleDownBy": ImageScaleDownBy}
"""
nodeFile = comfy / "custom_nodes" / "toonflow_sulphur.py"
# A ComfyUI started before these nodes changed has not registered them, so it is stopped here and started again below.
if not nodeFile.exists() or nodeFile.read_text() != toonflowNodes:
    nodeFile.write_text(toonflowNodes)
    subprocess.run(["pkill", "-f", "main.py --listen 127.0.0.1 --port 8188"], check=False)
    time.sleep(3)

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
missing = [name for name in ["PathchSageAttentionKJ", "ToonflowLockedAudio", "ImageScaleDownBy", "GetICLoRAParameters", "LTXAVTextEncoderLoader"] if name not in info]
if missing:
    raise RuntimeError(f"ComfyUI did not register {', '.join(missing)}:\n" + log.read_text()[-3000:])
timings["recipe"] = {"model": "sulphur2Official", "comfyCommit": comfyCommit, "kjCommit": kjCommit, "weightRevisions": weightRevisions,
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

# LoRAs ride on the checkpoint before each pass's distill LoRA, at their strength. Each is named by its content and stays on the
# machine, so the session's later clips use it without another upload.
characterLoras = json.loads((inputs / f"{prefix}loras.json").read_text()) if (inputs / f"{prefix}loras.json").exists() else []
for entry in characterLoras:
    assert "/" not in entry["name"] and entry["name"].startswith("sulphurLora_")
    target = comfy / "models" / "loras" / entry["name"]
    if not target.exists():
        shutil.copy(inputs / entry["name"], target)
videoFormat = {"format": "mp4", "format.codec": "h264", "format.codec.encoding": "re-encode", "format.codec.encoding.crf": 16}


def segmentGraph(segment, prompt, control, sound, context):
    # The render of one segment (numbered from 1); the first is the whole clip of a single render.
    graph = {
        "checkpoint": {"class_type": "CheckpointLoaderSimple", "inputs": {"ckpt_name": checkpoint}},
        "sage": {"class_type": "PathchSageAttentionKJ", "inputs": {"model": ["checkpoint", 0], "sage_attention": "auto", "allow_compile": False}},
        "clip": {"class_type": "LTXAVTextEncoderLoader", "inputs": {"text_encoder": encoder, "ckpt_name": checkpoint, "device": "default"}},
        "audioVae": {"class_type": "LTXVAudioVAELoader", "inputs": {"ckpt_name": checkpoint}},
        "upscaler": {"class_type": "LatentUpscaleModelLoader", "inputs": {"model_name": upscaler}},
        "positive": {"class_type": "CLIPTextEncode", "inputs": {"clip": ["clip", 0], "text": prompt}},
        "negative": {"class_type": "CLIPTextEncode", "inputs": {"clip": ["clip", 0], "text": negativePrompt}},
        "conditioning": {"class_type": "LTXVConditioning", "inputs": {"positive": ["positive", 0], "negative": ["negative", 0], "frame_rate": 24.0}},
        "audioTemplate": {"class_type": "LTXVEmptyLatentAudio", "inputs": {"frames_number": length, "frame_rate": 24, "batch_size": 1, "audio_vae": ["audioVae", 0]}},
        "sampler": {"class_type": "KSamplerSelect", "inputs": {"sampler_name": "euler_ancestral" if baseWorkflow else "euler_ancestral_cfg_pp"}},
    }
    model = ["sage", 0]
    for index, entry in enumerate(characterLoras):
        graph[f"lora{index}"] = {"class_type": "LoraLoaderModelOnly", "inputs": {"model": model, "lora_name": entry["name"], "strength_model": float(entry["strength"])}}
        model = [f"lora{index}", 0]
    # The first pass takes the distill LoRA at 0.7, the second at 0.5.
    graph.update({
        "distillFirst": {"class_type": "LoraLoaderModelOnly", "inputs": {"model": model, "lora_name": distill, "strength_model": 0.7}},
        "distillSecond": {"class_type": "LoraLoaderModelOnly", "inputs": {"model": model, "lora_name": distill, "strength_model": 0.5}},
    })
    models = [model if baseWorkflow else ["distillFirst", 0], ["distillSecond", 0]]
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

    def sample(name, latent, model, sigmas, sampler, noiseSeed, openingImage, openingStrength, audioLatent, cfg=1.0):
        # One pass: holds the opening in place, appends the closing frame and control guides, samples the joint picture
        # and sound latent and crops the guides off again.
        if opening:
            graph[f"{name}Opening"] = {"class_type": "LTXVImgToVideoInplace", "inputs": {"vae": ["checkpoint", 2], "image": openingImage, "latent": latent, "strength": openingStrength, "bypass": False}}
            latent = [f"{name}Opening", 0]
        positive, negative = ["conditioning", 0], ["conditioning", 1]
        for guide, image, frameIndex in (("Closing", closing, -1), ("Control", ["controlFrames", 0] if control else None, 0)):
            if not image:
                continue
            graph[f"{name}{guide}"] = {"class_type": "LTXVAddGuide", "inputs": {
                "positive": positive, "negative": negative, "vae": ["checkpoint", 2], "latent": latent, "image": image, "frame_idx": frameIndex, "strength": 1.0,
                **({"iclora_parameters": ["controlParameters", 0]} if guide == "Control" else {})}}
            positive, negative, latent = [f"{name}{guide}", 0], [f"{name}{guide}", 1], [f"{name}{guide}", 2]
        graph[f"{name}Joint"] = {"class_type": "LTXVConcatAVLatent", "inputs": {"video_latent": latent, "audio_latent": audioLatent}}
        joint = [f"{name}Joint", 0]
        if sound:
            graph[f"{name}Locked"] = {"class_type": "LTXVConcatAVLatent", "inputs": {"video_latent": joint, "audio_latent": ["trackLocked", 0]}}
            joint = [f"{name}Locked", 0]
        if sigmas is None:
            schedule = {"steps": 50, "max_shift": 2.72, "base_shift": 0.8, "stretch": True, "terminal": 0.0} if baseWorkflow else {"steps": 8, "max_shift": 4.0, "base_shift": 1.5, "stretch": True, "terminal": 0.1}
            graph[f"{name}Sigmas"] = {"class_type": "LTXVScheduler", "inputs": {**schedule, "latent": joint}}
        else:
            graph[f"{name}Sigmas"] = {"class_type": "ManualSigmas", "inputs": {"sigmas": sigmas}}
        graph.update({
            f"{name}Noise": {"class_type": "RandomNoise", "inputs": {"noise_seed": noiseSeed}},
            f"{name}Guider": {"class_type": "CFGGuider", "inputs": {"model": model, "positive": positive, "negative": negative, "cfg": cfg}},
            f"{name}Sample": {"class_type": "SamplerCustomAdvanced", "inputs": {"noise": [f"{name}Noise", 0], "guider": [f"{name}Guider", 0], "sampler": [sampler, 0], "sigmas": [f"{name}Sigmas", 0], "latent_image": joint}},
            f"{name}Split": {"class_type": "LTXVSeparateAVLatent", "inputs": {"av_latent": [f"{name}Sample", 0]}},
            f"{name}Crop": {"class_type": "LTXVCropGuides", "inputs": {"positive": positive, "negative": negative, "latent": [f"{name}Split", 0]}},
        })
        return [f"{name}Crop", 2], [f"{name}Split", 1]

    segmentSeed = seed + 1000 * (segment - 1)
    # The image-to-video workflow holds the half-size pass to the opening scaled down by half and refines with
    # euler_ancestral_cfg_pp; the text-to-video one refines with lcm. Both refine with the noise seed fixed at 42.
    if opening and baseWorkflow:
        raise RuntimeError("The base workflow renders text to video only; use the distilled workflow with an opening frame")
    if opening:
        graph["openingHalf"] = {"class_type": "ImageScaleDownBy", "inputs": {"images": opening, "scale_by": 0.5}}
    graph["refineSampler"] = {"class_type": "KSamplerSelect", "inputs": {"sampler_name": "euler_ancestral_cfg_pp" if opening else "lcm"}}
    graph["firstLatent"] = {"class_type": "EmptyLTXVLatentVideo", "inputs": {"width": generateWidth // 2, "height": generateHeight // 2, "length": length, "batch_size": 1}}
    video, sound1 = sample("first", ["firstLatent", 0], models[0], None, "sampler", segmentSeed, ["openingHalf", 0] if opening else None, 0.8, ["audioTemplate", 0], 3.6 if baseWorkflow else 1.0)
    graph["upscaled"] = {"class_type": "LTXVLatentUpsampler", "inputs": {"samples": video, "upscale_model": ["upscaler", 0], "vae": ["checkpoint", 2]}}
    video, sound2 = sample("second", ["upscaled", 0], models[1], "0.85, 0.7933, 0.68, 0.51, 0.2833, 0.0" if baseWorkflow else "0.85, 0.7250, 0.4219, 0.0", "refineSampler", 42, opening, 1.0, sound1)
    graph.update({
        "decoded": {"class_type": "VAEDecodeTiled", "inputs": {"samples": video, "vae": ["checkpoint", 2], "tile_size": 768, "overlap": 64, "temporal_size": 4096, "temporal_overlap": 4}} if baseWorkflow
        else {"class_type": "VAEDecode", "inputs": {"samples": video, "vae": ["checkpoint", 2]}},
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
