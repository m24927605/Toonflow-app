# TenStrip's 10Eros "Basic I2V DMD V5" workflow (TenStrip/LTX2.3-10Eros_Workflows, 10Eros_10SNodes_I2V_Basic_DMD_V5.json)
# executed on a Colab GPU session by erosV5.ts, node for node: the workflow file is converted to a ComfyUI API prompt and
# only the inputs it leaves to its user change, namely the start image, the positive prompt, the seed, the width,
# height and length sliders and saving the final video. Its negative prompt, models, samplers, sigmas and the crf 24
# output stay as shipped. The one addition, made at the user's request so a character keeps their Drama 3 voice, is a
# locked soundtrack: a dubbed track is encoded with the workflow's own audio VAE nodes and held by a zero noise mask
# from its own SolidMask in both passes, and the clip keeps the original file.
# Inputs, named erosin_<EROS_JOB>_*: prompt.txt, first.<ext>, an optional audio.<ext> soundtrack and the workflow file,
# plus the EROS_* environment variables.
# Output: /content/erosOut/<job>/final.mp4 and timings.json, followed by a COLAB_DONE line on success.
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
job = os.environ["EROS_JOB"]
prefix = f"erosin_{job}_"
outputs = Path("/content/erosOut") / job
runtime = Path("/content/erosV5Runtime")
comfy = runtime / "ComfyUI"
# The versions the workflow file records: ComfyUI v0.26.0, the newest comfy-core version its nodes carry, and each node
# pack at its recorded commit, or at the release current when V5 was published (2026-07-04) where the record is stale.
comfyCommit = "f6c162ddcfbd7eefb39c06fe5b8d4c46e8d09f40"
nodePacks = [
    ("https://github.com/kijai/ComfyUI-KJNodes.git", "a9ab19d2a7933e03f72bc00103863f06b9483300"),
    # The workflow names 10S nodes from 2dc56f53, which lacks its LTXReference nodes; v1.9.2 is the release of its day.
    ("https://github.com/TenStrip/10S-Comfy-nodes.git", "c412da5207357b293c98c7de3122d1107d5d10be"),
    ("https://github.com/rgthree/rgthree-comfy.git", "738105af5fb14e96fbecaf406dc356e284797e8c"),
    ("https://github.com/Kosinkadink/ComfyUI-VideoHelperSuite.git", "3234937ff5f3ca19068aaba5042771514de2429d"),
    ("https://github.com/Smirnov75/ComfyUI-mxToolkit.git", "7f7a0e584f12078a1c589645d866ae96bad0cc35"),
    ("https://github.com/evanspearman/ComfyMath.git", "c01177221c31b8e5fbc062778fc8254aeb541638"),
    ("https://github.com/gseth/ControlAltAI-Nodes.git", "721492b66c9cede8ae23ae10615462ad80cfd061"),
]
weightRevisions = {
    "TenStrip/LTX2.3-10Eros": "84a05a13610d78dbe4340d1be23fd8185e10f697",
    "TenStrip/LTX2.3_DMD_Lora": "77203c27a1d4022dab97d4f5a2280656b228fc2a",
    "Lightricks/LTX-2.3": "7caa482d5cd10a2eae6b34cb48f093ebc45a263e",
}
weights = [
    ("TenStrip/LTX2.3-10Eros", "10Eros_v1.3_fp8mixed_learned.safetensors", "checkpoints"),
    ("TenStrip/LTX2.3-10Eros", "text_encoders/gemma-3-12b-it-ablit-norms-biproj-fp8mixed.safetensors", "text_encoders"),
    ("TenStrip/LTX2.3_DMD_Lora", "LTX2.3_DMD_reshaped_r256.safetensors", "loras"),
    ("Lightricks/LTX-2.3", "ltx-2.3-spatial-upscaler-x2-1.1.safetensors", "latent_upscale_models"),
]
entries = [(repo, weightRevisions[repo], remote, str(comfy / "models" / folder / Path(remote).name)) for repo, remote, folder in weights]
port = 8199
base = f"http://127.0.0.1:{port}"


def fetch(directory, url, commit):
    head = directory / ".git/HEAD"
    if head.exists() and head.read_text().strip() == commit:
        return
    subprocess.run(["git", "init", "-q", str(directory)], check=True)
    subprocess.run(["git", "-C", str(directory), "fetch", "-q", "--depth", "1", url, commit], check=True)
    subprocess.run(["git", "-C", str(directory), "checkout", "-q", "FETCH_HEAD"], check=True)


from modelPreparation import downloadWeights, installPackages, installationIdentity

if os.environ.get("TOONFLOW_PREFETCH_ONLY") == "1":
    downloadWeights(entries)
    print("COLAB_DONE")
    raise SystemExit(0)
# The packages are the ones the workflow was verified with on 2026-10-26, locked as the erosV5 family.
installation = installationIdentity("erosV5", json.dumps([comfyCommit, nodePacks]))
ready = runtime / "toonflowReady"
if not ready.exists() or ready.read_text() != installation:
    runtime.mkdir(exist_ok=True)
    fetch(comfy, "https://github.com/Comfy-Org/ComfyUI.git", comfyCommit)
    requirements = [comfy / "requirements.txt"]
    for url, commit in nodePacks:
        directory = comfy / "custom_nodes" / url.rsplit("/", 1)[1].removesuffix(".git")
        fetch(directory, url, commit)
        requirements.append(directory / "requirements.txt")
    installPackages(sys.executable, "erosV5", [argument for path in requirements if path.exists() for argument in ("-r", str(path))])
    ready.write_text(installation)
downloadWeights(entries)

if os.environ.get("TOONFLOW_DOWNLOAD_ONLY") == "1":
    print("COLAB_DONE")
    raise SystemExit(0)

import requests

log = Path("/content/erosV5Comfy.log")
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

# The machine is set up above this line; warmErosV5 runs only that part, ahead of the first clip.
mark("setup")
workflow = json.loads((inputs / f"{prefix}workflow.json").read_text())
first = next(inputs.glob(f"{prefix}first.*"))
track = next(inputs.glob(f"{prefix}audio.*"), None)
(comfy / "input").mkdir(exist_ok=True)
shutil.copy(first, comfy / "input" / first.name)

# The UI workflow becomes an API prompt: SetNode/GetNode pairs (KJNodes, frontend only) resolve to their source, the note
# and preview nodes drop out, and widget values map onto each node's widget inputs in order.
nodes = {node["id"]: node for node in workflow["nodes"]}
links = {link[0]: link for link in workflow["links"]}
setters = {node["widgets_values"][0]: node for node in nodes.values() if node["type"] == "SetNode"}
controlValues = {"fixed", "increment", "decrement", "randomize"}


def source(linkId):
    _, fromId, slot = links[linkId][:3]
    origin = nodes[fromId]
    if origin["type"] == "GetNode":
        return source(setters[origin["widgets_values"][0]]["inputs"][0]["link"])
    if origin["type"] == "SetNode":
        return source(origin["inputs"][0]["link"])
    return [str(fromId), slot]


prompt = {}
for node in nodes.values():
    if node["type"] in {"MarkdownNote", "SetNode", "GetNode", "PreviewImage"}:
        continue
    if node.get("mode", 0) != 0:
        raise RuntimeError(f"Workflow node {node['id']} is bypassed or muted")
    values = node.get("widgets_values")
    nodeInputs = {}
    if node["type"] == "Seed (rgthree)":
        nodeInputs["seed"] = values[0]
    elif node["type"] == "Power Lora Loader (rgthree)":
        for index, slot in enumerate([value for value in values if isinstance(value, dict) and "lora" in value], 1):
            nodeInputs[f"lora_{index}"] = slot
    elif isinstance(values, dict):
        nodeInputs.update({key: value for key, value in values.items() if key != "videopreview"})
    else:
        values = list(values or [])
        for item in node.get("inputs", []):
            if not item.get("widget"):
                continue
            nodeInputs[item["name"]] = values.pop(0)
            # A seed widget is followed by its control-after-generate value, which is UI state.
            if values and isinstance(values[0], str) and values[0] in controlValues and "seed" in item["name"]:
                values.pop(0)
        if values and node["type"] != "LoadImage":
            raise RuntimeError(f"Workflow node {node['id']} {node['type']} left widget values {values}")
    for item in node.get("inputs", []):
        if item.get("link") is not None:
            nodeInputs[item["name"]] = source(item["link"])
    prompt[str(node["id"])] = {"class_type": node["type"], "inputs": nodeInputs}

width, height, frames = int(os.environ["EROS_WIDTH"]), int(os.environ["EROS_HEIGHT"]), int(os.environ["EROS_FRAMES"])
# The inputs the workflow leaves to its user: Load Image, the positive prompt, the seed, Video Width, Video Height,
# Length (frames; the workflow adds one), and the final Video Combine saving its output under this job.
for nodeId, changes in {
    "837": {"image": first.name},
    "536": {"text": (inputs / f"{prefix}prompt.txt").read_text()},
    "524": {"seed": int(os.environ["EROS_SEED"])},
    "791": {"Xi": width, "Xf": width},
    "792": {"Xi": height, "Xf": height},
    "796": {"Xi": frames, "Xf": frames},
    "597": {"save_output": True, "filename_prefix": f"erosV5/{job}"},
}.items():
    prompt[nodeId]["inputs"].update(changes)

if track:
    # The soundtrack, padded with silence to the clip's frames plus the one the workflow adds, at 48 kHz stereo.
    sound = comfy / "input" / f"erosTrack_{job}.wav"
    seconds = (frames + 1) / 24
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", str(track), "-af", f"apad=whole_dur={seconds:.4f}", "-t", f"{seconds:.4f}", "-ar", "48000", "-ac", "2", str(sound)], check=True)
    prompt.update({
        "toonflowTrack": {"class_type": "LoadAudio", "inputs": {"audio": sound.name}},
        "toonflowTrackLatent": {"class_type": "LTXVAudioVAEEncode", "inputs": {"audio": ["toonflowTrack", 0], "audio_vae": ["617", 0]}},
        "toonflowTrackLocked": {"class_type": "SetLatentNoiseMask", "inputs": {"samples": ["toonflowTrackLatent", 0], "mask": ["630", 0]}},
    })
    prompt["548"]["inputs"]["audio_latent"] = ["toonflowTrackLocked", 0]
    prompt["591"]["inputs"]["audio_latent"] = ["toonflowTrackLocked", 0]
response = requests.post(base + "/prompt", json={"prompt": prompt}, timeout=60)
if response.status_code != 200:
    raise RuntimeError("ComfyUI rejected the V5 workflow: " + response.text[:3000])
promptId = response.json()["prompt_id"]
while True:
    history = requests.get(f"{base}/history/{promptId}", timeout=30).json().get(promptId)
    if history and history.get("status", {}).get("completed") is not None:
        break
    time.sleep(5)
if history["status"].get("status_str") != "success":
    raise RuntimeError("V5 render failed: " + json.dumps(history["status"])[:3000] + "\n" + log.read_text()[-3000:])
mark("render")
video = history["outputs"]["597"]["gifs"][-1]
outputs.mkdir(parents=True, exist_ok=True)
final = outputs / "final.mp4"
rendered = comfy / "output" / video["subfolder"] / video["filename"]
if track:
    # The clip keeps the soundtrack file itself, so the voice is exactly the dubbed one.
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", str(rendered), "-i", str(sound), "-map", "0:v", "-map", "1:a", "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-shortest", str(final)], check=True)
elif os.environ.get("EROS_AUDIO") == "1":
    shutil.copy(rendered, final)
else:
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", str(rendered), "-c:v", "copy", "-an", str(final)], check=True)
data = final.read_bytes()
timings["recipe"] = {"workflow": "TenStrip 10Eros Basic I2V DMD V5", "comfyCommit": comfyCommit, "nodePacks": nodePacks, "weightRevisions": weightRevisions}
timings["artifact"] = {"path": str(final), "bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()}
(outputs / "timings.json").write_text(json.dumps(timings))
print("COLAB_DONE")
