"""Pinned installation artifacts and bounded downloads shared by isolated model environments."""
import fcntl
import hashlib
import json
import os
import signal
import shutil
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path

root = Path("/content/toonflowInstall")
root.mkdir(exist_ok=True)
locks = json.loads(Path("/content/pythonDependencies.json").read_text())
locks["fastComfy"]["packages"] = {**locks["comfy"]["packages"], **locks["fastComfy"]["packages"]}
downloads = {}
downloadPool = ThreadPoolExecutor(max_workers=2)


def readCapacity():
    disk = shutil.disk_usage("/content")
    memory = {line.split(":")[0]: int(line.split()[1]) * 1024 for line in Path("/proc/meminfo").read_text().splitlines() if line.startswith(("MemTotal:", "MemAvailable:"))}
    gpu = subprocess.check_output(["nvidia-smi", "--query-gpu=name,memory.total,memory.free,driver_version", "--format=csv,noheader,nounits"], text=True).strip()
    return {"checkedAt": datetime.now(timezone.utc).isoformat(), "gpu": gpu, "ramTotal": memory["MemTotal"], "ramAvailable": memory["MemAvailable"], "diskTotal": disk.total, "diskFree": disk.free}


def installationIdentity(family, revision):
    return hashlib.sha256(json.dumps([revision, locks[family]], sort_keys=True).encode()).hexdigest()


def installPackages(python, family, requirements, backend=None):
    version = subprocess.check_output([str(python), "-c", "import sys; print('.'.join(map(str,sys.version_info[:2])))"], text=True).strip()
    locked = locks[family]
    if version != locked["python"]:
        raise RuntimeError(f"The validated {family} dependency lock requires Python {locked['python']}, got {version}")
    constraint = root / (family + "Dependencies.txt")
    temporary = constraint.with_suffix(f".{os.getpid()}.tmp")
    temporary.write_text("\n".join(f"{name}=={version}" for name, version in sorted(locked["packages"].items())) + "\n")
    temporary.replace(constraint)
    # pip recognizes Colab's already-satisfied vendor builds, which are absent from public indexes.
    command = [str(python), "-m", "pip", "install", "--constraint", str(constraint), *requirements] if family in {"comfy", "fastComfy"} else [shutil.which("uv"), "pip", "install", "--python", str(python), "--constraint", str(constraint), *requirements]
    if not command[0]:
        raise RuntimeError("The pinned uv installer was not prepared")
    if backend:
        command.extend(["--extra-index-url", "https://download.pytorch.org/whl/" + backend] if family in {"comfy", "fastComfy"} else ["--torch-backend=" + backend])
    if locked.get("overrides"):
        override = root / (family + "Overrides.txt")
        override.write_text("\n".join(name + version for name, version in sorted(locked["overrides"].items())) + "\n")
        command.extend(["--override", str(override)])
    subprocess.run(command, check=True)


def installComfy(destination, revision, family="comfy"):
    source = root / ("comfy" + revision)
    with (root / ("comfy" + revision + ".lock")).open("w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        if not (source / "sourceReady").exists():
            subprocess.run(["git", "init", "-q", str(source)], check=True)
            subprocess.run(["git", "-C", str(source), "fetch", "-q", "--depth", "1", "https://github.com/Comfy-Org/ComfyUI.git", revision], check=True)
            subprocess.run(["git", "-C", str(source), "checkout", "-q", "FETCH_HEAD"], check=True)
            (source / "sourceReady").touch()
        shutil.copytree(source, destination, dirs_exist_ok=True, ignore=shutil.ignore_patterns(".git", "__pycache__", "sourceReady"))
    installPackages(sys.executable, family, ["-r", str(destination / "requirements.txt"), "huggingface_hub", "hf_xet", "requests"], locks[family]["packages"]["torch"].split("+")[1])


@contextmanager
def downloadSlots(count=1):
    slots = []
    try:
        if count == 2:
            for index in range(2):
                slot = (root / f"download{index}.lock").open("w")
                fcntl.flock(slot, fcntl.LOCK_EX)
                slots.append(slot)
        else:
            while not slots:
                for index in range(2):
                    slot = (root / f"download{index}.lock").open("w")
                    try:
                        fcntl.flock(slot, fcntl.LOCK_EX | fcntl.LOCK_NB)
                        slots.append(slot)
                        break
                    except BlockingIOError:
                        slot.close()
                if not slots:
                    time.sleep(0.2)
        yield
    finally:
        for slot in slots:
            slot.close()


def hubToken():
    """The Hugging Face token Toonflow uploads to /content/.toonflowHubToken, or None to download anonymously. Downloads
    take it explicitly: implicit lookups stay off (HF_HUB_DISABLE_IMPLICIT_TOKEN), as they probe Colab secrets first,
    which a run with no notebook page cannot answer."""
    path = Path("/content/.toonflowHubToken")
    return path.read_text().strip() or None if path.exists() else None


def retryThrottled(download):
    """Runs a download, waiting and trying again when the Hub answers 429 because many machines download at once."""
    for attempt in range(6):
        try:
            return download()
        except Exception as error:
            if "429" not in str(error) or attempt == 5:
                raise
            time.sleep(30 * 2 ** attempt)


def downloadWeights(entries):
    from huggingface_hub import hf_hub_download, try_to_load_from_cache

    def fetch(entry):
        repo, revision, file, target = entry
        target = Path(target)
        target.parent.mkdir(parents=True, exist_ok=True)
        key = hashlib.sha256(str(target).encode()).hexdigest()
        with (root / (key + ".lock")).open("w") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            cached = try_to_load_from_cache(repo, file, revision=revision, cache_dir="/content/toonflowWeights")
            if target.exists() and isinstance(cached, str) and target.samefile(cached):
                return
            with downloadSlots():
                source = Path(retryThrottled(lambda: hf_hub_download(repo_id=repo, filename=file, revision=revision, cache_dir="/content/toonflowWeights", token=hubToken()))).resolve()
            temporary = target.with_suffix(target.suffix + ".tmp")
            temporary.unlink(missing_ok=True)
            os.link(source, temporary)
            temporary.replace(target)

    with ThreadPoolExecutor(max_workers=2) as pool:
        list(pool.map(fetch, entries))


def downloadSnapshot(repo, revision):
    from huggingface_hub import snapshot_download
    with downloadSlots(2):
        return retryThrottled(lambda: snapshot_download(repo, revision=revision, max_workers=2, cache_dir="/content/toonflowWeights", token=hubToken()))


def startDownloads(requests):
    def prefetch(item):
        start, began = datetime.now(timezone.utc).isoformat(), time.monotonic()
        environment = {**os.environ, **{key: str(value) for key, value in item["env"].items()}, "TOONFLOW_PREFETCH_ONLY": "1", "TOONFLOW_LOAD_ONLY": "0", "TOONFLOW_DOWNLOAD_ONLY": "1", "PYTHONPATH": "/content"}
        log = root / ("download" + hashlib.sha256(item["runtime"].encode()).hexdigest()[:16] + ".log")
        with log.open("w") as output:
            result = subprocess.Popen([sys.executable, "-u", "-c", item["script"]], env=environment, stdout=output, stderr=subprocess.STDOUT, start_new_session=True)
            deadline = time.monotonic() + 1800
            while result.poll() is None:
                marker = os.environ.get("TOONFLOW_PREPARE_CANCEL")
                if (marker and Path(marker).exists()) or time.monotonic() > deadline:
                    os.killpg(result.pid, signal.SIGTERM)
                    try:
                        result.wait(timeout=10)
                    except subprocess.TimeoutExpired:
                        os.killpg(result.pid, signal.SIGKILL)
                        result.wait(timeout=10)
                    raise RuntimeError(item["name"] + " prefetch cancelled or exceeded 30 minutes")
                time.sleep(0.2)
        if result.returncode:
            raise RuntimeError(item["name"] + " weight prefetch failed:\n" + log.read_text(errors="replace")[-4000:])
        return {"name": "prefetchWeights", "start": start, "end": datetime.now(timezone.utc).isoformat(), "seconds": time.monotonic() - began}

    for item in requests:
        if item["prefetch"]:
            downloads[item["runtime"]] = downloadPool.submit(prefetch, item)


def finishDownload(runtime):
    pending = downloads.pop(runtime, None)
    return pending.result() if pending else None
