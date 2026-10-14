# Text inference on a persistent Colab CLI session; no HTTP server is opened. Every request executes this file in the
# same kernel: the first one installs the pinned dependencies and loads the model, later ones reuse the loaded model.
import gc
import json
import os
import subprocess
import sys
import time
from pathlib import Path

os.environ.update(HF_HUB_DISABLE_TELEMETRY="1", HF_HUB_DISABLE_IMPLICIT_TOKEN="1", DO_NOT_TRACK="1")
request = json.loads(Path("/content/colabInput.json").read_text())
modelId = request["modelId"]
revision = request["revision"]
messages = request["messages"]
contextWindow = request["contextWindow"]
maxOutputTokens = request["maxOutputTokens"]
if not messages or not all(item["role"] in ("system", "user", "assistant") and isinstance(item["content"], str) for item in messages):
    raise ValueError("Invalid text conversation")
if not isinstance(contextWindow, int) or not isinstance(maxOutputTokens, int) or not 0 < maxOutputTokens < contextWindow:
    raise ValueError("Invalid token limits")

dependencyMarker = Path("/content/.toonflowTextDependencies")
if not dependencyMarker.exists():
    # torch comes from the Colab image; flash-linear-attention replaces the slow PyTorch fallback of Qwen3.5's
    # linear-attention layers.
    subprocess.run([
        sys.executable, "-m", "pip", "install", "-q", "transformers==5.19.0", "accelerate==1.15.0",
        "bitsandbytes==0.50.2", "mistral-common==1.12.0", "flash-linear-attention==0.5.2",
    ], check=True)
    dependencyMarker.touch()

import torch
from transformers import AutoProcessor, AutoModelForImageTextToText, BitsAndBytesConfig

loadSeconds = 0.0
if globals().get("loadedModel") != (modelId, revision):
    # One model at a time: release whatever the previous request loaded, in either runtime.
    globals().get("releaseLoadedModel", lambda: None)()
    loadedModel = None
    started = time.monotonic()
    processor = AutoProcessor.from_pretrained(modelId, revision=revision, fix_mistral_regex=True)
    model = AutoModelForImageTextToText.from_pretrained(
        modelId, revision=revision, device_map="auto", dtype=torch.bfloat16,
        quantization_config=BitsAndBytesConfig(
            load_in_4bit=True, bnb_4bit_quant_type="nf4",
            bnb_4bit_use_double_quant=True, bnb_4bit_compute_dtype=torch.bfloat16,
        ),
    )
    model.eval()

    def releaseLoadedModel():
        global model, processor
        model = processor = None
        gc.collect()
        torch.cuda.empty_cache()

    loadedModel = (modelId, revision)
    loadSeconds = time.monotonic() - started

inputs = processor.apply_chat_template(
    messages, add_generation_prompt=True, tokenize=True, enable_thinking=False,
    return_dict=True, return_tensors="pt",
)
inputTokens = inputs["input_ids"].shape[-1]
if inputTokens >= contextWindow:
    raise ValueError(f"Prompt exceeds the {contextWindow}-token Colab context limit")
outputLimit = min(maxOutputTokens, contextWindow - inputTokens)
inputs = inputs.to(model.device)
started = time.monotonic()
with torch.inference_mode():
    generated = model.generate(**inputs, max_new_tokens=outputLimit, do_sample=True, temperature=0.15, top_p=0.9)
generateSeconds = time.monotonic() - started
tokens = generated[0][inputTokens:]
eosTokens = model.generation_config.eos_token_id
if isinstance(eosTokens, int):
    eosTokens = [eosTokens]
result = {
    "text": processor.decode(tokens, skip_special_tokens=True),
    "inputTokens": inputTokens,
    "outputTokens": len(tokens),
    "stopReason": "stop" if tokens[-1].item() in (eosTokens or []) else "length",
    "loadSeconds": round(loadSeconds, 1),
    "generateSeconds": round(generateSeconds, 1),
}
Path("/content/colabOutput.json").write_text(json.dumps(result, ensure_ascii=False))
print("COLAB_DONE")
