# MiniMax H3 on a Colab GPU session, run by minimaxH3.ts through the ComfyUI templates MiniMax's README points to:
# Comfy-Org/workflow_templates video_minimax_h3_i2v.json (first frame) and video_minimax_h3_r2v.json (references), at
# revision e7cd011d. Each template is converted to a ComfyUI API prompt node for node, its subgraph flattened, and only
# the inputs it leaves to its user change: the images, the prompt, the seed, the duration, the size (16:9 or another
# aspect at 0.98 megapixels, the templates' "official 768p") and saving the video. Their samplers, step counts, the
# Lightning LoRA switch (off) and the official Comfy-Org weights stay as published.
# Inputs, named h3in_<H3_JOB>_*: prompt.txt, image_<n>.<ext> (one for i2v, 1-9 for r2v) and workflow.json, plus the
# H3_* environment variables. Output: /content/h3Out/<job>/final.mp4 and timings.json, then a COLAB_DONE line.
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
job = os.environ["H3_JOB"]
mode = os.environ["H3_MODE"]
assert mode in ("i2v", "r2v")
prefix = f"h3in_{job}_"
outputs = Path("/content/h3Out") / job
comfy = Path("/content/h3Runtime/ComfyUI")
# The templates record comfy-core 0.33.0; this later ComfyUI (0.39.0) carries every node they use and is the one the
# comfy dependency lock was verified with.
comfyCommit = "7f7fd918ed0815c5d5ef2ccfe44bfc8e72cfd217"
weightRevision = "e5eb578a89295337b8ff433a035929ce0279e0b6"
# The files each template names, which ComfyUI checks exist even on the switch branch left off.
weights = {
    "i2v": ["diffusion_models/minimax_h3_fl2va_pruned_int8_convrot.safetensors", "loras/minimax_h3_fl2v_turbo_8step_v1.0_comfyui_bf16.safetensors"],
    "r2v": ["diffusion_models/minimax_h3_ref2va_pruned_int8_convrot.safetensors", "loras/minimax_h3_ref2v_turbo_4step_v0.1_comfyui_bf16.safetensors"],
}[mode] + ["text_encoders/qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors", "vae/minimax_h3_video_vae_int8_convrot.safetensors", "vae/minimax_h3_audio_vae_fp32.safetensors"]
entries = [("Comfy-Org/MiniMax-H3", weightRevision, remote, str(comfy / "models" / remote)) for remote in weights]
port = 8211
base = f"http://127.0.0.1:{port}"

from modelPreparation import downloadWeights, installComfy, installationIdentity

if os.environ.get("TOONFLOW_PREFETCH_ONLY") == "1":
    downloadWeights(entries)
    print("COLAB_DONE")
    raise SystemExit(0)
installation = installationIdentity("comfy", comfyCommit)
if not (comfy / "toonflowReady").exists() or (comfy / "toonflowReady").read_text() != installation:
    installComfy(comfy, comfyCommit)
    (comfy / "toonflowReady").write_text(installation)
downloadWeights(entries)

if os.environ.get("TOONFLOW_DOWNLOAD_ONLY") == "1":
    print("COLAB_DONE")
    raise SystemExit(0)

import requests

log = Path("/content/h3Comfy.log")
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

# The machine is set up above this line.
mark("setup")
info = requests.get(base + "/object_info", timeout=60).json()
workflow = json.loads((inputs / f"{prefix}workflow.json").read_text())
images = sorted(inputs.glob(f"{prefix}image_*"), key=lambda path: int(path.stem.rsplit("_", 1)[1]))
(comfy / "input").mkdir(exist_ok=True)
for image in images:
    shutil.copy(image, comfy / "input" / image.name)
widgetTypes = {"INT", "FLOAT", "STRING", "BOOLEAN", "COMBO"}


def isWidget(spec):
    kind = spec[0]
    return isinstance(kind, list) or kind in widgetTypes


def widgetInputs(node, values):
    # Maps a UI node's widget values onto its inputs in ComfyUI's declared order; a seed's control-after-generate value
    # and LoadImage's upload button are UI state.
    if node["type"] == "SaveVideo":
        # Its format is a dynamic combo whose chosen option adds a nested codec widget.
        prefixValue, formatValue, codecValue = values
        return {"filename_prefix": prefixValue, "format": formatValue, "format.codec": codecValue}
    declared = info[node["type"]]["input"]
    result, values = {}, list(values or [])
    for name, spec in [*declared.get("required", {}).items(), *declared.get("optional", {}).items()]:
        if not values or not isWidget(spec):
            continue
        result[name] = values.pop(0)
        if len(spec) > 1 and isinstance(spec[1], dict) and spec[1].get("control_after_generate") and values and values[0] in ("fixed", "increment", "decrement", "randomize"):
            values.pop(0)
    if values and node["type"] != "LoadImage":
        raise RuntimeError(f"Template node {node['id']} {node['type']} left widget values {values}")
    return result


uiOnly = {"MarkdownNote", "Note"}
subgraphs = {graph["id"]: graph for graph in workflow.get("definitions", {}).get("subgraphs", [])}
prompt = {}


def flatten(nodes, links, scope, boundary):
    # Adds one graph level to the prompt. `boundary(slot)` resolves this level's subgraph input slot to a link source or
    # a constant; a subgraph instance node is expanded in place, its output slots resolved to their inner sources.
    byId = {node["id"]: node for node in nodes}
    # Each subgraph instance's output slots resolve to the inner nodes that feed them, known before any node is added.
    outputsOf = {}
    for node in nodes:
        if node["type"] in subgraphs:
            inner = subgraphs[node["type"]]
            innerLinks = {link["id"]: (link["origin_id"], link["origin_slot"]) for link in inner["links"]}
            nested = f"{scope}{node['id']}:"
            outputsOf[node["id"]] = lambda slot, inner=inner, innerLinks=innerLinks, nested=nested: {"link": [f"{nested}{innerLinks[inner['outputs'][slot]['linkIds'][0]][0]}", innerLinks[inner["outputs"][slot]["linkIds"][0]][1]]}

    def source(link):
        origin, slot = link
        if origin == -10:
            return boundary(slot)
        node = byId[origin]
        if node["type"] in subgraphs:
            return outputsOf[node["id"]](slot)
        return {"link": [f"{scope}{origin}", slot]}

    for node in nodes:
        if node["type"] in uiOnly:
            continue
        if node.get("mode", 0) != 0:
            raise RuntimeError(f"Template node {node['id']} is bypassed or muted")
        if node["type"] in subgraphs:
            inner = subgraphs[node["type"]]
            values = list(node.get("widgets_values") or [])
            resolved = {}
            for index, slot in enumerate(inner["inputs"]):
                wired = next((item for item in node.get("inputs", []) if item["name"] == slot["name"]), None)
                # Every widget-typed slot keeps a value in the instance's list, wired or not.
                value = {"value": values.pop(0)} if slot["type"] in widgetTypes else None
                resolved[index] = source(links[wired["link"]]) if wired and wired.get("link") is not None else value
            innerLinks = {link["id"]: (link["origin_id"], link["origin_slot"]) for link in inner["links"]}
            flatten(inner["nodes"], innerLinks, f"{scope}{node['id']}:", lambda slot, resolved=resolved: resolved[slot])
            continue
        nodeInputs = widgetInputs(node, node.get("widgets_values"))
        for item in node.get("inputs", []):
            if item.get("link") is None:
                continue
            value = source(links[item["link"]])
            if value is None:
                continue
            nodeInputs[item["name"]] = value["link"] if "link" in value else value["value"]
        prompt[f"{scope}{node['id']}"] = {"class_type": node["type"], "inputs": nodeInputs}


flatten(workflow["nodes"], {link[0]: (link[1], link[2]) for link in workflow["links"]}, "", lambda slot: None)


def setInput(nodeType, name, value, nodeId=None):
    matches = [key for key, node in prompt.items() if node["class_type"] == nodeType and (nodeId is None or key == nodeId)]
    if len(matches) != 1:
        raise RuntimeError(f"Expected one {nodeType} to set {name}, found {matches}")
    prompt[matches[0]]["inputs"][name] = value


text = (inputs / f"{prefix}prompt.txt").read_text()
seed, duration = int(os.environ["H3_SEED"]), float(os.environ["H3_DURATION"])
# The inputs the templates leave to their user.
# The Resolution Selector's choice for the requested ratio, by its leading "W:H".
aspects = [choice for choice in info["ResolutionSelector"]["input"]["required"]["aspect_ratio"][1]["options"] if choice.split(" ")[0] == os.environ["H3_RATIO"]]
if len(aspects) != 1:
    raise RuntimeError(f"The Resolution Selector offers no {os.environ['H3_RATIO']} aspect ratio")
setInput("ResolutionSelector", "aspect_ratio", aspects[0])
setInput("ResolutionSelector", "megapixels", 0.98)
setInput("SaveVideo", "filename_prefix", f"h3/{job}")
if mode == "i2v":
    if len(images) != 1:
        raise RuntimeError("The i2v template takes one first frame")
    setInput("LoadImage", "image", images[0].name)
    setInput("MiniMaxH3ImageToVideo", "prompt", text)
    setInput("RandomNoise", "noise_seed", seed)
    setInput("PrimitiveFloat", "value", duration)
else:
    if not 1 <= len(images) <= 9:
        raise RuntimeError("The r2v template takes 1 to 9 reference images")
    loaders = sorted(key for key, node in prompt.items() if node["class_type"] == "LoadImage")
    reference = next(key for key, node in prompt.items() if node["class_type"] == "MiniMaxH3ReferenceToVideo")
    # The template wires two image loaders as references 0 and 1; one loader per image replaces them, in order.
    for key in loaders:
        del prompt[key]
    for name in [name for name in prompt[reference]["inputs"] if name.startswith("ref_images.")]:
        del prompt[reference]["inputs"][name]
    for index, image in enumerate(images):
        prompt[f"toonflowImage{index}"] = {"class_type": "LoadImage", "inputs": {"image": image.name}}
        prompt[reference]["inputs"][f"ref_images.ref_image_{index}"] = [f"toonflowImage{index}", 0]
    setInput("PrimitiveStringMultiline", "value", text)
    setInput("RandomNoise", "noise_seed", seed)
    setInput("PrimitiveFloat", "value", duration)

# Nodes no output depends on, such as the i2v template's loose size helpers, are left out.
needed, pending = set(), [key for key, node in prompt.items() if node["class_type"] == "SaveVideo"]
while pending:
    key = pending.pop()
    if key in needed:
        continue
    needed.add(key)
    pending.extend(value[0] for value in prompt[key]["inputs"].values() if isinstance(value, list) and len(value) == 2 and isinstance(value[0], str) and value[0] in prompt)
prompt = {key: node for key, node in prompt.items() if key in needed}

response = requests.post(base + "/prompt", json={"prompt": prompt}, timeout=60)
if response.status_code != 200:
    raise RuntimeError("ComfyUI rejected the H3 template: " + response.text[:3000])
promptId = response.json()["prompt_id"]
while True:
    history = requests.get(f"{base}/history/{promptId}", timeout=30).json().get(promptId)
    if history and history.get("status", {}).get("completed") is not None:
        break
    time.sleep(5)
if history["status"].get("status_str") != "success":
    raise RuntimeError("H3 render failed: " + json.dumps(history["status"])[:3000] + "\n" + log.read_text()[-3000:])
mark("render")
saved = next(item for output in history["outputs"].values() for item in output.get("images", []) + output.get("videos", []) + output.get("gifs", []))
outputs.mkdir(parents=True, exist_ok=True)
final = outputs / "final.mp4"
shutil.copy(comfy / "output" / saved.get("subfolder", "") / saved["filename"], final)
data = final.read_bytes()
timings["recipe"] = {"template": f"Comfy-Org/workflow_templates e7cd011d video_minimax_h3_{mode}.json", "comfyCommit": comfyCommit, "weightRevision": weightRevision}
timings["artifact"] = {"path": str(final), "bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()}
(outputs / "timings.json").write_text(json.dumps(timings))
print("COLAB_DONE")
