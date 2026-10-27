# LUSTIFY v10 (Krea 2) still images on a Colab GPU session, run by lustify.ts through Comfy-Org's official Krea 2 Turbo
# template (image_krea2_turbo_t2i: Euler, Beta, 8 steps, CFG 1, prompt enhancer and style LoRA off), converted to an API
# prompt in lustifyPrompt.json with LUSTIFY v10 as its diffusion model. The switched-off branches are left out, since
# ComfyUI validates the files they name; the prompt reaches the text encoder and the model reaches the sampler as the
# off switches route them.
# Character lock: the frame is drawn first without LoRAs, the heads are found with YuNet and numbered left to right, and
# the same prompt and seed are drawn again with each character LoRA confined to its head box by the Krea2 regional
# multi-LoRA node (CliffNodes, commit a33a0e4), so bodies, poses and anatomy stay as LUSTIFY drew them.
# Inputs, named lustifyin_<LUSTIFY_JOB>_*: prompt.txt, template.json and loras.json ([{name}] left to right, the files
# uploaded by name), an optional init.png to redraw with an optional mask.png, plus the LUSTIFY_* environment variables.
# Output: /content/lustifyOut/<job>/final.png and
# timings.json, then a COLAB_DONE line.
import hashlib
import json
import os
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
job = os.environ["LUSTIFY_JOB"]
prefix = f"lustifyin_{job}_"
outputs = Path("/content/lustifyOut") / job
comfy = Path("/content/lustifyRuntime/ComfyUI")
comfyCommit = "7f7fd918ed0815c5d5ef2ccfe44bfc8e72cfd217"
regionalCommit = "a33a0e487fbaaa6b64a19ad6e26e707695723b75"
krea = ("Comfy-Org/Krea-2", "1171f4dc7e325bf3734586942e737872506c73e1")
entries = [
    ("dukintt/lustify-v10-krea-turbo-bf16", "57d530aa696b2e81cf8d021264b6205dcbd20e68", "lustifyNSFWCheckpoint_v10Krea2.safetensors", str(comfy / "models/diffusion_models/lustifyNSFWCheckpoint_v10Krea2.safetensors")),
    (*krea, "text_encoders/qwen3vl_4b_fp8_scaled.safetensors", str(comfy / "models/text_encoders/qwen3vl_4b_fp8_scaled.safetensors")),
    (*krea, "vae/qwen_image_vae.safetensors", str(comfy / "models/vae/qwen_image_vae.safetensors")),
    ("opencv/face_detection_yunet", "3cc26e7f1014a5ee5d74a42acee58bafc9d0a310", "face_detection_yunet_2023mar.onnx", str(comfy.parent / "yunet/face_detection_yunet_2023mar.onnx")),
]
# Civitai's published LUSTIFY v10 (Krea 2) bf16 file; the Hugging Face mirror must be byte-identical to it.
lustifyDigest = "04571b6cf9b9c8a3868ed3695c94de48d8206a37670ea36c6a043e86dda327d3"
port = 8215
base = f"http://127.0.0.1:{port}"
boxesNode = '''# Turns a JSON list of pixel boxes into the BOUNDING_BOX value the Krea2 regional multi-LoRA node reads.
import json


class ToonflowBoxes:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"boxes_json": ("STRING", {"multiline": True, "default": "[]"})}}

    RETURN_TYPES = ("BOUNDING_BOX",)
    FUNCTION = "build"
    CATEGORY = "Toonflow"

    def build(self, boxes_json):
        return ([{key: float(box[key]) for key in ("x", "y", "width", "height")} for box in json.loads(boxes_json)],)


NODE_CLASS_MAPPINGS = {"ToonflowBoxes": ToonflowBoxes}
'''

from modelPreparation import downloadWeights, installComfy, installationIdentity

installation = installationIdentity("comfy", comfyCommit) + ":" + regionalCommit
if not (comfy / "toonflowReady").exists() or (comfy / "toonflowReady").read_text() != installation:
    installComfy(comfy, comfyCommit)
    regional = comfy / "custom_nodes/krea2Regional"
    if not regional.exists():
        subprocess.run(["git", "init", "-q", str(regional)], check=True)
        subprocess.run(["git", "-C", str(regional), "fetch", "-q", "--depth", "1", "https://github.com/CliffNodes/Krea2-Multi-Character-Lora-Node-with-bounding-box-Scene-and-Outfit-Edit.git", regionalCommit], check=True)
        subprocess.run(["git", "-C", str(regional), "checkout", "-q", "FETCH_HEAD"], check=True)
    (comfy / "custom_nodes/toonflowBoxes").mkdir(parents=True, exist_ok=True)
    (comfy / "custom_nodes/toonflowBoxes/__init__.py").write_text(boxesNode)
    (comfy / "toonflowReady").write_text(installation)
downloadWeights(entries)
lustify = Path(entries[0][3])
checked = lustify.with_suffix(".sha256")
if not checked.exists() or checked.read_text() != lustifyDigest:
    digest = hashlib.sha256()
    with lustify.open("rb") as file:
        for block in iter(lambda: file.read(1 << 24), b""):
            digest.update(block)
    if digest.hexdigest() != lustifyDigest:
        raise RuntimeError(f"LUSTIFY v10 sha256 {digest.hexdigest()} differs from Civitai's {lustifyDigest}")
    checked.write_text(lustifyDigest)

if os.environ.get("TOONFLOW_DOWNLOAD_ONLY") == "1":
    print("COLAB_DONE")
    raise SystemExit(0)

import cv2
import numpy as np
import requests

loras = json.loads((inputs / f"{prefix}loras.json").read_text())
(comfy / "models/loras").mkdir(parents=True, exist_ok=True)
for lora in loras:
    target = comfy / "models/loras" / lora["name"]
    if not target.exists():
        (inputs / lora["name"]).replace(target)

log = Path("/content/lustifyComfy.log")
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

template = json.loads((inputs / f"{prefix}template.json").read_text())
text = (inputs / f"{prefix}prompt.txt").read_text()
seed, width, height = int(os.environ["LUSTIFY_SEED"]), int(os.environ["LUSTIFY_WIDTH"]), int(os.environ["LUSTIFY_HEIGHT"])
strength, headScale = float(os.environ["LUSTIFY_STRENGTH"]), float(os.environ["LUSTIFY_HEAD_SCALE"])
denoise = float(os.environ.get("LUSTIFY_DENOISE", "1"))


def promptFor(name, regionalBoxes=None, redraw=None):
    used = {"29", "30:3", "30:5", "30:6", "30:8", "30:10", "30:11", "30:12", "30:13"}
    prompt = {key: json.loads(json.dumps(node)) for key, node in template.items() if key in used}
    prompt["30:6"]["inputs"]["text"] = text
    prompt["30:5"]["inputs"].update(width=width, height=height)
    prompt["30:3"]["inputs"]["seed"] = seed
    prompt["30:3"]["inputs"]["model"] = ["30:10", 0]
    prompt["29"]["inputs"]["filename_prefix"] = f"lustify_{job}_{name}"
    if redraw:
        # The picture is encoded and only the white of the mask is sampled again, at the requested denoise.
        prompt["80"] = {"class_type": "LoadImage", "inputs": {"image": redraw[0]}}
        prompt["81"] = {"class_type": "VAEEncode", "inputs": {"pixels": ["80", 0], "vae": ["30:12", 0]}}
        prompt["82"] = {"class_type": "LoadImageMask", "inputs": {"image": redraw[1], "channel": "red"}}
        prompt["83"] = {"class_type": "SetLatentNoiseMask", "inputs": {"samples": ["81", 0], "mask": ["82", 0]}}
        prompt["30:3"]["inputs"].update(latent_image=["83", 0], denoise=denoise)
        del prompt["30:5"]
    if regionalBoxes:
        regions = [{"lora": lora["name"], "strength": strength, "enable": True} for lora in loras[:len(regionalBoxes)]]
        prompt["90"] = {"class_type": "ToonflowBoxes", "inputs": {"boxes_json": json.dumps(regionalBoxes)}}
        prompt["91"] = {"class_type": "Krea2RegionalMultiLoRA", "inputs": {"model": ["30:10", 0], "clip": ["30:11", 0], "canvas_width": width, "canvas_height": height, "regions_json": json.dumps(regions), "split_mode": "bbox", "seam_feather": 0.08, "blend_override": 0.0, "bboxes": ["90", 0]}}
        prompt["30:3"]["inputs"]["model"] = ["91", 0]
    return prompt


def render(name, prompt):
    reply = requests.post(base + "/prompt", json={"prompt": prompt}, timeout=60).json()
    if reply.get("node_errors") or "prompt_id" not in reply:
        raise RuntimeError("LUSTIFY prompt rejected: " + json.dumps(reply)[:3000])
    while True:
        history = requests.get(f"{base}/history/{reply['prompt_id']}", timeout=30).json().get(reply["prompt_id"])
        if history and history.get("status", {}).get("completed") is not None:
            break
        time.sleep(1)
    if history["status"].get("status_str") != "success":
        raise RuntimeError("LUSTIFY render failed: " + json.dumps(history["status"])[:3000] + "\n" + log.read_text()[-3000:])
    saved = next(item for output in history["outputs"].values() for item in output.get("images", []))
    mark(name)
    return comfy / "output" / saved.get("subfolder", "") / saved["filename"]


def headBoxes(path):
    image = cv2.imread(str(path))
    detector = cv2.FaceDetectorYN.create(entries[3][3], "", (image.shape[1], image.shape[0]), 0.6)
    _, found = detector.detect(image)
    faces = sorted([face[:4] for face in (found if found is not None else []) if face[14] >= 0.7], key=lambda face: face[0])
    boxes = []
    for x, y, faceWidth, faceHeight in faces:
        # A square over the face, raised a little, wide enough for hair and ears.
        side = max(faceWidth, faceHeight) * headScale
        left, top = max(x + faceWidth / 2 - side / 2, 0), max(y + faceHeight / 2 - faceHeight * 0.15 - side / 2, 0)
        boxes.append({"x": round(float(left)), "y": round(float(top)), "width": round(float(min(side, width - left))), "height": round(float(min(side, height - top)))})
    return boxes


outputs.mkdir(parents=True, exist_ok=True)
init = inputs / f"{prefix}init.png"
if init.exists():
    # A picture to redraw: fitted to the frame, its heads found, and redrawn only where the mask is white (the given
    # mask, or else the head boxes), the edges feathered so the redrawn part blends into the kept one.
    picture = cv2.resize(cv2.imread(str(init)), (width, height), interpolation=cv2.INTER_AREA)
    pictureName, maskName = f"lustify_{job}_init.png", f"lustify_{job}_mask.png"
    cv2.imwrite(str(comfy / "input" / pictureName), picture)
    boxes = headBoxes(comfy / "input" / pictureName) if loras else []
    given = inputs / f"{prefix}mask.png"
    if given.exists():
        mask = cv2.resize(cv2.imread(str(given), cv2.IMREAD_GRAYSCALE), (width, height), interpolation=cv2.INTER_AREA)
    else:
        mask = np.zeros((height, width), np.uint8)
        for box in boxes:
            cv2.rectangle(mask, (box["x"], box["y"]), (box["x"] + box["width"], box["y"] + box["height"]), 255, -1)
    if not mask.any():
        raise RuntimeError("Nothing to redraw: the mask is empty and no locked head was found in the picture")
    feather = max(width, height) // 40 * 2 + 1
    cv2.imwrite(str(comfy / "input" / maskName), cv2.cvtColor(cv2.GaussianBlur(mask, (feather, feather), 0), cv2.COLOR_GRAY2BGR))
    timings["heads"] = len(boxes)
    final = render("redrawn", promptFor("redrawn", boxes, (pictureName, maskName)))
else:
    final = render("base", promptFor("base"))
    boxes = headBoxes(final) if loras else []
    timings["heads"] = len(boxes)
    if boxes:
        final = render("locked", promptFor("locked", boxes))
data = final.read_bytes()
(outputs / "final.png").write_bytes(data)
timings["artifact"] = {"path": str(outputs / "final.png"), "bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()}
(outputs / "timings.json").write_text(json.dumps(timings))
print("COLAB_DONE")
