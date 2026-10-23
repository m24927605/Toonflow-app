"""Versioned installer and compiler artifacts; weights and virtual environments are excluded."""
import hashlib
import json
import os
import subprocess
import sys
import tarfile
import tempfile
from pathlib import Path

spec = json.loads((Path("/content") / os.environ["TOONFLOW_CACHE_SPEC"]).read_text())
action = os.environ["TOONFLOW_CACHE_ACTION"]
root = Path("/content/toonflowCache")
root.mkdir(exist_ok=True)
phase = os.environ["TOONFLOW_CACHE_PHASE"]
if phase not in {"install", "compile"}:
    raise ValueError("Unknown runtime cache phase")
hardware = subprocess.check_output(["nvidia-smi", "--query-gpu=name,driver_version", "--format=csv,noheader"], text=True).strip()
try:
    toolkit = subprocess.check_output(["nvcc", "--version"], text=True).strip()
except (OSError, subprocess.CalledProcessError):
    toolkit = None
identity = {"hardware": hardware if phase == "compile" else sys.platform + "/" + os.uname().machine, "python": sys.version if phase == "compile" else sys.implementation.cache_tag, "cudaToolkit": toolkit if phase == "compile" else None, "source": spec[phase + "Source"]}
key = hashlib.sha256(json.dumps(identity, sort_keys=True).encode()).hexdigest()
manifestPath = root / (phase + "Manifest.json")
archive = root / (phase + "Artifacts.tar.gz")


def environment():
    result = {}
    code = "import json,sys,importlib.metadata as m; names={d.metadata['Name'].lower().replace('_','-').replace('.','-') for d in m.distributions()}; versions={n:m.version(n) for n in names}; import torch; print(json.dumps({'python':sys.version,'torchVersion':torch.__version__,'torchCuda':torch.version.cuda,'packages':versions},sort_keys=True))"
    for runtime in spec["runtimes"]:
        directory = "model" + hashlib.sha256(runtime.encode()).hexdigest()[:16]
        python = Path("/content/drama3SglangRuntime/venv/bin/python") if runtime == "drama3Sglang" else Path("/content/drama3Runtime/venv/bin/python") if runtime.startswith("drama3") else Path("/content/toonflowRuntimes") / directory / "venv/bin/python"
        result[runtime] = json.loads(subprocess.check_output([str(python), "-c", code], text=True).strip().splitlines()[-1])
    return result


def excluded(path):
    return path.parts[0] in {"models", "venv", "input", "output"} or any(part in {"__pycache__", ".git"} for part in path.parts) or path.name in {"toonflowReady", "ready", "venvReady", "install.lock"}


if action == "identity":
    manifestPath.write_text(json.dumps({"key": key, "identity": identity}))
elif action == "save":
    installs = []
    for source in spec["installSources"]:
        family, revision = source.split("/", 1)
        installs.append(Path("/content") / ("llama-" + revision) if family == "gguf" else Path("/content/toonflowInstall") / (("omni" if family == "drama3" else "sglang" if family == "sglang" else "comfy") + revision))
    compilers = [Path("/root/.cache/vllm"), Path("/root/.cache/torch"), Path("/root/.cache/torch_extensions"), Path("/tmp/torchinductor_root"), Path("/root/.cache/flashinfer"), Path("/root/.triton/cache")]
    budget = 512 * 1024 * 1024
    size = 0
    included = []
    skipped = []
    with tarfile.open(archive, "w:gz", compresslevel=1, dereference=True) as bundle:
        for path in installs if phase == "install" else compilers:
            if not path.is_dir():
                continue
            files = [item for item in path.rglob("*") if item.is_file() and not item.is_symlink() and not excluded(item.relative_to(path))]
            needed = sum(item.stat().st_size for item in files)
            if needed > budget - size:
                skipped.append({"path": str(path), "bytes": needed, "reason": "cache size limit"})
                continue
            for item in files:
                bundle.add(item, arcname=phase + "/" + str(item).lstrip("/"), recursive=False)
            size += needed
            included.append({"phase": phase, "path": str(path), "bytes": needed})
    manifestPath.write_text(json.dumps({"key": key, "phase": phase, "identity": identity, "environment": environment() if phase == "compile" else {}, "sha256": hashlib.sha256(archive.read_bytes()).hexdigest(), "included": included, "skipped": skipped, "uncompressedBytes": size}))
elif action in {"restore", "restoreCandidates"}:
    if action == "restoreCandidates":
        candidates = json.loads(os.environ["TOONFLOW_CACHE_CANDIDATES"])
        selected = next((item for item in candidates if item["key"] == key), None)
        if selected is None:
            result = {"phase": phase, "matched": False, "key": key}
            (root / (phase + "Restore.json")).write_text(json.dumps(result))
            print("CACHE_RESTORE", json.dumps(result), flush=True)
            print("COLAB_DONE")
            raise SystemExit(0)
        manifestPath = Path("/content") / selected["manifest"]
        archive = Path("/content") / selected["archive"]
    saved = json.loads(manifestPath.read_text())
    if saved["phase"] != phase or saved["key"] != key or saved["identity"] != identity or hashlib.sha256(archive.read_bytes()).hexdigest() != saved["sha256"]:
        raise ValueError("Runtime cache identity or digest mismatch")
    matched = phase == "install" or toolkit is not None and saved["environment"] == environment()
    if matched:
        with tarfile.open(archive, "r:gz") as bundle:
            selected = []
            for member in bundle.getmembers():
                pieces = Path(member.name).parts
                if not pieces or pieces[0] != phase:
                    continue
                if ".." in pieces or member.islnk() or member.issym() or not member.isfile():
                    raise ValueError("Unsafe runtime cache member")
                member.name = str(Path(*pieces[1:]))
                allowed = ["root/.cache/vllm/", "root/.cache/torch/", "root/.cache/torch_extensions/", "tmp/torchinductor_root/", "root/.cache/flashinfer/", "root/.triton/cache/", "content/toonflowInstall/"]
                if not (any(member.name.startswith(prefix) for prefix in allowed) or member.name.startswith("content/llama-b")):
                    raise ValueError("Runtime cache path outside its namespace")
                selected.append(member)
            with tempfile.TemporaryDirectory(dir=root) as staging:
                bundle.extractall(staging, members=selected, filter="data")
                for member in selected:
                    destination = Path("/") / member.name
                    destination.parent.mkdir(parents=True, exist_ok=True)
                    os.replace(Path(staging) / member.name, destination)
    result = {"phase": phase, "matched": matched, "key": key}
    (root / (phase + "Restore.json")).write_text(json.dumps(result))
    print("CACHE_RESTORE", json.dumps(result), flush=True)
else:
    raise ValueError("Unknown runtime cache action")
print("COLAB_DONE")
