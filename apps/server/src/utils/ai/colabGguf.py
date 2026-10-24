# GGUF text inference on a persistent Colab CLI session with a pinned llama.cpp release. Every request executes this
# file in the same kernel: the first one downloads llama.cpp and the model and starts llama-server, later ones reuse
# the running server. The server binds 127.0.0.1 inside the VM only; no public endpoint or tunnel is opened.
import json
import os
import subprocess
import time
import urllib.error
import urllib.request
from pathlib import Path
from contextlib import nullcontext
from modelPreparation import downloadSlots, hubToken, retryThrottled

os.environ.update(HF_HUB_DISABLE_TELEMETRY="1", HF_HUB_DISABLE_IMPLICIT_TOKEN="1", DO_NOT_TRACK="1")
request = json.loads((Path("/content") / os.environ["COLAB_INPUT"]).read_text())
modelId = request["modelId"]
revision = request["revision"]
weightFile = request["file"]
thinking = request["thinking"]
# The vision projector of a multimodal model; without one the model reads text only.
mmproj = request.get("mmproj")
mtp = request.get("mtp", False)
template = request.get("template")
messages = request["messages"]
tools = request.get("tools") or []
contextWindow = request["contextWindow"]
maxOutputTokens = request["maxOutputTokens"]
# A JSON Schema the reply must fit: llama-server turns it into a grammar, so the model cannot write a value outside an
# enum, miss a field or leave the JSON unclosed, which the previs plan and the clip check did now and then.
responseSchema = request.get("responseSchema")
if responseSchema is not None and not (isinstance(responseSchema, dict) and responseSchema.get("type") == "object"):
    raise ValueError("Invalid response schema")
def validPart(part):
    if part.get("type") == "text":
        return isinstance(part.get("text"), str)
    if part.get("type") == "input_audio" and mmproj and request.get("audio") is True:
        audio = part.get("input_audio") or {}
        return audio.get("format") == "wav" and isinstance(audio.get("data"), str) and bool(audio["data"])
    return bool(mmproj) and part.get("type") == "image_url" and str((part.get("image_url") or {}).get("url", "")).startswith("data:image/")


def validMessage(item):
    if item["role"] == "user" and isinstance(item.get("content"), list):
        return all(isinstance(part, dict) and validPart(part) for part in item["content"])
    if not isinstance(item.get("content"), str):
        return False
    if item["role"] == "tool":
        return isinstance(item.get("tool_call_id"), str)
    if item["role"] == "assistant" and "tool_calls" in item:
        return isinstance(item["tool_calls"], list)
    return item["role"] in ("system", "user", "assistant")


if not messages or not all(validMessage(item) for item in messages):
    raise ValueError("Invalid text conversation")
if not isinstance(tools, list) or not all(item.get("type") == "function" and isinstance(item.get("function"), dict) for item in tools):
    raise ValueError("Invalid tool declarations")
if not isinstance(contextWindow, int) or not isinstance(maxOutputTokens, int) or not 0 < maxOutputTokens < contextWindow:
    raise ValueError("Invalid token limits")

llamaBuild = request.get("build", "b11559")
llamaRoot = Path("/content") / f"llama-{llamaBuild}"
# Port 8080 belongs to the Colab runtime.
llamaUrl = "http://127.0.0.1:18080"
import fcntl
llamaRoot.mkdir(exist_ok=True)
with (llamaRoot / "install.lock").open("w") as installLock:
    fcntl.flock(installLock, fcntl.LOCK_EX)
    if not (llamaRoot / "ready").exists():
        llamaRoot.mkdir(exist_ok=True)
        # The CUDA 12.8 build: the A100 machines' driver is older than the 13.4 build's PTX needs ("unsupported toolchain"),
        # and 12.8 runs on the L4's newer driver as well.
        for name in (f"llama-{llamaBuild}-bin-ubuntu-cuda-12.8-x64.tar.gz", f"cudart-llama-{llamaBuild}-bin-ubuntu-cuda-12.8-x64.tar.gz"):
            archive = Path("/content") / name
            subprocess.run(["curl", "-sSfL", "--retry", "3", "--retry-all-errors", "--retry-delay", "2", "--connect-timeout", "20", "--max-time", "300", "-o", str(archive), f"https://github.com/ggml-org/llama.cpp/releases/download/{llamaBuild}/{name}"], check=True)
            subprocess.run(["tar", "-xzf", str(archive), "-C", str(llamaRoot)], check=True)
            archive.unlink()
        (llamaRoot / "ready").touch()

loadSeconds = 0.0
server = globals().get("llamaServer")
modelKey = (modelId, revision, weightFile, mmproj, request.get("mmprojModelId"), request.get("mmprojRevision"), mtp, template, llamaBuild)
if globals().get("loadedModel") != modelKey or server is None or server.poll() is not None:
    # One model at a time: release whatever the previous request loaded, in either runtime.
    globals().get("releaseLoadedModel", lambda: None)()
    loadedModel = None
    started = time.monotonic()
    from huggingface_hub import hf_hub_download
    localFilesOnly = os.environ.get("TOONFLOW_LOAD_ONLY") == "1"
    with nullcontext() if localFilesOnly else downloadSlots():
        weightPath = retryThrottled(lambda: hf_hub_download(modelId, weightFile, revision=revision, local_dir="/content/gguf", local_files_only=localFilesOnly, token=hubToken()))
        speculative = ["--spec-type", "draft-mtp", "--spec-draft-n-max", "3", "--spec-draft-p-min", "0", "-ctk", "q8_0", "-ctv", "q8_0"] if mtp else []
        chatTemplate = ["--chat-template-file", retryThrottled(lambda: hf_hub_download(modelId, template, revision=revision, local_dir="/content/gguf", local_files_only=localFilesOnly, token=hubToken()))] if template else []
        # ACT: On the L4 the projector runs on the CPU: the quantized weights and the 32K context nearly fill it, so text work
        # never risks running out of GPU memory. A model on an A100 (`visionOnGpu`) has the headroom and reads images faster.
        vision = ["--mmproj", retryThrottled(lambda: hf_hub_download(request.get("mmprojModelId", modelId), mmproj, revision=request.get("mmprojRevision", revision), local_dir="/content/gguf", local_files_only=localFilesOnly, token=hubToken())), *([] if request.get("visionOnGpu") else ["--no-mmproj-offload"])] if mmproj else []
    if os.environ.get("TOONFLOW_DOWNLOAD_ONLY") == "1":
        print("COLAB_DONE")
        raise SystemExit(0)
    binary = next(llamaRoot.rglob("llama-server"))
    libraries = sorted({str(path.parent) for path in llamaRoot.rglob("*.so*")})
    serverLog = open("/content/llamaServer.log", "w")
    llamaServer = subprocess.Popen([
        str(binary), "-m", weightPath, *vision, *speculative, *chatTemplate, "-ngl", "999", "-c", str(contextWindow), "-fa", "on", "--jinja",
        "--host", "127.0.0.1", "--port", "18080",
    ], stdout=serverLog, stderr=subprocess.STDOUT, env={**os.environ, "LD_LIBRARY_PATH": ":".join([*libraries, os.environ.get("LD_LIBRARY_PATH", "")])})
    while True:
        if llamaServer.poll() is not None:
            raise RuntimeError(f"llama-server stopped while loading {modelId}:\n{Path('/content/llamaServer.log').read_text()[-2000:]}")
        try:
            if json.loads(urllib.request.urlopen(f"{llamaUrl}/health", timeout=5).read()).get("status") == "ok":
                break
        except (OSError, ValueError):
            pass
        time.sleep(2)

    def releaseLoadedModel():
        llamaServer.terminate()
        llamaServer.wait(60)

    loadedModel = modelKey
    loadSeconds = time.monotonic() - started

# ACT: A low temperature without penalties. Qwen's card settings (0.7, presence_penalty 1.5) stopped the 4-bit model's
# loops to the token limit (7 of a film's 101 replies), but the presence penalty punishes the values a JSON plan must
# repeat, such as "front" for every shot, and broke every previs plan, at 0.3 too. Loops cost a retry; a broken plan
# stops the film. Fix the looping prompts one by one instead.
sampling = {"temperature": 0.15, "top_p": 0.9}
started = time.monotonic()
try:
    reply = json.loads(urllib.request.urlopen(urllib.request.Request(
        f"{llamaUrl}/v1/chat/completions",
        json.dumps({
            "messages": messages, "max_tokens": maxOutputTokens, **sampling,
            "chat_template_kwargs": {"enable_thinking": thinking},
            **({"response_format": {"type": "json_schema", "json_schema": {"name": "reply", "schema": responseSchema}}} if responseSchema else {}),
            **({"tools": tools} if tools else {}),
            # Set only when a reply wrote its tool call as text and is asked again.
            **({"tool_choice": "required"} if tools and request.get("toolChoice") == "required" else {}),
        }).encode(),
        {"Content-Type": "application/json"},
    ), timeout=7200).read())
except urllib.error.HTTPError as error:
    # llama-server rejects prompts longer than the context with a 400 and a JSON message.
    raise ValueError(f"llama-server rejected the request: {error.read().decode(errors='replace')[-1000:]}") from None
generateSeconds = time.monotonic() - started
choice = reply["choices"][0]
# llama-server parses the chat template's tool call syntax into OpenAI tool_calls with JSON string arguments.
toolCalls = [
    {"id": call.get("id") or f"call{index}", "name": call["function"]["name"], "arguments": call["function"].get("arguments") or "{}"}
    for index, call in enumerate(choice["message"].get("tool_calls") or [])
]
result = {
    "text": choice["message"].get("content") or "",
    "toolCalls": toolCalls,
    "reasoning": choice["message"].get("reasoning_content") or "",
    "inputTokens": reply["usage"]["prompt_tokens"],
    "outputTokens": reply["usage"]["completion_tokens"],
    "stopReason": "length" if choice["finish_reason"] == "length" else "toolUse" if toolCalls else "stop",
    "loadSeconds": round(loadSeconds, 1),
    "generateSeconds": round(generateSeconds, 1),
}
Path("/content/colabOutput.json").write_text(json.dumps(result, ensure_ascii=False))
print("COLAB_DONE")
