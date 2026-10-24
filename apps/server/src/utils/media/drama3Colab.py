# Fish Audio Drama 3 on a private Colab GPU. Each job reuses the pinned vLLM-Omni server.
import base64
import json
import math
import os
import re
import shutil
import subprocess
import sys
import tarfile
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from modelPreparation import downloadSnapshot, installPackages, installOmni, installationIdentity

os.environ.update(HF_HUB_DISABLE_TELEMETRY="1", HF_HUB_DISABLE_IMPLICIT_TOKEN="1", DO_NOT_TRACK="1", VLLM_ENABLE_STARTUP_PLAN="1")
job = os.environ["DRAMA_JOB"]
jobStarted = time.monotonic()
request = json.loads(Path(f"/content/{job}.json").read_text())
sglang = os.environ.get("DRAMA_RUNTIME", "vllm") == "sglang"
root = Path("/content/drama3SglangRuntime" if sglang else "/content/drama3Runtime")
memory = int(subprocess.check_output(["nvidia-smi", "--query-gpu=memory.total", "--format=csv,noheader,nounits"], text=True).strip().splitlines()[0])
if memory < 48 * 1024:
    raise RuntimeError("Drama 3 original weights require at least 48 GiB GPU memory; this Colab machine is too small")
venv = root / "venv"
python = venv / "bin/python"
os.environ["PATH"] = str(venv / "bin") + os.pathsep + os.environ["PATH"]
revision = "b2b5ee998034b2975720906c815e7fb0e9f007bd"
omniRevision = "03c334818305d3b1666da01cd0f67d48a4f3e7a2"
if sglang:
    omniRevision = "1d6d0be42bd25cb3df43987dc24442e5a6023184"
family = "sglang" if sglang else "drama3"
installation = installationIdentity(family, omniRevision)
base = "http://127.0.0.1:18081"
log = root / "server.log"
root.mkdir(exist_ok=True)
if os.environ.get("TOONFLOW_PREFETCH_ONLY") == "1":
    (root / "modelPath").write_text(downloadSnapshot("fishaudio/drama-3", revision))
    print("COLAB_DONE")
    raise SystemExit(0)
timingPath = root / "preparationTimings.json"
details = json.loads(timingPath.read_text()) if os.environ.get("TOONFLOW_LOAD_ONLY") == "1" and timingPath.exists() else {"phases": [], "events": []}
timingLock = threading.Lock()


def recordPhase(name, start, began):
    with timingLock:
        details["phases"].append({"name": name, "start": start, "end": datetime.now(timezone.utc).isoformat(), "seconds": time.monotonic() - began})
        temporary = timingPath.with_suffix(".tmp")
        temporary.write_text(json.dumps(details))
        temporary.replace(timingPath)


def runTimed(name, command, output):
    start, began = datetime.now(timezone.utc).isoformat(), time.monotonic()
    with open(root / output, "a") as destination:
        subprocess.run(command, stdout=destination, stderr=subprocess.STDOUT, check=True)
    recordPhase(name, start, began)


uv = str(root / "uv-x86_64-unknown-linux-gnu/uv")
modelPath = root / "modelPath"
if os.environ.get("TOONFLOW_LOAD_ONLY") != "1":
    if not Path(uv).exists():
        start, began = datetime.now(timezone.utc).isoformat(), time.monotonic()
        archive = root / "uv.tar.gz"
        urllib.request.urlretrieve("https://github.com/astral-sh/uv/releases/download/0.13.1/uv-x86_64-unknown-linux-gnu.tar.gz", archive)
        with tarfile.open(archive) as bundle:
            bundle.extractall(root, filter="data")
        archive.unlink()
        recordPhase("bootstrap", start, began)
    # A small isolated downloader can run while the serving environment installs its GPU packages.
    download = "from modelPreparation import downloadSnapshot; from pathlib import Path; Path(" + repr(str(modelPath)) + ").write_text(downloadSnapshot('fishaudio/drama-3', " + repr(revision) + "))"
    with ThreadPoolExecutor(max_workers=2) as preparation:
        weights = preparation.submit(runTimed, "weightsDownload", [sys.executable, "-c", download], "download.log")
        if not (root / "ready").exists() or (root / "ready").read_text() != installation:
            # Colab's system Python lacks ensurepip; uv supplies an isolated managed Python instead.
            commands = [
                ("pythonEnvironment", [uv, "venv", "--python", "3.12", "--managed-python", "--clear", str(venv)]),
            ]
            for phase, command in commands:
                runTimed(phase, command, "install.log")
            start, began = datetime.now(timezone.utc).isoformat(), time.monotonic()
            installPackages(python, family, ["sglang==0.5.21"] if sglang else ["vllm==0.31.0"], "auto")
            recordPhase("sglangInstall" if sglang else "vllmInstall", start, began)
            start, began = datetime.now(timezone.utc).isoformat(), time.monotonic()
            installOmni(python, omniRevision, family)
            recordPhase("omniInstall", start, began)
            (root / "ready").write_text(installation)
        weights.result()

if not modelPath.exists() or not Path(modelPath.read_text()).is_dir():
    raise RuntimeError("Drama 3 pinned weights were not prepared")
model = modelPath.read_text()
if not shutil.which("ffmpeg") or not shutil.which("ffprobe"):
    raise RuntimeError("Drama 3 requires FFmpeg and FFprobe before serving")
if os.environ.get("TOONFLOW_DOWNLOAD_ONLY") == "1":
    print("COLAB_DONE")
    raise SystemExit(0)

def healthy():
    try:
        with urllib.request.urlopen(base + "/health", timeout=3) as response:
            return json.loads(response.read()).get("status") == "healthy" if sglang else True
    except (OSError, urllib.error.URLError, ValueError):
        return False


if not healthy():
    start, began = datetime.now(timezone.utc).isoformat(), time.monotonic()
    if sglang:
        runTimed("servingImports", [str(python), "-c", "import torch, torchaudio, torchcodec, sglang, sglang_omni, dac, audiotools; print(torch.__version__, torch.version.cuda)"], "install.log")
        command = [str(venv / "bin/sgl-omni"), "serve", "--model-path", model, "--host", "127.0.0.1", "--port", "18081", "--tts_engine.engine.dtype", "bfloat16", "--tts_engine.factory.max_running_requests", "1", "--tts_engine.factory.first_frame_cuda_graph_max_requests", "1", "--vocoder.factory.max_batch_size", "1", "--vocoder.factory.codec_path", str(Path(model) / "codec.pth")]
        if os.environ.get("DRAMA_MODE", "eager") == "eager":
            command.extend(["--tts_engine.engine.disable_cuda_graph", "true", "--tts_engine.factory.first_frame_cuda_graphs", "false"])
        drama3Server = subprocess.Popen(command, stdout=open(log, "a"), stderr=subprocess.STDOUT, env={**os.environ, "PYTHONPATH": "/content"})
    else:
        # The packaged configuration targets H200 high concurrency; this workspace serves small dialogue batches.
        deployment = root / "deployment.yaml"
        configure = """import importlib.util, os, sys, yaml
from pathlib import Path
package = Path(importlib.util.find_spec("vllm_omni").origin).parent
config = yaml.safe_load((package / "deploy/fish_omni.yaml").read_text())
for stage in config["stages"]:
    stage["worker_cls"] = "dramaStartup.arWorker" if stage["stage_id"] == 0 else "dramaStartup.codecWorker"
    stage["max_num_seqs"] = 1 if stage["stage_id"] == 1 else 4
    if stage["stage_id"] == 0:
        stage["max_num_batched_tokens"] = 256
        if os.environ.get("DRAMA_MODE", "eager") == "eager":
            stage["enforce_eager"] = True
            stage.pop("compilation_config", None)
        else:
            stage["compilation_config"]["max_cudagraph_capture_size"] = 256
            stage["compilation_config"]["cudagraph_capture_sizes"] = [1, 2, 4, 8, 16, 32, 64, 128, 256]
config["connectors"]["connector_of_shared_memory"]["extra"]["fish_speech_dac_max_batch"] = 1
Path(sys.argv[1]).write_text(yaml.safe_dump(config))
"""
        start, began = datetime.now(timezone.utc).isoformat(), time.monotonic()
        subprocess.run([str(python), "-c", configure, str(deployment)], check=True)
        serverLog = open(log, "a")
        drama3Server = subprocess.Popen([
            str(venv / "bin/vllm"), "serve", model, "--omni", "--host", "127.0.0.1", "--port", "18081",
            "--served-model-name", "fishaudio/drama-3",
            "--deploy-config", str(deployment), "--stage-init-timeout", "900", "--init-timeout", "1500",
        ], stdout=serverLog, stderr=subprocess.STDOUT, env={**os.environ, "VLLM_WORKER_MULTIPROC_METHOD": "spawn", "PYTHONPATH": "/content"})
    deadline = time.monotonic() + 1800
    while True:
        if drama3Server.poll() is not None:
            raise RuntimeError("Drama 3 server failed to start:\n" + log.read_text()[-5000:])
        if time.monotonic() > deadline:
            drama3Server.terminate()
            raise TimeoutError("Drama 3 server did not become ready within 30 minutes")
        if healthy():
            break
        time.sleep(3)
    details["events"] = [re.sub(r"\x1b\[[0-9;]*m", "", line)[-2000:] for line in log.read_text(errors="replace").splitlines() if any(marker in line for marker in ["Model loading took", "Loading weights took", "init engine", "DAC streaming", "capture", "startup plan"])][-200:]
    for evidence in root.glob("startupEvidence*.json"):
        details["events"].extend("startupFingerprint " + json.dumps(item, separators=(",", ":")) for item in json.loads(evidence.read_text()))
    recordPhase("serverStartup", start, began)

readyAt = time.monotonic()
if request.get("sequence"):
    import hashlib
    import zipfile
    sequence = request["sequence"]
    directory = Path("/content") / (job + "Sequence")
    directory.mkdir(exist_ok=True)
    result = {"reference": None, "line": None, "attempts": [], "phases": []}

    def synthesize(text, output, reference=None, transcript=None):
        payload = {"model": "fishaudio/drama-3", "input": text, "response_format": "wav"}
        if sglang:
            payload.update(stream=False, temperature=1.0, top_p=0.9, top_k=30, max_new_tokens=500, repetition_penalty=1.0)
        if reference:
            payload.update(ref_audio="data:audio/wav;base64," + base64.b64encode(Path(reference).read_bytes()).decode(), ref_text=transcript)
        began = time.monotonic()
        with urllib.request.urlopen(urllib.request.Request(base + "/v1/audio/speech", json.dumps(payload).encode(), {"Content-Type": "application/json"}), timeout=1800) as response:
            wave = response.read()
        if not wave.startswith(b"RIFF") or wave[8:12] != b"WAVE":
            raise RuntimeError("Drama 3 did not return WAV audio")
        Path(output).write_bytes(wave)
        result["phases"].append({"name": "referenceSynthesis" if reference is None else "lineSynthesis", "seconds": time.monotonic() - began})

    def normalize(source, destination):
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", str(source), "-af", ",".join(sequence["filters"]), "-ar", "48000", "-ac", "1", "-c:a", "pcm_s16le", str(destination)], check=True)
        value = subprocess.check_output(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "json", str(destination)], text=True)
        return float(json.loads(value)["format"]["duration"])

    reference = directory / "reference.wav"
    try:
        if request.get("reference"):
            shutil.copyfile(Path("/content") / request["reference"], reference)
            result["reference"] = {"file": reference.name, "text": request["transcript"]}
        else:
            for attempt in range(sequence["referenceAttempts"]):
                raw = directory / "referenceRaw.wav"
                synthesize(sequence["voiceText"], raw)
                normalized = directory / f"referenceAttempt{attempt}.wav"
                seconds = normalize(raw, normalized)
                if math.isfinite(seconds) and 5 <= seconds <= 15:
                    shutil.copyfile(normalized, reference)
                    result["reference"] = {"file": reference.name, "text": sequence["voiceTranscript"], "seconds": seconds}
                    break
                result["attempts"].append({"kind": "reference", "file": normalized.name, "seconds": seconds if math.isfinite(seconds) else 0, "reason": "Reference recording must last 5–15 seconds after trimming boundary silence"})
            if result["reference"] is None:
                raise RuntimeError("Reference recording did not meet the duration requirements")
        for attempt in range(sequence["lineAttempts"]):
            raw = directory / "lineRaw.wav"
            synthesize(sequence["lineText"], raw, reference, result["reference"]["text"])
            normalized = directory / f"lineAttempt{attempt}.wav"
            seconds = normalize(raw, normalized)
            limit = sequence["maximumLineSeconds"]
            if math.isfinite(seconds) and seconds > limit:
                # Drama 3 sometimes keeps voicing a short line long after its words; the words come first, so the
                # recording is cut at the line's limit with a short fade instead of failing the line.
                cut = directory / f"lineCut{attempt}.wav"
                subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", str(normalized), "-t", f"{limit:.3f}", "-af", f"afade=t=out:st={max(0, limit - 0.2):.3f}:d=0.2",
                                "-ar", "48000", "-ac", "1", "-c:a", "pcm_s16le", str(cut)], check=True)
                cut.replace(normalized)
                seconds = float(json.loads(subprocess.check_output(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "json", str(normalized)], text=True))["format"]["duration"])
            if math.isfinite(seconds) and 0 < seconds <= limit + 0.05:
                destination = directory / "line.wav"
                shutil.copyfile(normalized, destination)
                result["line"] = {"file": destination.name, "seconds": seconds}
                break
            result["attempts"].append({"kind": "line", "file": normalized.name, "seconds": seconds if math.isfinite(seconds) else 0, "reason": "Spoken audio is empty or exceeds its contracted timing"})
        if result["line"] is None:
            raise RuntimeError("Dialogue recording did not meet the duration requirements")
    except Exception as error:
        result["error"] = str(error) + (": " + error.read().decode(errors="replace")[-2000:] if isinstance(error, urllib.error.HTTPError) else "")
    files = [path for path in directory.glob("*.wav") if not path.name.endswith("Raw.wav")]
    result["artifacts"] = [{"file": path.name, "bytes": path.stat().st_size, "sha256": hashlib.sha256(path.read_bytes()).hexdigest()} for path in files]
    result["setupSeconds"] = readyAt - jobStarted
    result["sequenceSeconds"] = time.monotonic() - readyAt
    with zipfile.ZipFile(f"/content/{job}Sequence.zip", "w", compression=zipfile.ZIP_STORED) as archive:
        archive.writestr("result.json", json.dumps(result))
        for path in files:
            archive.write(path, path.name)
    print("COLAB_DONE")
    raise SystemExit(0)
body = {"model": "fishaudio/drama-3", "input": request["text"], "response_format": "wav"}
if sglang:
    body.update(stream=False, temperature=1.0, top_p=0.9, top_k=30, max_new_tokens=500, repetition_penalty=1.0)
if request.get("reference"):
    reference = Path("/content") / request["reference"]
    body.update(ref_audio="data:" + (request.get("referenceMimeType") or "application/octet-stream") + ";base64," + base64.b64encode(reference.read_bytes()).decode(), ref_text=request["transcript"])
try:
    response = urllib.request.urlopen(urllib.request.Request(base + "/v1/audio/speech", json.dumps(body).encode(), {"Content-Type": "application/json"}), timeout=1800)
    with response:
        audio = response.read()
except urllib.error.HTTPError as error:
    raise RuntimeError("Drama 3 rejected the request: " + error.read().decode(errors="replace")[-2000:]) from None
if not audio.startswith(b"RIFF") or audio[8:12] != b"WAVE":
    raise RuntimeError("Drama 3 did not return WAV audio")
Path(f"/content/{job}.wav").write_bytes(audio)
Path(f"/content/{job}Timings.json").write_text(json.dumps({"setupSeconds": round(readyAt - jobStarted, 3), "generationSeconds": round(time.monotonic() - readyAt, 3)}))
Path(f"/content/{job}.json").unlink()
if request.get("reference"):
    reference.unlink()
print("COLAB_DONE")
