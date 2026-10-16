# Qwen-Image 2.1 Turbo pipeline executed on a Colab GPU session by qwenImage.ts.
# Input: /content/qwin_job.json (a list of {prompt, ratio, size, seed, refs, control, init, denoise}) and the files it
# names; control is an optional depth map applied through the Qwen-Image 2.1 Fun ControlNet Union patch, and init an
# optional picture redrawn from the noise level denoise instead of drawing from pure noise.
# Output: /content/qwout/image_<n>.png for every item, followed by a COLAB_DONE line on success.
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

import torch

# Weights are public: download anonymously, without telemetry and without probing Colab secrets for an HF token.
os.environ.update(HF_HUB_DISABLE_TELEMETRY="1", HF_HUB_DISABLE_IMPLICIT_TOKEN="1", DO_NOT_TRACK="1")

inputs = Path("/content")
outputs = Path("/content/qwout")
comfy = Path("/content/ComfyUI")
# Pinned to the revisions this pipeline was verified with, the weights' repo too, so a changed upload upstream never
# reaches a render unnoticed.
comfyCommit = "7f7fd918ed0815c5d5ef2ccfe44bfc8e72cfd217"
weightRevision = "a8342359c61979b06a8dafb1a47991fe1f30e994"

items = json.loads((inputs / "qwin_job.json").read_text())
assert 1 <= len(items) <= 32


def dimensions(item):
    side = {"1K": 1024, "2K": 2048}[item["size"]]
    ratioWidth, ratioHeight = (int(part) for part in item["ratio"].split(":"))
    assert ratioWidth > 0 and ratioHeight > 0
    return side, round(math.sqrt(side * side * ratioWidth / ratioHeight) / 32) * 32, round(math.sqrt(side * side * ratioHeight / ratioWidth) / 32) * 32


# The checkpoint's own Turbo schedule (8 steps at CFG 1, scheduler shift 1.0, so the values are used as they are).
turboSigmas = "1.0, 0.978453, 0.95418, 0.926626, 0.89508, 0.845148, 0.704534, 0.414568, 0.0"
turboSteps = [float(value) for value in turboSigmas.split(",")]

print("GPU:", torch.cuda.get_device_name(0), round(torch.cuda.get_device_properties(0).total_memory / 2**30, 1), "GiB")

if not comfy.exists():
    subprocess.run(["git", "init", "-q", str(comfy)], check=True)
    subprocess.run(["git", "-C", str(comfy), "fetch", "-q", "--depth", "1", "https://github.com/Comfy-Org/ComfyUI.git", comfyCommit], check=True)
    subprocess.run(["git", "-C", str(comfy), "checkout", "-q", "FETCH_HEAD"], check=True)
    subprocess.run([sys.executable, "-m", "pip", "install", "-q", "-r", str(comfy / "requirements.txt"), "huggingface_hub", "hf_xet", "requests"], check=True)

import requests
from huggingface_hub import hf_hub_download

diffusion = "qwen_image_2.1_turbo_bf16.safetensors"
encoder = "qwen3vl_8b_bf16.safetensors"
vae = "qwen_image_2.1_vae_bf16.safetensors"
controlPatch = "qwen_image_2.1_fun_controlnet_union_int8_convrot.safetensors"
# ACT: The depth map steers every step at 0.7 strength: at full strength the result kept the proxy's plain shapes, and
# steering only the early steps lost the layout, because the Turbo schedule's first 5 of 8 steps only take sigma from
# 1.0 to 0.9 and the layout forms in the last 3. Tune per shot if needed.
controlStrength = 0.7
weights = [(f"diffusion_models/{diffusion}", "diffusion_models"), (f"text_encoders/{encoder}", "text_encoders"), (f"vae/{vae}", "vae")]
# The patch is only downloaded when a batch actually uses it.
if any(item.get("control") for item in items):
    weights.append((f"model_patches/{controlPatch}", "model_patches"))
for remote, folder in weights:
    target = comfy / "models" / folder / Path(remote).name
    if target.exists():
        continue
    downloaded = Path(hf_hub_download(repo_id="Comfy-Org/Qwen-Image-2.1", filename=remote, revision=weightRevision, local_dir="/content/hf"))
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.move(downloaded, target)

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
        "10": {"class_type": "ManualSigmas", "inputs": {"sigmas": turboSigmas}},
        "11": {"class_type": "SamplerCustomAdvanced", "inputs": {
            "noise": ["7", 0], "guider": ["8", 0], "sampler": ["9", 0], "sigmas": ["10", 0], "latent_image": ["6", 0]}},
        "12": {"class_type": "VAEDecode", "inputs": {"samples": ["11", 0], "vae": ["4", 0]}},
    }
    for index, name in enumerate(refs):
        graph[f"ref{index}"] = {"class_type": "LoadImage", "inputs": {"image": name}}
    # LoRAs sit between the model and its cache, so every sampler and the ControlNet patch see them.
    model = ["1", 0]
    for index, lora in enumerate(item.get("loras") or []):
        target = comfy / "models" / "loras" / lora["name"]
        if not target.exists():
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy(inputs / lora["name"], target)
        graph[f"lora{index}"] = {"class_type": "LoraLoaderModelOnly", "inputs": {"model": model, "lora_name": lora["name"], "strength_model": float(lora["strength"])}}
        model = [f"lora{index}", 0]
    graph["2"]["inputs"]["model"] = model
    if item.get("control"):
        # The depth map is scaled to the output canvas so the structure lines up with the latent.
        graph["ctrl"] = {"class_type": "LoadImage", "inputs": {"image": item["control"]}}
        graph["ctrlScaled"] = {"class_type": "ImageScale", "inputs": {"image": ["ctrl", 0], "upscale_method": "lanczos", "width": width, "height": height, "crop": "center"}}
        graph["30"] = {"class_type": "ModelPatchLoader", "inputs": {"name": controlPatch}}
        graph["31"] = {"class_type": "QwenImageDiffsynthControlnet", "inputs": {
            "model": ["2", 0], "model_patch": ["30", 0], "vae": ["4", 0], "image": ["ctrlScaled", 0],
            "strength": controlStrength, "start_percent": 0.0, "end_percent": 1.0}}
    if item.get("init"):
        # A redraw starts from the picture, scaled to the canvas like the depth map, noised to the Turbo step nearest to
        # denoise (never the final 0, so at least one step draws): it keeps the picture's composition and redraws as
        # much as that noise level allows.
        start = min(range(len(turboSteps) - 1), key=lambda index: abs(turboSteps[index] - float(item["denoise"])))
        graph["init"] = {"class_type": "LoadImage", "inputs": {"image": item["init"]}}
        graph["initScaled"] = {"class_type": "ImageScale", "inputs": {"image": ["init", 0], "upscale_method": "lanczos", "width": width, "height": height, "crop": "center"}}
        graph["initLatent"] = {"class_type": "VAEEncode", "inputs": {"pixels": ["initScaled", 0], "vae": ["4", 0]}}
        graph["11"]["inputs"]["latent_image"] = ["initLatent", 0]
        graph["10"]["inputs"]["sigmas"] = ", ".join(str(value) for value in turboSteps[start:])
    return graph


# Items are queued one by one instead of as one batch, so 2K images never need several at once in VRAM;
# ComfyUI keeps the loaded models cached between them.
outputs.mkdir(exist_ok=True)
for index, item in enumerate(items):
    graph = build(item)
    graph["13"] = {"class_type": "SaveImage", "inputs": {"images": ["12", 0], "filename_prefix": f"toonflow/qwen{index}"}}
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
    # The file this prompt saved, as ComfyUI reports it: a session that draws several batches keeps the earlier ones.
    saved = history["outputs"]["13"]["images"][0]
    shutil.copy(comfy / "output" / saved["subfolder"] / saved["filename"], outputs / f"image_{index}.png")
print("COLAB_DONE", len(items))
