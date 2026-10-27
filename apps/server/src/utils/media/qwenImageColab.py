# Qwen-Image 2.1 pipeline executed on a Colab GPU session by qwenImage.ts.
# Input: /content/qwin_job.json (a list of {prompt, ratio, size, seed, refs, control, init, denoise, recipe}) and the
# files it names; control is an optional depth map applied through the Qwen-Image 2.1 Fun ControlNet Union patch, and
# init an optional picture redrawn from the noise level denoise instead of drawing from pure noise. Every image is drawn
# by the base model (not Turbo); genitals come from the prompt's description, as LoRAs only keep trained characters.
# Output: /content/qwout/<QWEN_JOB>/image_<n>.png, atomically published as each image finishes.
# The model loads once and the items are drawn one by one, always at the requested ratio and size; references reach
# the model through the text encoder's conditioning, so the output canvas does not have to share their aspect.
import json
import math
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

# Weights are public: download anonymously, without telemetry and without probing Colab secrets for an HF token.
os.environ.update(HF_HUB_DISABLE_TELEMETRY="1", HF_HUB_DISABLE_IMPLICIT_TOKEN="1", DO_NOT_TRACK="1")

inputs = Path("/content")
job = os.environ["QWEN_JOB"]
assert len(job) == 36 and all(char in "0123456789abcdef-" for char in job)
outputs = Path("/content/qwout") / job
comfy = Path("/content/qwenImageRuntime/ComfyUI")
# Pinned to the revisions this pipeline was verified with, the weights' repo too, so a changed upload upstream never
# reaches a render unnoticed.
comfyCommit = "7f7fd918ed0815c5d5ef2ccfe44bfc8e72cfd217"
weightRevision = "a8342359c61979b06a8dafb1a47991fe1f30e994"

items = json.loads((inputs / "qwin_job.json").read_text())
assert 1 <= len(items) <= 32
if any(item.get("recipe") not in (None, "pose") for item in items):
    raise ValueError("This production uses the B3 image recipes only")


def dimensions(item):
    side = {"1K": 1024, "2K": 2048}[item["size"]]
    ratioWidth, ratioHeight = (int(part) for part in item["ratio"].split(":"))
    assert ratioWidth > 0 and ratioHeight > 0
    return side, round(math.sqrt(side * side * ratioWidth / ratioHeight) / 32) * 32, round(math.sqrt(side * side * ratioHeight / ratioWidth) / 32) * 32


# Qwen's recommended sampling for the base model: 40 steps without guidance (CFG 1); pose transfer keeps the 25 steps
# its recipe was verified with.
steps = 40
poseSteps = 25

diffusion = "qwen_image_2.1_bf16.safetensors"
encoder = "qwen3vl_8b_bf16.safetensors"
vae = "qwen_image_2.1_vae_bf16.safetensors"
controlPatch = "qwen_image_2.1_fun_controlnet_union_int8_convrot.safetensors"
# ACT: The depth map steers every step at 0.7 strength, a value tuned on the 8-step Turbo schedule: at full strength the
# result kept the proxy's plain shapes. It is not yet re-tuned for the 40-step base schedule; tune per shot if needed.
controlStrength = 0.7
weights = [(f"diffusion_models/{diffusion}", "diffusion_models"), (f"text_encoders/{encoder}", "text_encoders"), (f"vae/{vae}", "vae")]
# The patch is only downloaded when a batch actually uses it.
if any(item.get("control") for item in items):
    weights.append((f"model_patches/{controlPatch}", "model_patches"))
from modelPreparation import downloadWeights, installComfy, installationIdentity
# The pose LoRA comes from the recipes of the Apache-2.0 qwen21-nsfw-pose-skill (github.com/Arekejoker/qwen21-nsfw-pose-skill).
poseLora = "VNCCS_QI2_PoseStudioV1.1.safetensors"
entries = [("Comfy-Org/Qwen-Image-2.1", weightRevision, remote, str(comfy / "models" / folder / Path(remote).name)) for remote, folder in weights]
if any(item.get("recipe") == "pose" for item in items):
    entries.append(("MIUProject/VNCCS_PoseStudio_QI2.1", "9857b8a256655da446772a3f1f2b033e33181a6d", poseLora, str(comfy / "models/loras" / poseLora)))
if os.environ.get("TOONFLOW_PREFETCH_ONLY") == "1":
    downloadWeights(entries)
    print("COLAB_DONE")
    raise SystemExit(0)
installation = installationIdentity("comfy", comfyCommit)
if not (comfy / "toonflowReady").exists() or (comfy / "toonflowReady").read_text() != installation:
    installComfy(comfy, comfyCommit)
    (comfy / "toonflowReady").write_text(installation)
import torch
import requests
print("GPU:", torch.cuda.get_device_name(0), round(torch.cuda.get_device_properties(0).total_memory / 2**30, 1), "GiB")
downloadWeights(entries)

if os.environ.get("TOONFLOW_DOWNLOAD_ONLY") == "1":
    print("COLAB_DONE")
    raise SystemExit(0)

(comfy / "input").mkdir(exist_ok=True)
for item in items:
    for name in item["refs"] + ([item["control"]] if item.get("control") else []) + ([item["init"]] if item.get("init") else []):
        assert "/" not in name and name.startswith("qwin_")
        shutil.copy(inputs / name, comfy / "input" / name)

base = "http://127.0.0.1:8188"
log = Path("/content/comfyui.log")
try:
    requests.get(base + "/system_stats", timeout=2).raise_for_status()
except requests.RequestException:
    server = subprocess.Popen([sys.executable, "main.py", "--listen", "127.0.0.1", "--port", "8188", "--disable-auto-launch"],
                              cwd=comfy, stdout=open(log, "a"), stderr=subprocess.STDOUT)
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



def build(item):
    side, width, height = dimensions(item)
    refs = item["refs"]
    graph = {
        "1": {"class_type": "UNETLoader", "inputs": {"unet_name": diffusion, "weight_dtype": "default"}},
        "2": {"class_type": "QwenImage21Cache", "inputs": {"model": ["1", 0], "device": "auto", "dtype": "default"}},
        "3": {"class_type": "CLIPLoader", "inputs": {"clip_name": encoder, "type": "qwen_image", "device": "default"}},
        "4": {"class_type": "VAELoader", "inputs": {"vae_name": vae}},
        "5": {"class_type": "TextEncodeQwenImage21", "inputs": {
            "clip": ["3", 0], "vae": ["4", 0], "prompt": item["prompt"], "negative_prompt": "", "resolution": side,
            **{f"images.image_{index + 1}": [f"ref{index}", 0] for index in range(len(refs))}}},
        "6": {"class_type": "EmptyLatentImage", "inputs": {"width": width, "height": height, "batch_size": 1}},
        "7": {"class_type": "RandomNoise", "inputs": {"noise_seed": int(item["seed"])}},
        "8": {"class_type": "BasicGuider", "inputs": {"model": ["31", 0] if item.get("control") else ["2", 0], "conditioning": ["5", 0]}},
        "9": {"class_type": "KSamplerSelect", "inputs": {"sampler_name": "euler"}},
        # A redraw keeps the last `denoise` share of the schedule, so it starts from the picture noised to that level.
        "10": {"class_type": "BasicScheduler", "inputs": {"model": ["2", 0], "scheduler": "simple", "steps": poseSteps if item.get("recipe") == "pose" else steps, "denoise": float(item["denoise"]) if item.get("init") else 1.0}},
        "11": {"class_type": "SamplerCustomAdvanced", "inputs": {
            "noise": ["7", 0], "guider": ["8", 0], "sampler": ["9", 0], "sigmas": ["10", 0], "latent_image": ["6", 0]}},
        "12": {"class_type": "VAEDecode", "inputs": {"samples": ["11", 0], "vae": ["4", 0]}},
    }
    for index, name in enumerate(refs):
        graph[f"ref{index}"] = {"class_type": "LoadImage", "inputs": {"image": name}}
    # LoRAs sit between the model and its cache, so every sampler and the ControlNet patch see them.
    model = ["1", 0]
    if item.get("recipe") == "pose":
        graph["poseLora"] = {"class_type": "LoraLoaderModelOnly", "inputs": {"model": model, "lora_name": poseLora, "strength_model": 1.0}}
        model = ["poseLora", 0]
    for index, lora in enumerate(item.get("loras") or []):
        target = comfy / "models" / "loras" / lora["name"]
        if not target.exists():
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy(inputs / lora["name"], target)
        graph[f"lora{index}"] = {"class_type": "LoraLoaderModelOnly", "inputs": {"model": model, "lora_name": lora["name"], "strength_model": float(lora["strength"])}}
        model = [f"lora{index}", 0]
    graph["2"]["inputs"]["model"] = model
    if item.get("recipe") == "pose":
        # Pose transfer: <image 1> is the mannequin, <image 2> the person; the edit starts from the mannequin's latent,
        # 25 steps at CFG 1, euler/simple, as the skill's verified recipe.
        graph["11"]["inputs"]["latent_image"] = ["5", 2]
    if item.get("control"):
        # The depth map is scaled to the output canvas so the structure lines up with the latent.
        graph["ctrl"] = {"class_type": "LoadImage", "inputs": {"image": item["control"]}}
        graph["ctrlScaled"] = {"class_type": "ImageScale", "inputs": {"image": ["ctrl", 0], "upscale_method": "lanczos", "width": width, "height": height, "crop": "center"}}
        graph["30"] = {"class_type": "ModelPatchLoader", "inputs": {"name": controlPatch}}
        graph["31"] = {"class_type": "QwenImageDiffsynthControlnet", "inputs": {
            "model": ["2", 0], "model_patch": ["30", 0], "vae": ["4", 0], "image": ["ctrlScaled", 0],
            "strength": controlStrength, "start_percent": 0.0, "end_percent": 1.0}}
    if item.get("init"):
        # A redraw starts from the picture, scaled to the canvas like the depth map: it keeps the picture's composition
        # and redraws as much as the denoise level allows.
        graph["init"] = {"class_type": "LoadImage", "inputs": {"image": item["init"]}}
        graph["initScaled"] = {"class_type": "ImageScale", "inputs": {"image": ["init", 0], "upscale_method": "lanczos", "width": width, "height": height, "crop": "center"}}
        graph["initLatent"] = {"class_type": "VAEEncode", "inputs": {"pixels": ["initScaled", 0], "vae": ["4", 0]}}
        graph["11"]["inputs"]["latent_image"] = ["initLatent", 0]
    return graph


# Items are queued one by one instead of as one batch, so 2K images never need several at once in VRAM;
# ComfyUI keeps the loaded models cached between them.
shutil.rmtree(outputs.parent, ignore_errors=True)
outputs.mkdir(parents=True)
for index, item in enumerate(items):
    graph = build(item)
    graph["13"] = {"class_type": "SaveImage", "inputs": {"images": ["12", 0], "filename_prefix": f"toonflow/qwen{index}"}}
    logStart = log.stat().st_size if log.exists() else 0
    response = requests.post(base + "/prompt", json={"prompt": graph}, timeout=60)
    if not response.ok:
        raise RuntimeError(response.text[-4000:])
    promptId = response.json()["prompt_id"]
    while True:
        history = requests.get(f"{base}/history/{promptId}", timeout=30).json().get(promptId)
        if history and history.get("status", {}).get("completed") is not None:
            break
        time.sleep(2)
    if history["status"].get("status_str") != "success":
        raise RuntimeError(str(history["status"].get("messages"))[-3000:] + "\n" + log.read_text()[-3000:])
    # ComfyUI only warns when a LoRA's weights match no layer, which would draw without the forced LoRA unnoticed.
    with open(log, errors="replace") as source:
        source.seek(logStart)
        unloaded = [line for line in source if "lora key not loaded" in line]
    if unloaded:
        raise RuntimeError(f"{len(unloaded)} LoRA weights matched no model layer: {unloaded[0].strip()[:300]}")
    # The file this prompt saved, as ComfyUI reports it: a session that draws several batches keeps the earlier ones.
    saved = history["outputs"]["13"]["images"][0]
    staging = outputs / f"image_{index}.partial"
    shutil.copy(comfy / "output" / saved["subfolder"] / saved["filename"], staging)
    staging.replace(outputs / f"image_{index}.png")
print("COLAB_DONE", len(items))
