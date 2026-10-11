# MiniMax H3 Ref2VA pipeline executed on a Colab GPU session by minimaxH3.ts.
# Inputs: /content/h3in_prompt.txt, /content/h3in_ref_* and the H3_* environment variables.
# Output: /content/h3out/final.mp4, followed by a COLAB_DONE line on success.
# 480p samples just above the target size; 720p samples at the model's native ~768p and downscales;
# 1080p upscales the 768p video latent with the LBH 3D latent upscaler and resamples it.
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
ratioWidth, ratioHeight = (int(part) for part in os.environ["H3_RATIO"].split(":"))
shortSides = {"480p": 480, "720p": 720, "1080p": 1080}
assert resolution in shortSides and 4 <= duration <= 15 and ratioWidth > 0 and ratioHeight > 0


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
print("Ref2VA variant:", variant)

weights = [
    ("Comfy-Org/MiniMax-H3", f"diffusion_models/{diffusion}", "diffusion_models"),
    ("Comfy-Org/MiniMax-H3", f"loras/{lora}", "loras"),
    ("Comfy-Org/MiniMax-H3", "text_encoders/qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors", "text_encoders"),
    ("Comfy-Org/MiniMax-H3", f"vae/{videoVae}", "vae"),
    ("Comfy-Org/MiniMax-H3", "vae/minimax_h3_audio_vae_fp32.safetensors", "vae"),
]
if refine:
    weights.append(("LBH-123-AI/Minimax_h3_latent_Upscaler", f"minimax_h3_latent_upscaler_3d_conv_v1/{upscaler}", "latent_upscale_models"))
for repo, remote, folder in weights:
    target = comfy / "models" / folder / Path(remote).name
    if target.exists():
        continue
    downloaded = Path(hf_hub_download(repo_id=repo, filename=remote, local_dir="/content/hf"))
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.move(downloaded, target)

refs = sorted(inputs.glob("h3in_ref_*"))
(comfy / "input").mkdir(exist_ok=True)
for ref in refs:
    shutil.copy(ref, comfy / "input" / ref.name)
prompt = (inputs / "h3in_prompt.txt").read_text()

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
        **{f"ref_images.ref_image_{index}": [f"ref{index}", 0] for index in range(len(refs))}}},
    "8": {"class_type": "BasicGuider", "inputs": {"model": ["2", 0], "conditioning": ["7", 0]}},
    "9": {"class_type": "RandomNoise", "inputs": {"noise_seed": seed}},
    "10": {"class_type": "KSamplerSelect", "inputs": {"sampler_name": "euler"}},
    "11": {"class_type": "BasicScheduler", "inputs": {"model": ["2", 0], "scheduler": "beta", "steps": 4, "denoise": 1.0}},
    "12": {"class_type": "SamplerCustomAdvanced", "inputs": {"noise": ["9", 0], "guider": ["8", 0], "sampler": ["10", 0], "sigmas": ["11", 0], "latent_image": ["7", 1]}},
    "14": {"class_type": "VAEDecodeAudio", "inputs": {"samples": ["12", 0], "vae": ["5", 0]}},
}
for index, ref in enumerate(refs):
    graph[f"ref{index}"] = {"class_type": "LoadImage", "inputs": {"image": ref.name}}
videoLatent = ["12", 0]
if refine:
    # Second-pass schedule from the LBH r2v example; the soundtrack stays from the first pass.
    graph.update({
        "20": {"class_type": "LTXVSeparateAVLatent", "inputs": {"av_latent": ["12", 0]}},
        "21": {"class_type": "MinimaxH3LatentUpscaler3D", "inputs": {
            "latent": ["20", 0], "model_name": upscaler, "mode": "target dimensions", "mode.width": upscaleWidth, "mode.height": upscaleHeight,
            "align": 32, "enable_temporal_chunking": True, "force_unload": True, "device": "cuda", "precision": "fp16"}},
        "22": {"class_type": "LTXVConcatAVLatent", "inputs": {"video_latent": ["21", 0], "audio_latent": ["20", 1]}},
        "23": {"class_type": "MiniMaxH3SigmaShift", "inputs": {"model": ["2", 0], "shift_video": 12.0, "shift_audio": 3.0}},
        "24": {"class_type": "BasicGuider", "inputs": {"model": ["23", 0], "conditioning": ["7", 0]}},
        "25": {"class_type": "ManualSigmas", "inputs": {"sigmas": "0.9035, 0.6316, 0.3158, 0.0000"}},
        "26": {"class_type": "SamplerCustomAdvanced", "inputs": {"noise": ["9", 0], "guider": ["24", 0], "sampler": ["10", 0], "sigmas": ["25", 0], "latent_image": ["22", 0]}},
    })
    videoLatent = ["26", 0]
graph.update({
    "13": {"class_type": "VAEDecode", "inputs": {"samples": videoLatent, "vae": ["4", 0]}},
    "15": {"class_type": "CreateVideo", "inputs": {"images": ["13", 0], "audio": ["14", 0], "fps": 24}},
    "16": {"class_type": "SaveVideo", "inputs": {"video": ["15", 0], "filename_prefix": "toonflow/h3", **videoFormat}},
})

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
print("COLAB_DONE", resolution, f"{outputWidth}x{outputHeight}")
