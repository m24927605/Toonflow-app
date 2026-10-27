"""Keep model environments on a VM while switching isolated GPU process groups."""
import base64
import hashlib
import json
import os
import signal
import shutil
import subprocess
import sys
import time
import threading
import traceback
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path

process = None
modelKey = None


def gpuModelProcesses():
    # NVIDIA's MPS server keeps a context for its clients; it is not a model and stays after cleanup.
    rows = subprocess.check_output(["nvidia-smi", "--query-compute-apps=pid,process_name", "--format=csv,noheader,nounits"], text=True).splitlines()
    return [row.split(",")[0].strip() for row in rows if row.strip() and "nvidia-cuda-mps" not in row]


def settleJob(job):
    Path(f"/content/toonflowSettled{job}.json").write_text('{"settled":true}')


def cancelled(job):
    return Path(f"/content/toonflowCancel{job}").exists()


def terminateModel():
    global process, modelKey
    if process is None:
        return
    group = process.pid
    try:
        os.killpg(group, signal.SIGTERM)
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            process.poll()
            try:
                os.killpg(group, 0)
            except ProcessLookupError:
                break
            time.sleep(0.1)
        else:
            os.killpg(group, signal.SIGKILL)
    except ProcessLookupError:
        pass
    process.wait(timeout=10)
    process.stdin.close()
    deadline = time.monotonic() + 10
    while gpuModelProcesses():
        if time.monotonic() >= deadline:
            raise RuntimeError("TOONFLOW_MODEL_UNSAFE: GPU processes remain after model cleanup")
        time.sleep(0.2)
    process = modelKey = None


def stopModel():
    try:
        terminateModel()
    except Exception as error:
        raise RuntimeError("TOONFLOW_MODEL_UNSAFE: " + str(error)) from error


def modelDirectory(key):
    root = Path("/content/toonflowRuntimes")
    root.mkdir(exist_ok=True)
    identity = "model" + hashlib.sha256(key.encode()).hexdigest()[:16]
    directory = root / identity
    directory.mkdir(exist_ok=True)
    return directory


def prepareEnvironment(key):
    directory = modelDirectory(key)
    python = directory / "venv/bin/python"
    ready = directory / "venvReady"
    if not ready.exists():
        uv = shutil.which("uv")
        if not uv:
            raise RuntimeError("uv executable is missing from the model preparation environment")
        subprocess.run([uv, "venv", "--allow-existing", "--seed", "--system-site-packages", "--python", sys.executable, str(directory / "venv")], check=True)
        ready.touch()
    return python


def prepareBatch(requestPath, statusPath, cancelPath):
    from concurrent.futures import as_completed
    from modelPreparation import startDownloads, finishDownload, readCapacity
    request = json.loads(Path(requestPath).read_text())
    items = request["models"]
    os.environ["TOONFLOW_PREPARE_CANCEL"] = cancelPath
    status = {"batch": request["batch"], "models": {item["name"]: {"key": item["key"], "state": "preparing"} for item in items}}
    statusLock = threading.Lock()
    finished = threading.Event()

    def publish():
        with statusLock:
            status["updatedAt"] = time.time()
            temporary = Path(statusPath + ".tmp")
            temporary.write_text(json.dumps(status))
            temporary.replace(statusPath)

    def heartbeat():
        while not finished.wait(10):
            publish()

    def restore(specification):
        environment = {**os.environ, "TOONFLOW_CACHE_SPEC": specification["spec"], "TOONFLOW_CACHE_PHASE": specification["phase"], "TOONFLOW_CACHE_ACTION": "restoreCandidates", "TOONFLOW_CACHE_CANDIDATES": json.dumps(specification["candidates"])}
        result = subprocess.check_output([sys.executable, "/content/runtimeCache.py"], env=environment, text=True)
        return next((json.loads(line[len("CACHE_RESTORE "):]) for line in result.splitlines() if line.startswith("CACHE_RESTORE ")), None)

    publish()
    threading.Thread(target=heartbeat, daemon=True).start()
    subprocess.run([sys.executable, "-m", "pip", "install", "-q", "uv==0.13.1", "huggingface-hub==1.33.0"], check=True, timeout=300)
    startDownloads(items)
    installRecords = {}
    for cache in request["installCaches"]:
        installRecords[cache["source"]] = restore(cache)

    def prepare(item):
        if Path(cancelPath).exists():
            raise RuntimeError("Model preparation cancelled")
        python = prepareEnvironment(item["runtime"])
        start, began = datetime.now(timezone.utc).isoformat(), time.monotonic()
        environment = {**os.environ, **{key: str(value) for key, value in item["env"].items()}, "PATH": str(python.parent) + os.pathsep + os.environ["PATH"], "TOONFLOW_DOWNLOAD_ONLY": "1", "TOONFLOW_LOAD_ONLY": "0", "PYTHONNOUSERSITE": "1", "PYTHONPATH": "/content"}
        log = modelDirectory(item["runtime"]) / "prepare.log"
        with log.open("wb") as output:
            child = subprocess.Popen([str(python), "-u", "-c", item["script"]], env=environment, stdout=output, stderr=subprocess.STDOUT, start_new_session=True)
            while child.poll() is None:
                if Path(cancelPath).exists():
                    os.killpg(child.pid, signal.SIGTERM)
                    try:
                        child.wait(timeout=10)
                    except subprocess.TimeoutExpired:
                        os.killpg(child.pid, signal.SIGKILL)
                        child.wait(timeout=10)
                    raise RuntimeError("Model preparation cancelled")
                time.sleep(0.2)
        if child.returncode:
            raise RuntimeError(item["name"] + " installation failed:\n" + log.read_text(errors="replace")[-6000:])
        prefetch = finishDownload(item["runtime"])
        detail = json.loads(Path(item["timingOutput"]).read_text()) if item.get("timingOutput") else {"phases": [], "events": []}
        if prefetch:
            detail["phases"].append(prefetch)
        downloadedAt = datetime.now(timezone.utc).isoformat()
        downloadSeconds = time.monotonic() - began
        compiled = restore(item["compileCache"])
        records = [installRecords.get(item["installSource"]), compiled]
        detail["events"].extend("cacheRestore " + json.dumps(record) for record in records if record)
        return {"name": item["name"], "start": start, "end": downloadedAt, "seconds": downloadSeconds, "passed": True, "details": detail, "capacity": readCapacity()}

    with ThreadPoolExecutor(max_workers=2) as pool:
        futures = {pool.submit(prepare, item): item for item in items}
        for future in as_completed(futures):
            item = futures[future]
            try:
                status["models"][item["name"]] = {"key": item["key"], "state": "ready", "result": future.result()}
            except BaseException:
                status["models"][item["name"]] = {"key": item["key"], "state": "failed", "error": traceback.format_exc()[-6000:]}
            publish()
    finished.set()


def runModel(key, source, environment, job):
    global process, modelKey
    if cancelled(job):
        settleJob(job)
        raise RuntimeError("Model job cancelled before execution")
    directory = modelDirectory(key)
    switched = modelKey != key or process is None or process.poll() is not None
    if switched:
        stopModel()
        if not (directory / "venvReady").exists():
            subprocess.run([sys.executable, "-m", "pip", "install", "-q", "uv==0.13.1"], check=True)
        python = prepareEnvironment(key)
        with open(directory / "runtime.log", "ab", buffering=0) as log:
            process = subprocess.Popen([str(python), "-u", __file__, "worker", str(directory / "runtime.log")], stdin=subprocess.PIPE, stdout=log, stderr=subprocess.STDOUT, start_new_session=True, env={**os.environ, "PATH": str(python.parent) + os.pathsep + os.environ["PATH"], "PYTHONNOUSERSITE": "1"})
        modelKey = key
    result = directory / (job + ".json")
    result.unlink(missing_ok=True)
    process.stdin.write((json.dumps({"source": source, "env": environment, "result": str(result)}) + "\n").encode())
    process.stdin.flush()
    while not result.exists():
        if cancelled(job):
            stopModel()
            settleJob(job)
            raise RuntimeError("Model job cancelled; GPU process group released")
        if process.poll() is not None:
            raise RuntimeError("TOONFLOW_MODEL_UNSAFE: Model runtime stopped unexpectedly:\n" + (directory / "runtime.log").read_text(errors="replace")[-6000:])
        time.sleep(0.2)
    status = json.loads(result.read_text())
    result.unlink()
    print("COLAB_MODEL", json.dumps({"model": key, "switched": switched, "seconds": status["seconds"]}), flush=True)
    if status["error"] is not None:
        stopModel()
        settleJob(job)
        raise RuntimeError(status["error"])
    settleJob(job)
    print(status["output"], flush=True)


def worker():
    namespace = {"__name__": "__main__"}
    environment = os.environ.copy()
    log = Path(sys.argv[2])
    for line in sys.stdin:
        request = json.loads(line)
        destination = Path(request["result"])
        started = time.monotonic()
        error = None
        sys.stdout.flush()
        sys.stderr.flush()
        offset = log.stat().st_size
        try:
            os.environ.clear()
            os.environ.update(environment)
            os.environ.update({key: str(value) for key, value in request["env"].items()})
            exec(compile(base64.b64decode(request["source"]), "<toonflowModel>", "exec"), namespace)
        except SystemExit as exit:
            if exit.code not in (None, 0):
                error = traceback.format_exc()
        except BaseException:
            error = traceback.format_exc()
        sys.stdout.flush()
        sys.stderr.flush()
        # Logging handlers keep valid streams across jobs; read only this job's bounded log tail.
        with log.open("rb") as output:
            output.seek(max(offset, log.stat().st_size - 6000))
            text = output.read().decode(errors="replace")
        if error is None and "COLAB_DONE" not in text:
            error = "Model script ended without COLAB_DONE:\n" + text
        temporary = destination.with_suffix(".tmp")
        temporary.write_text(json.dumps({"error": error, "output": text, "seconds": round(time.monotonic() - started, 3)}))
        os.replace(temporary, destination)


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "prepare":
        try:
            prepareBatch(*sys.argv[2:5])
        except BaseException:
            destination = Path(sys.argv[3])
            data = json.loads(destination.read_text())
            data["error"] = traceback.format_exc()[-6000:]
            temporary = destination.with_suffix(".tmp")
            temporary.write_text(json.dumps(data))
            temporary.replace(destination)
    else:
        worker()
