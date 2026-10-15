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

os.environ.update(HF_HUB_DISABLE_TELEMETRY="1", HF_HUB_DISABLE_IMPLICIT_TOKEN="1", DO_NOT_TRACK="1")
request = json.loads(Path("/content/colabInput.json").read_text())
modelId = request["modelId"]
revision = request["revision"]
weightFile = request["file"]
thinking = request["thinking"]
# The vision projector of a multimodal model; without one the model reads text only.
mmproj = request.get("mmproj")
messages = request["messages"]
tools = request.get("tools") or []
contextWindow = request["contextWindow"]
maxOutputTokens = request["maxOutputTokens"]
def validPart(part):
    if part.get("type") == "text":
        return isinstance(part.get("text"), str)
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

llamaBuild = "b11559"
llamaRoot = Path("/content/llama")
# Port 8080 belongs to the Colab runtime.
llamaUrl = "http://127.0.0.1:18080"
if not (llamaRoot / "ready").exists():
    llamaRoot.mkdir(exist_ok=True)
    for name in (f"llama-{llamaBuild}-bin-ubuntu-cuda-13.4-x64.tar.gz", f"cudart-llama-{llamaBuild}-bin-ubuntu-cuda-13.4-x64.tar.gz"):
        archive = Path("/content") / name
        subprocess.run(["curl", "-sSfL", "-o", str(archive), f"https://github.com/ggml-org/llama.cpp/releases/download/{llamaBuild}/{name}"], check=True)
        subprocess.run(["tar", "-xzf", str(archive), "-C", str(llamaRoot)], check=True)
        archive.unlink()
    (llamaRoot / "ready").touch()

loadSeconds = 0.0
server = globals().get("llamaServer")
if globals().get("loadedModel") != (modelId, revision, weightFile, mmproj) or server is None or server.poll() is not None:
    # One model at a time: release whatever the previous request loaded, in either runtime.
    globals().get("releaseLoadedModel", lambda: None)()
    loadedModel = None
    started = time.monotonic()
    from huggingface_hub import hf_hub_download
    weightPath = hf_hub_download(modelId, weightFile, revision=revision, local_dir="/content/gguf")
    # ACT: The projector runs on the CPU: the quantized weights and the 32K context nearly fill the L4, so text work
    # never risks running out of GPU memory; drop --no-mmproj-offload once a run shows the headroom, for faster images.
    vision = ["--mmproj", hf_hub_download(modelId, mmproj, revision=revision, local_dir="/content/gguf"), "--no-mmproj-offload"] if mmproj else []
    binary = next(llamaRoot.rglob("llama-server"))
    libraries = sorted({str(path.parent) for path in llamaRoot.rglob("*.so*")})
    serverLog = open("/content/llamaServer.log", "w")
    llamaServer = subprocess.Popen([
        str(binary), "-m", weightPath, *vision, "-ngl", "999", "-c", str(contextWindow), "-fa", "on", "--jinja",
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

    loadedModel = (modelId, revision, weightFile, mmproj)
    loadSeconds = time.monotonic() - started

started = time.monotonic()
try:
    reply = json.loads(urllib.request.urlopen(urllib.request.Request(
        f"{llamaUrl}/v1/chat/completions",
        json.dumps({
            "messages": messages, "max_tokens": maxOutputTokens, "temperature": 0.15, "top_p": 0.9,
            "chat_template_kwargs": {"enable_thinking": thinking},
            **({"tools": tools} if tools else {}),
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
