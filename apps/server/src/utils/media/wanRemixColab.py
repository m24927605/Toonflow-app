# Wan 2.2 Remix V3 (FX-FeiHou/wan2.2-Remix, NSFW I2V fp8 v3.0) image to video on a Colab GPU session, run by wanRemix.ts
# as the model author's I2V workflow sets it up: the Remix high and low noise experts with lightning and NSFW LoRAs
# merged in, the recommended NSFW UMT5 text encoder, the Wan 2.1 VAE, 8 Euler steps split 4/4 between the experts at
# CFG 1 and shift 8, and the Wan template's negative prompt, at 16 fps. The API prompt is wanRemixPrompt.json. The
# author's FastUnsharpSharpen pass and VHS output are left out: the clips the user approved on 2026-10-28 were rendered
# without them. With WANREMIX_REVEAL=1 TenStrip's Reveal Penis LoRA pair loads on both experts at 1.0; with an end
# frame WanFirstLastFrameToVideo pins both frames.
# A clip longer than one 81-frame render chains renders with Stable Video Infinity 2.0 Pro (vita-epfl, MIT): its LoRA
# pair at 1.0 on both experts, and KJNodes' WanImageToVideoSVIPro conditioning every render on the start image's latent
# and the last latent of the render before, each with its own seed; a later render's first five frames repeat the one
# before and are dropped, as the official SVI Pro pipeline does. The user approved its 720p test on 2026-10-28.
# Inputs, named wanremixin_<WANREMIX_JOB>_*: prompt.txt, template.json, first.<ext> and an optional last.<ext>, plus the
# WANREMIX_* environment variables.
# Output: /content/wanRemixOut/<job>/final.mp4 and timings.json, then a COLAB_DONE line.
import hashlib
import json
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

jobStarted = time.time()
timings = {}


def mark(phase):
    timings[phase] = round(time.time() - jobStarted, 1)


os.environ.update(HF_HUB_DISABLE_TELEMETRY="1", HF_HUB_DISABLE_IMPLICIT_TOKEN="1", DO_NOT_TRACK="1")

inputs = Path("/content")
job = os.environ["WANREMIX_JOB"]
prefix = f"wanremixin_{job}_"
outputs = Path("/content/wanRemixOut") / job
comfy = Path("/content/wanRemixRuntime/ComfyUI")
# The ComfyUI commit and dependency lock LUSTIFY already installs; its core Wan nodes run a single render.
comfyCommit = "7f7fd918ed0815c5d5ef2ccfe44bfc8e72cfd217"
# KJNodes, for WanImageToVideoSVIPro; the commit the SVI test ran on.
kjCommit = "2371136d2fa6fd0914e514cd99b36dabe5db9adf"
weights = [
    ("FX-FeiHou/wan2.2-Remix", "4369125a0f1157c6b8768df18b7e81bacd5fdc1f", "NSFW/Wan2.2_Remix_NSFW_i2v_14b_high_lighting_fp8_e4m3fn_v3.0.safetensors", "diffusion_models/Wan2.2_Remix_NSFW_i2v_14b_high_lighting_fp8_e4m3fn_v3.0.safetensors"),
    ("FX-FeiHou/wan2.2-Remix", "4369125a0f1157c6b8768df18b7e81bacd5fdc1f", "NSFW/Wan2.2_Remix_NSFW_i2v_14b_low_lighting_fp8_e4m3fn_v3.0.safetensors", "diffusion_models/Wan2.2_Remix_NSFW_i2v_14b_low_lighting_fp8_e4m3fn_v3.0.safetensors"),
    ("NSFW-API/NSFW-Wan-UMT5-XXL", "9202c70dd998d183f3dd58276d06689eeab9a174", "nsfw_wan_umt5-xxl_fp8_scaled.safetensors", "text_encoders/nsfw_wan_umt5-xxl_fp8_scaled.safetensors"),
    ("Comfy-Org/Wan-2.2", "ee6f4a40737a995bf5818954cfce6d59443b0f04", "split_files/vae/wan_2.1_vae.safetensors", "vae/wan_2.1_vae.safetensors"),
    ("TenStrip/Wan2.2-I2V_Reveal_Penis", "882361d291d7e454fb8f70e28db027dd2f1e1b32", "2.2-I2V Reveal Penis_000003000_high_noise.safetensors", "loras/revealPenisHigh.safetensors"),
    ("TenStrip/Wan2.2-I2V_Reveal_Penis", "882361d291d7e454fb8f70e28db027dd2f1e1b32", "2.2-I2V Reveal Penis_000003000_low_noise.safetensors", "loras/revealPenisLow.safetensors"),
    ("Kijai/WanVideo_comfy", "8260d429d19fd7a72304cad059160b95d843913f", "LoRAs/Stable-Video-Infinity/v2.0/SVI_v2_PRO_Wan2.2-I2V-A14B_HIGH_lora_rank_128_fp16.safetensors", "loras/sviProHigh.safetensors"),
    ("Kijai/WanVideo_comfy", "8260d429d19fd7a72304cad059160b95d843913f", "LoRAs/Stable-Video-Infinity/v2.0/SVI_v2_PRO_Wan2.2-I2V-A14B_LOW_lora_rank_128_fp16.safetensors", "loras/sviProLow.safetensors"),
]
entries = [(repo, revision, file, str(comfy / "models" / target)) for repo, revision, file, target in weights]
port = 8231
base = f"http://127.0.0.1:{port}"

from modelPreparation import downloadWeights, installComfy, installPackages, installationIdentity

installation = installationIdentity("comfy", comfyCommit) + ":" + kjCommit
if not (comfy / "toonflowReady").exists() or (comfy / "toonflowReady").read_text() != installation:
    installComfy(comfy, comfyCommit)
    kj = comfy / "custom_nodes/ComfyUI-KJNodes"
    if not (kj / ".git/HEAD").exists() or (kj / ".git/HEAD").read_text().strip() != kjCommit:
        subprocess.run(["git", "init", "-q", str(kj)], check=True)
        subprocess.run(["git", "-C", str(kj), "fetch", "-q", "--depth", "1", "https://github.com/kijai/ComfyUI-KJNodes.git", kjCommit], check=True)
        subprocess.run(["git", "-C", str(kj), "checkout", "-q", "FETCH_HEAD"], check=True)
    installPackages(sys.executable, "comfy", ["-r", str(kj / "requirements.txt")])
    (comfy / "toonflowReady").write_text(installation)
downloadWeights(entries)

if os.environ.get("TOONFLOW_DOWNLOAD_ONLY") == "1":
    print("COLAB_DONE")
    raise SystemExit(0)

import requests

log = Path("/content/wanRemixComfy.log")
try:
    requests.get(base + "/system_stats", timeout=2).raise_for_status()
except requests.RequestException:
    server = subprocess.Popen([sys.executable, "main.py", "--listen", "127.0.0.1", "--port", str(port), "--disable-auto-launch"], cwd=comfy, stdout=open(log, "a"), stderr=subprocess.STDOUT)
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
mark("setup")

prompt = json.loads((inputs / f"{prefix}template.json").read_text())
(comfy / "input").mkdir(exist_ok=True)
first = next(inputs.glob(f"{prefix}first.*"))
last = next(inputs.glob(f"{prefix}last.*"), None)
for picture in [first] + ([last] if last else []):
    shutil.copy(picture, comfy / "input" / picture.name)
width, height, frames, seed = (int(os.environ[name]) for name in ("WANREMIX_WIDTH", "WANREMIX_HEIGHT", "WANREMIX_FRAMES", "WANREMIX_SEED"))
renderFrames, repeated = 81, 5
prompt["11"]["inputs"]["text"] = (inputs / f"{prefix}prompt.txt").read_text()
prompt["13"]["inputs"]["image"] = first.name
prompt["14"]["inputs"].update(width=width, height=height, length=frames)
prompt["15"]["inputs"]["noise_seed"] = seed
prompt["19"]["inputs"]["filename_prefix"] = f"wanRemix/{job}"
high, low = ["1", 0], ["2", 0]
if os.environ.get("WANREMIX_REVEAL") == "1":
    prompt["5"] = {"class_type": "LoraLoaderModelOnly", "inputs": {"model": high, "lora_name": "revealPenisHigh.safetensors", "strength_model": 1.0}}
    prompt["6"] = {"class_type": "LoraLoaderModelOnly", "inputs": {"model": low, "lora_name": "revealPenisLow.safetensors", "strength_model": 1.0}}
    high, low = ["5", 0], ["6", 0]
if last:
    prompt["20"] = {"class_type": "LoadImage", "inputs": {"image": last.name}}
    prompt["14"]["class_type"] = "WanFirstLastFrameToVideo"
    prompt["14"]["inputs"]["end_image"] = ["20", 0]
if frames > renderFrames:
    if last:
        raise RuntimeError("An end frame pins one render; a clip longer than one render cannot take it")
    prompt["21"] = {"class_type": "LoraLoaderModelOnly", "inputs": {"model": high, "lora_name": "sviProHigh.safetensors", "strength_model": 1.0}}
    prompt["22"] = {"class_type": "LoraLoaderModelOnly", "inputs": {"model": low, "lora_name": "sviProLow.safetensors", "strength_model": 1.0}}
    high, low = ["21", 0], ["22", 0]
    prompt["23"] = {"class_type": "ImageScale", "inputs": {"image": ["13", 0], "upscale_method": "lanczos", "width": width, "height": height, "crop": "center"}}
    prompt["24"] = {"class_type": "VAEEncode", "inputs": {"pixels": ["23", 0], "vae": ["4", 0]}}
    for node in ("14", "15", "16", "17"):
        del prompt[node]
    renders = 1 + -(-(frames - renderFrames) // (renderFrames - repeated))
    joined = None
    for k in range(renders):
        cond = {"positive": ["11", 0], "negative": ["12", 0], "length": renderFrames, "anchor_samples": ["24", 0], "motion_latent_count": 1 if k else 0}
        if k:
            cond["prev_samples"] = [f"low{k - 1}", 0]
        prompt[f"cond{k}"] = {"class_type": "WanImageToVideoSVIPro", "inputs": cond}
        sampler = {"steps": 8, "cfg": 1.0, "sampler_name": "euler", "scheduler": "simple", "positive": [f"cond{k}", 0], "negative": [f"cond{k}", 1]}
        prompt[f"high{k}"] = {"class_type": "KSamplerAdvanced", "inputs": {**sampler, "model": ["9", 0], "add_noise": "enable", "noise_seed": seed + k, "latent_image": [f"cond{k}", 2], "start_at_step": 0, "end_at_step": 4, "return_with_leftover_noise": "enable"}}
        prompt[f"low{k}"] = {"class_type": "KSamplerAdvanced", "inputs": {**sampler, "model": ["10", 0], "add_noise": "disable", "noise_seed": 0, "latent_image": [f"high{k}", 0], "start_at_step": 4, "end_at_step": 10000, "return_with_leftover_noise": "disable"}}
        prompt[f"decode{k}"] = {"class_type": "VAEDecode", "inputs": {"samples": [f"low{k}", 0], "vae": ["4", 0]}}
        piece = [f"decode{k}", 0]
        if k:
            prompt[f"new{k}"] = {"class_type": "ImageFromBatch", "inputs": {"image": piece, "batch_index": repeated, "length": renderFrames - repeated}}
            prompt[f"joined{k}"] = {"class_type": "ImageBatch", "inputs": {"image1": joined, "image2": [f"new{k}", 0]}}
            piece = [f"joined{k}", 0]
        joined = piece
    prompt["25"] = {"class_type": "ImageFromBatch", "inputs": {"image": joined, "batch_index": 0, "length": frames}}
    prompt["18"]["inputs"]["images"] = ["25", 0]
prompt["9"]["inputs"]["model"] = high
prompt["10"]["inputs"]["model"] = low

reply = requests.post(base + "/prompt", json={"prompt": prompt}, timeout=60).json()
if reply.get("node_errors") or "prompt_id" not in reply:
    raise RuntimeError("Wan Remix prompt rejected: " + json.dumps(reply)[:3000])
while True:
    history = requests.get(f"{base}/history/{reply['prompt_id']}", timeout=30).json().get(reply["prompt_id"])
    if history and history.get("status", {}).get("completed") is not None:
        break
    time.sleep(5)
if history["status"].get("status_str") != "success":
    raise RuntimeError("Wan Remix render failed: " + json.dumps(history["status"])[:3000] + "\n" + log.read_text()[-3000:])
mark("render")
rendered = sorted((comfy / "output/wanRemix").glob(f"{job}*.mp4"))
if not rendered:
    raise RuntimeError("Wan Remix saved no video")
outputs.mkdir(parents=True, exist_ok=True)
final = outputs / "final.mp4"
shutil.copy(rendered[-1], final)
data = final.read_bytes()
timings["artifact"] = {"path": str(final), "bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()}
(outputs / "timings.json").write_text(json.dumps(timings))
print("COLAB_DONE")
