"""Apply the production's explicit FFmpeg plan without uploading resident video again."""
import hashlib
import json
import os
import subprocess
import time
import zipfile
from datetime import datetime, timezone
from pathlib import Path

job = os.environ["PRODUCTION_FINISH_JOB"]
root = Path("/content")
fused = os.environ.get("PRODUCTION_FINISH_FUSED") == "1"
request = json.loads((root / (job + ("Postprocess.json" if fused else ".json"))).read_text())
source = root / "sulphurOut" / job / "final.mp4"
if fused:
    timing = json.loads((source.parent / "timings.json").read_text())
    request["inputs"].append(timing["artifact"])
    for name in ["arguments", "roughArguments"]:
        request[name] = [str(source) if value == "__clipVideo__" else value for value in request[name]]
started = time.monotonic()
startedAt = datetime.now(timezone.utc).isoformat()
for item in request["inputs"]:
    path = Path(item["path"])
    if not path.is_relative_to(root) or ".." in path.parts:
        raise RuntimeError("Postproduction input outside /content")
    data = path.read_bytes()
    if len(data) != item["bytes"] or hashlib.sha256(data).hexdigest() != item["sha256"]:
        raise RuntimeError("Postproduction input digest mismatch")
output = root / (job + ".mp4")
subprocess.run(["ffmpeg", "-v", "error", "-y", *request["arguments"], str(output)], check=True)
filmSeconds = time.monotonic() - started
data = output.read_bytes()
result = {"bytes": len(data), "sha256": hashlib.sha256(data).hexdigest(), "seconds": filmSeconds, "start": startedAt, "end": datetime.now(timezone.utc).isoformat(), "inputs": request["inputs"]}
if fused:
    rough = root / (job + "Rough.mp4")
    began = time.monotonic()
    subprocess.run(["ffmpeg", "-v", "error", "-y", *request["roughArguments"], str(rough)], check=True)
    result["roughSeconds"] = time.monotonic() - began
    files = {"source.mp4": source, "film.mp4": output, "roughCut.mp4": rough, "timings.json": source.parent / "timings.json"}
    result["artifacts"] = [{"file": name, "bytes": path.stat().st_size, "sha256": hashlib.sha256(path.read_bytes()).hexdigest()} for name, path in files.items()]
    with zipfile.ZipFile(root / (job + "Finished.zip"), "w", compression=zipfile.ZIP_STORED) as archive:
        archive.writestr("result.json", json.dumps(result))
        for name, path in files.items():
            archive.write(path, name)
else:
    (root / (job + "Result.json")).write_text(json.dumps(result))
print("COLAB_DONE")
