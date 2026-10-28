# Wan 2.2 Remix V3 (FX-FeiHou/wan2.2-Remix, NSFW I2V fp8 v3.0) image to video on a Colab GPU session, run by wanRemix.ts
# as the model author's I2V workflow sets it up: the Remix high and low noise experts with lightning and NSFW LoRAs
# merged in, the recommended NSFW UMT5 text encoder, the Wan 2.1 VAE, 8 Euler steps split 4/4 between the experts at
# CFG 1 and shift 8, and the Wan template's negative prompt, at 16 fps. The API prompt is wanRemixPrompt.json. The
# author's FastUnsharpSharpen pass and VHS output are left out: the clips the user approved on 2026-10-28 were rendered
# without them. With WANREMIX_REVEAL=1 TenStrip's Reveal Penis LoRA pair loads on both experts at 1.0; with an end
# frame WanFirstLastFrameToVideo pins both frames.
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
# The ComfyUI commit and dependency lock LUSTIFY already installs; its core Wan nodes run the whole graph.
comfyCommit = "7f7fd918ed0815c5d5ef2ccfe44bfc8e72cfd217"
weights = [
    ("FX-FeiHou/wan2.2-Remix", "4369125a0f1157c6b8768df18b7e81bacd5fdc1f", "NSFW/Wan2.2_Remix_NSFW_i2v_14b_high_lighting_fp8_e4m3fn_v3.0.safetensors", "diffusion_models/Wan2.2_Remix_NSFW_i2v_14b_high_lighting_fp8_e4m3fn_v3.0.safetensors"),
    ("FX-FeiHou/wan2.2-Remix", "4369125a0f1157c6b8768df18b7e81bacd5fdc1f", "NSFW/Wan2.2_Remix_NSFW_i2v_14b_low_lighting_fp8_e4m3fn_v3.0.safetensors", "diffusion_models/Wan2.2_Remix_NSFW_i2v_14b_low_lighting_fp8_e4m3fn_v3.0.safetensors"),
    ("NSFW-API/NSFW-Wan-UMT5-XXL", "9202c70dd998d183f3dd58276d06689eeab9a174", "nsfw_wan_umt5-xxl_fp8_scaled.safetensors", "text_encoders/nsfw_wan_umt5-xxl_fp8_scaled.safetensors"),
    ("Comfy-Org/Wan-2.2", "ee6f4a40737a995bf5818954cfce6d59443b0f04", "split_files/vae/wan_2.1_vae.safetensors", "vae/wan_2.1_vae.safetensors"),
    ("TenStrip/Wan2.2-I2V_Reveal_Penis", "882361d291d7e454fb8f70e28db027dd2f1e1b32", "2.2-I2V Reveal Penis_000003000_high_noise.safetensors", "loras/revealPenisHigh.safetensors"),
    ("TenStrip/Wan2.2-I2V_Reveal_Penis", "882361d291d7e454fb8f70e28db027dd2f1e1b32", "2.2-I2V Reveal Penis_000003000_low_noise.safetensors", "loras/revealPenisLow.safetensors"),
]
entries = [(repo, revision, file, str(comfy / "models" / target)) for repo, revision, file, target in weights]
port = 8231
base = f"http://127.0.0.1:{port}"

from modelPreparation import downloadWeights, installComfy, installationIdentity

installation = installationIdentity("comfy", comfyCommit)
if not (comfy / "toonflowReady").exists() or (comfy / "toonflowReady").read_text() != installation:
    installComfy(comfy, comfyCommit)
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
prompt["11"]["inputs"]["text"] = (inputs / f"{prefix}prompt.txt").read_text()
prompt["13"]["inputs"]["image"] = first.name
prompt["14"]["inputs"].update(width=int(os.environ["WANREMIX_WIDTH"]), height=int(os.environ["WANREMIX_HEIGHT"]), length=int(os.environ["WANREMIX_FRAMES"]))
prompt["15"]["inputs"]["noise_seed"] = int(os.environ["WANREMIX_SEED"])
prompt["19"]["inputs"]["filename_prefix"] = f"wanRemix/{job}"
if os.environ.get("WANREMIX_REVEAL") == "1":
    prompt["5"] = {"class_type": "LoraLoaderModelOnly", "inputs": {"model": ["1", 0], "lora_name": "revealPenisHigh.safetensors", "strength_model": 1.0}}
    prompt["6"] = {"class_type": "LoraLoaderModelOnly", "inputs": {"model": ["2", 0], "lora_name": "revealPenisLow.safetensors", "strength_model": 1.0}}
    prompt["9"]["inputs"]["model"] = ["5", 0]
    prompt["10"]["inputs"]["model"] = ["6", 0]
if last:
    prompt["20"] = {"class_type": "LoadImage", "inputs": {"image": last.name}}
    prompt["14"]["class_type"] = "WanFirstLastFrameToVideo"
    prompt["14"]["inputs"]["end_image"] = ["20", 0]

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
