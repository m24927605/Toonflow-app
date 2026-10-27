# LoRA training for Sulphur 2 / LTX-2.3 (video), Qwen-Image 2.1 (image) or Krea 2 (LUSTIFY v10 stills) on a Colab GPU
# session, run by lora.ts.
# Input: /content/<LORA_JOB>.json and <LORA_JOB>Item* media with optional text captions.
# Output: /content/<LORA_JOB>.safetensors, followed by COLAB_DONE on success.
# Qwen-Image trains with Fizgig, pinned and installed into its own venv with uv: Colab's Python has no ensurepip, and
# uv's default first-index rule fails on packages the PyTorch index also lists, so it resolves across indexes like pip.
# Sulphur 2 trains with Lightricks' own ltx-trainer on Sulphur's dev weights, the LTX-2.3 dev model with the Sulphur
# LoRA merged in, which inference rebuilds from the dev fp8 checkpoint and that LoRA; its LoRA keys (diffusion_model.*)
# load in ComfyUI unchanged.
# Krea 2 trains with kohya's musubi-tuner on Krea 2 Raw, as Krea and the LUSTIFY author advise (train on Raw, draw on
# Turbo and its finetunes), with musubi's documented defaults (rank and alpha 32, AdamW8bit at 1e-4, resolution-aware
# shift); 800 steps held identity best on 20 clothed images of each test character.
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

os.environ.update(HF_HUB_DISABLE_TELEMETRY="1", HF_HUB_DISABLE_IMPLICIT_TOKEN="1", DO_NOT_TRACK="1", WANDB_MODE="disabled")
# Pinned to the revisions this pipeline was written against, the weights' repos too, so a changed upload upstream never
# reaches a training unnoticed.
fizgigCommit = "7ee4986dae28fe35cc4ef636b984729624b32b42"
# ltx-trainer v1.5.0; the repo ships no uv.lock, so the lock is resolved as of a fixed date.
ltxCommit = "e98f6d927d83c92ef2be6aec76c8440b19306e39"
ltxLockDate = "2026-10-19T00:00:00Z"
musubiCommit = "f8a1b03794a49239a3539015075f5123d6c07d66"
weightRevisions = {
    "Comfy-Org/Qwen-Image-2.1": "a8342359c61979b06a8dafb1a47991fe1f30e994",
    "Qwen/Qwen-Image-2.1": "d26bb61231c349cf6b7896fa83353113880e1ba3",
    "ShootTheSound/Fizgig-Qwen-Image-2.1-Training-Adapter": "f55fcaa0cb9e3705d331a1268bc3dd4cc4e02d51",
    "SulphurAI/Sulphur-2-base": "65587bbb38c700622f9434a16e732c8b280c115e",
    # Google's gemma-3-12b-it, byte for byte the encoder Comfy-Org packs for inference, without the licence gate.
    "unsloth/gemma-3-12b-it": "9478e665381f42974aa06177b019352fb6291876",
    # OpenCV's YuNet face detector (MIT); OpenCV 5, which the LTX trainer's lock installs, no longer has Haar cascades.
    "opencv/face_detection_yunet": "3cc26e7f1014a5ee5d74a42acee58bafc9d0a310",
    "Comfy-Org/Krea-2": "1171f4dc7e325bf3734586942e737872506c73e1",
}
models = Path("/content/models")
jobName = os.environ["LORA_JOB"]
assert jobName.startswith("lora") and len(jobName) == 36 and all(char in "0123456789abcdef" for char in jobName[4:])
job = json.loads(Path(f"/content/{jobName}.json").read_text())
trigger, family, kind = job["trigger"], job["family"], job["kind"]
assert trigger.isalpha() and trigger.islower() and 4 <= len(trigger) <= 12
assert family in ("ltx", "qwen", "krea2") and kind in ("character", "scene", "costume", "style", "motion", "slider")
# Each job has its own folder: training runs detached, so a job left running by a restarted server shared one folder
# with the next and crashed when that job cleared it.
data = Path("/content/loradata") / jobName
assert not (family == "ltx" and kind == "slider") and not (family == "qwen" and kind == "motion")
assert family != "krea2" or kind in ("character", "scene", "costume", "style")


def run(*args, **kwargs):
    result = subprocess.run([str(arg) for arg in args], capture_output=True, text=True, **kwargs)
    print(result.stdout[-2000:], flush=True)
    if result.returncode:
        raise RuntimeError(f"{args[0]} {args[1] if len(args) > 1 else ''} failed ({result.returncode}): {result.stderr[-3000:]}")


def checkout(repo, url, commit):
    if not (repo / ".git").exists():
        run("git", "clone", "-q", url, repo)
    run("git", "-C", repo, "checkout", "-q", "--detach", commit)


run(sys.executable, "-m", "pip", "install", "-q", "uv==0.13.1", "huggingface_hub==1.33.0")
from huggingface_hub import hf_hub_download, snapshot_download
from modelPreparation import hubToken, retryThrottled

# The machine's shared weight cache, as modelPreparation.py fills it: Sulphur renders read the same dev bf16 file.
weightCache = "/content/toonflowWeights"
trainingWeights = Path("/dev/shm/krea2Training")

if family == "ltx":
    repo = Path("/content/LTX-2")
    checkout(repo, "https://github.com/Lightricks/LTX-2.git", ltxCommit)
    python = repo / ".venv/bin/python"
    if not (repo / "toonflowReady").exists():
        # Colab's UV_* variables push uv into the system Python; they go, the repo's own uv overrides (its cuDNN pin)
        # stay. torch 2.13+cu132 needs a CUDA 13 driver.
        environment = {key: value for key, value in os.environ.items() if not key.startswith("UV_") and key != "PYTHONPATH"}
        run("uv", "lock", "--python", "3.12", "--exclude-newer", ltxLockDate, cwd=repo, env=environment)
        run("uv", "sync", "--frozen", "--no-dev", "--package", "ltx-trainer", "--python", "3.12", cwd=repo, env=environment)
        (repo / "toonflowReady").touch()
    paths = {
        "dit": retryThrottled(lambda: hf_hub_download("SulphurAI/Sulphur-2-base", "sulphur_dev_bf16.safetensors", revision=weightRevisions["SulphurAI/Sulphur-2-base"], cache_dir=weightCache, token=hubToken())),
        "te": retryThrottled(lambda: snapshot_download("unsloth/gemma-3-12b-it", revision=weightRevisions["unsloth/gemma-3-12b-it"], cache_dir=weightCache, token=hubToken())),
    }
elif family == "krea2":
    repo = Path("/content/musubi")
    venv = Path("/content/musubiEnv")
    checkout(repo, "https://github.com/kohya-ss/musubi-tuner.git", musubiCommit)
    python = venv / "bin/python"
    if not (venv / "toonflowReady").exists():
        # musubi's dependencies move torch to 2.14.1, whose matching torchvision must come from the same CUDA index, or
        # transformers fails to import torchvision's nms.
        environment = {key: value for key, value in os.environ.items() if not key.startswith("UV_")}
        run("uv", "venv", "-q", "--allow-existing", "--system-site-packages", "--python", "/usr/bin/python3", venv, env=environment)
        run("uv", "pip", "install", "-q", "--python", python, "-e", repo, env=environment)
        run("uv", "pip", "install", "-q", "--python", python, "torchvision==0.29.1", "torch==2.14.1", "--index-url", "https://download.pytorch.org/whl/cu130",
            "--extra-index-url", "https://pypi.org/simple", env=environment)
        (venv / "toonflowReady").touch()
    files = {"dit": "diffusion_models/krea2_raw_bf16.safetensors", "te": "text_encoders/qwen3vl_4b_bf16.safetensors", "vae": "vae/qwen_image_vae.safetensors"}
    # Comfy-Org's Krea 2 Raw keeps the official key layout musubi loads and is not gated. These 33 GB serve training
    # only, and the disk is full with the models that draw and render, so they go to the RAM disk and leave with the job.
    shutil.rmtree(trainingWeights, ignore_errors=True)
    paths = {key: retryThrottled(lambda: hf_hub_download("Comfy-Org/Krea-2", name, revision=weightRevisions["Comfy-Org/Krea-2"], local_dir=trainingWeights, token=hubToken())) for key, name in files.items()}
else:
    repo = Path("/content/fizgig")
    venv = Path("/content/fzenv")
    checkout(repo, "https://github.com/shootthesound/Fizgig.git", fizgigCommit)
    python = venv / "bin/python"
    if not (venv / "toonflowReady").exists():
        run("uv", "venv", "-q", "--allow-existing", "--python", sys.executable, venv)
        run("uv", "pip", "install", "-q", "--index-strategy", "unsafe-best-match", "--python", python, "-r", repo / "requirements.txt",
            env={**os.environ, "DISABLE_CUDA": "1"})
        (venv / "toonflowReady").touch()
    files = {
        "dit": ("Comfy-Org/Qwen-Image-2.1", "diffusion_models/qwen_image_2.1_bf16.safetensors"),
        "te": ("Comfy-Org/Qwen-Image-2.1", "text_encoders/qwen3vl_8b_bf16.safetensors"),
        "vae": ("Qwen/Qwen-Image-2.1", "vae/diffusion_pytorch_model.safetensors"),
        "adapter": ("ShootTheSound/Fizgig-Qwen-Image-2.1-Training-Adapter", "fizgig_qwen_image_2.1_training_adapter_v2.safetensors"),
        **({"speed": ("Comfy-Org/Qwen-Image-2.1", "loras/qwen_image_2.1_turbo_lora_avg_rank_178_bf16.safetensors")} if kind == "slider" else {}),
    }
    paths = {key: retryThrottled(lambda: hf_hub_download(repoId, name, revision=weightRevisions[repoId], cache_dir=weightCache, token=hubToken())) for key, (repoId, name) in files.items()}

items = sorted(path for path in Path("/content").glob(f"{jobName}Item*") if path.suffix != ".txt")
env = {**os.environ, "PYTHONPATH": str(repo / "src")} if family == "qwen" else {key: value for key, value in os.environ.items() if not key.startswith("UV_") and key != "PYTHONPATH"}
out = data / "out"
shutil.rmtree(data, ignore_errors=True)
data.mkdir(parents=True)
videoSuffixes = (".mp4", ".mov", ".webm")

if kind == "slider":
    # A slider trains from three prompts, rendering its own practice pictures; no dataset or cache. At commit 7ee4986 a
    # negative prompt reaches the Qwen practice renders with an extra batch dimension and crashes, so they run without
    # CFG (no negative) on the Turbo LoRA, which renders well at CFG 1, as Fizgig's app does.
    slider = job["slider"]
    speed = ["--speed_lora", paths["speed"]] if "speed" in paths else []
    run(python, repo / "src/fizgig/families/train.py", "--family", "qwen_image21", "--dit", paths["dit"], "--vae", paths["vae"],
        "--text_encoder", paths["te"], "--output_dir", out, "--output_name", trigger, "--network_dim", "8", "--network_alpha", "8",
        "--learning_rate", "2e-4", "--max_train_epochs", "30", "--save_every_n_epochs", "30", "--seed", "42", "--precision", "auto",
        "--blocks_to_swap", "-1", "--optimizer_type", "adamw8bit", "--slider_prompts", slider["base"], f'{slider["base"]} {slider["positive"]}',
        f'{slider["base"]} {slider["negative"]}', "--slider_guidance", "2", "--sample_cfg_scale", "1", *speed, cwd=repo, env=env)
else:
    media = data / "media"
    media.mkdir()
    for index, source in enumerate(items):
        target = media / f"item_{index:02d}{source.suffix.lower()}"
        if family == "ltx" and source.suffix.lower() in videoSuffixes:
            # A clip becomes 24 fps (the trainer places frames by the source rate) on the latent's 32-pixel grid, at
            # least the 49 frames its bucket takes, the last frame held when it is shorter; the bucket keeps the start.
            target = target.with_suffix(".mp4")
            run("ffmpeg", "-v", "error", "-y", "-i", source, "-vf", "fps=24,crop=trunc(iw/32)*32:trunc(ih/32)*32,tpad=stop_mode=clone:stop_duration=2.1",
                "-an", "-c:v", "libx264", "-crf", "16", "-pix_fmt", "yuv420p", target)
        elif family == "ltx" and source.suffix.lower() not in (".png", ".jpg", ".jpeg"):
            # The trainer reads only PNG and JPEG as stills; anything else would be taken for a clip.
            target = target.with_suffix(".png")
            run("ffmpeg", "-v", "error", "-y", "-i", source, target)
        else:
            shutil.copy(source, target)
        caption = source.with_suffix(".txt")
        if caption.exists():
            target.with_suffix(".txt").write_text(caption.read_text())
    # Character sets also learn from a square crop of each clear face: a face filling a small part of a training image
    # carries almost no identity.
    if kind == "character":
        crop = r'''
import sys, cv2
from pathlib import Path
media = Path(sys.argv[1])
detector = cv2.FaceDetectorYN.create(sys.argv[2], "", (320, 320), 0.8)
for source in sorted(media.glob("item_*")):
    image = cv2.imread(str(source))
    if image is None:
        continue
    detector.setInputSize((image.shape[1], image.shape[0]))
    found = detector.detect(image)[1]
    faces = sorted((face for face in ([] if found is None else found) if face[2] >= 96 and face[3] >= 96), key=lambda face: face[2] * face[3], reverse=True)
    if not faces:
        continue
    x, y, w, h = (int(value) for value in faces[0][:4])
    side = int(max(w, h) * 2.2)
    left, top = max(0, x + w // 2 - side // 2), max(0, y + h // 2 - side // 2)
    face = image[top:top + side, left:left + side]
    if min(face.shape[:2]) >= 256:
        cv2.imwrite(str(media / f"face_{source.stem}.png"), cv2.resize(face, (768, 768), interpolation=cv2.INTER_LANCZOS4))
'''
        yunet = retryThrottled(lambda: hf_hub_download("opencv/face_detection_yunet", "face_detection_yunet_2023mar.onnx", revision=weightRevisions["opencv/face_detection_yunet"], local_dir=models / "yunet", token=hubToken()))
        run(python, "-c", crop, media, yunet, env=env)
    # Captions describe everything except what the LoRA learns, so that one thing binds to the trigger word.
    asks = {
        "character": "the framing (close-up, half-body or full-body), the camera angle (front, three-quarter left or right, profile, from above or below, or back), the person's clothing or lack of it, pose and expression, the background and the lighting. Start with 'a woman' or 'a man'. Do not describe the face, eyes, hair, skin or body features.",
        "scene": "the people, their clothing and poses, the objects they hold and the lighting. Do not describe the room or place itself: its walls, doors, floor, windows, furniture or layout.",
        "costume": "the framing, the person (their face, hair and body), their pose and expression, the background and the lighting. Do not describe the clothing, accessories or fabric.",
        "style": "only the content: the subjects, what they do and the setting. Never describe colours, light quality, grain, grading, film stock or any visual style.",
        "motion": "the person, their clothing and the setting, as in the first moment. Do not describe how they move or what action they perform.",
    }
    captioner = r'''
import sys, cv2, torch
from pathlib import Path
from PIL import Image
from transformers import AutoModelForImageTextToText, AutoProcessor
media, trigger, ask = Path(sys.argv[1]), sys.argv[2], sys.argv[3]
name, revision = "Qwen/Qwen3-VL-4B-Instruct", "ebb281ec70b05090aa6165b016eac8ec08e71b17"
# This runs in the trainer's own environment, without modelPreparation: the token is read the same way it does.
tokenFile = Path("/content/.toonflowHubToken")
token = tokenFile.read_text().strip() or None if tokenFile.exists() else None
model = AutoModelForImageTextToText.from_pretrained(name, revision=revision, torch_dtype=torch.bfloat16, device_map="cuda", token=token)
processor = AutoProcessor.from_pretrained(name, revision=revision, token=token)
prompt = "Describe this picture for an image caption in one short English phrase: " + ask + " No full sentence, no quotes."
for path in sorted(media.iterdir()):
    if path.suffix == ".txt" or path.with_suffix(".txt").exists():
        continue
    if path.suffix in (".mp4", ".mov", ".webm"):
        video = cv2.VideoCapture(str(path))
        ok, frame = video.read()
        image = Image.fromarray(cv2.cvtColor(frame, cv2.COLOR_BGR2RGB))
    else:
        image = Image.open(path).convert("RGB")
    messages = [{"role": "user", "content": [{"type": "image", "image": image}, {"type": "text", "text": prompt}]}]
    inputs = processor.apply_chat_template(messages, tokenize=True, add_generation_prompt=True, return_dict=True, return_tensors="pt").to("cuda")
    output = model.generate(**inputs, max_new_tokens=80, do_sample=False)
    text = processor.batch_decode(output[:, inputs["input_ids"].shape[1]:], skip_special_tokens=True)[0].strip().strip('"').replace("\n", " ")
    path.with_suffix(".txt").write_text(f"{trigger} {text}")
    print(path.name, "->", text, flush=True)
'''
    run(python, "-c", captioner, media, trigger, asks[kind], env=env)
    print("dataset:", sorted(path.name for path in media.iterdir()), flush=True)
    if family == "ltx":
        # Stills are one-frame clips in buckets near their ratio, clips 49 frames (about 2 s); captions already open with
        # the trigger word. The LoRA trains the video branch only, leaving audio and the audio-video coupling as they are.
        samples = [path for path in sorted(media.iterdir()) if path.suffix != ".txt"]
        (data / "dataset.jsonl").write_text("".join(json.dumps({"caption": path.with_suffix(".txt").read_text().strip(), "video": f"media/{path.name}"}) + "\n" for path in samples))
        buckets = "768x768x1;576x768x1;768x576x1;544x960x1;960x544x1" + (";512x512x49;512x768x49;768x512x49" if any(path.suffix == ".mp4" for path in samples) else "")
        trainer = repo / "packages/ltx-trainer"
        run(python, "scripts/process_dataset.py", data / "dataset.jsonl", "--resolution-buckets", buckets, "--model-path", paths["dit"],
            "--text-encoder-path", paths["te"], "--output-dir", data / ".precomputed", "--skip-audio", cwd=trainer, env={**env, "HF_HUB_OFFLINE": "1"})
        # ACT: one recipe for every kind, the trainer's own character defaults (rank 32, AdamW 1e-4, 1500 steps); a
        # small style or costume set may overfit, which a later checkpoint comparison would show.
        (data / "config.yaml").write_text(json.dumps({
            "model": {"model_path": paths["dit"], "text_encoder_path": paths["te"], "training_mode": "lora", "load_checkpoint": None},
            "lora": {"rank": 32, "alpha": 32, "dropout": 0.0, "target_modules": ["attn1.to_k", "attn1.to_q", "attn1.to_v", "attn1.to_out.0", "attn2.to_k", "attn2.to_q", "attn2.to_v", "attn2.to_out.0", "ff.net.0.proj", "ff.net.2"]},
            "training_strategy": {"name": "flexible", "video": {"is_generated": True, "latents_dir": "latents"}},
            "optimization": {"learning_rate": 1.0e-4, "steps": 1500, "batch_size": 1, "gradient_accumulation_steps": 1, "max_grad_norm": 1.0, "optimizer_type": "adamw", "scheduler_type": "linear", "scheduler_params": {}, "enable_gradient_checkpointing": True},
            "acceleration": {"mixed_precision_mode": "bf16", "quantization": None, "load_text_encoder_in_8bit": False, "offload_optimizer_during_validation": False},
            "data": {"preprocessed_data_root": str(data / ".precomputed"), "num_dataloader_workers": 2},
            "validation": {"samples": [], "interval": None},
            # Only the trainer's own save at the end: a periodic save at the last step lists the same file twice, and
            # keep_last_n then deletes the one LoRA as the older of the two (ltx-trainer at the pinned commit).
            "checkpoints": {"interval": None, "keep_last_n": 1, "precision": "bfloat16", "save_training_state": "minimal"},
            "flow_matching": {"timestep_sampling_mode": "shifted_logit_normal", "timestep_sampling_params": {}},
            "hub": {"push_to_hub": False},
            "wandb": {"enabled": False},
            "seed": 42,
            "output_dir": str(out),
        }))
        run(python, "scripts/train.py", data / "config.yaml", "--disable-progress-bars", cwd=trainer, env={**env, "HF_HUB_OFFLINE": "1"})
    elif family == "krea2":
        (data / "dataset.toml").write_text(f'''[general]
resolution = [1024, 1024]
caption_extension = ".txt"
batch_size = 1
enable_bucket = true
bucket_no_upscale = false

[[datasets]]
image_directory = "{media}"
cache_directory = "{data / 'cache'}"
num_repeats = 1
''')
        tuner = repo / "src/musubi_tuner"
        run(python, tuner / "krea2_cache_latents.py", "--dataset_config", data / "dataset.toml", "--vae", paths["vae"], cwd=repo, env=env)
        run(python, tuner / "krea2_cache_text_encoder_outputs.py", "--dataset_config", data / "dataset.toml", "--text_encoder", paths["te"], "--batch_size", "8", cwd=repo, env=env)
        run(venv / "bin/accelerate", "launch", "--num_cpu_threads_per_process", "1", "--mixed_precision", "bf16", tuner / "krea2_train_network.py",
            "--dit", paths["dit"], "--vae", paths["vae"], "--dataset_config", data / "dataset.toml", "--sdpa", "--mixed_precision", "bf16",
            "--timestep_sampling", "krea2_shift", "--weighting_scheme", "none", "--optimizer_type", "adamw8bit", "--learning_rate", "1e-4",
            "--gradient_checkpointing", "--max_data_loader_n_workers", "2", "--persistent_data_loader_workers", "--network_module", "networks.lora_krea2",
            "--network_dim", "32", "--network_alpha", "32", "--max_train_steps", "800", "--seed", "42", "--output_dir", out, "--output_name", trigger, cwd=repo, env=env)
    else:
        resolution = 704
        (data / "dataset.toml").write_text(f'''[general]
resolution = [{resolution}, {resolution}]
caption_extension = ".txt"
batch_size = 1
num_repeats = 1
enable_bucket = true
bucket_no_upscale = true

[[datasets]]
image_directory = "{media}"
cache_directory = "{data / 'cache'}"
''')
        cache = repo / "src/fizgig/families/cache.py"
        run(python, cache, "--family", "qwen_image21", "--stage", "latents", "--dataset_config", data / "dataset.toml", "--model", paths["vae"], cwd=repo, env=env)
        run(python, cache, "--family", "qwen_image21", "--stage", "text", "--dataset_config", data / "dataset.toml", "--model", paths["te"], cwd=repo, env=env)
        common = ["--dataset_config", data / "dataset.toml", "--dit", paths["dit"], "--vae", paths["vae"], "--text_encoder", paths["te"],
                  "--output_dir", out, "--output_name", trigger, "--seed", "42", "--precision", "auto", "--blocks_to_swap", "-1",
                  "--ema_decay", "0.98", "--optimizer_type", "adamw8bit", "--training_adapter", paths["adapter"]]
        if kind == "style":
            # Fizgig's Qwen Style preset: a flat rate, since adaptive rates overbake styles.
            recipe = ["--network_dim", "16", "--network_alpha", "16", "--learning_rate", "1.5e-4", "--max_train_epochs", "30", "--save_every_n_epochs", "30"]
        else:
            # Fizgig's Qwen Fast preset.
            recipe = ["--network_dim", "8", "--network_alpha", "8", "--learning_rate", "1e-4", "--adaptive_lr", "--adaptive_lr_min", "2e-4",
                      "--adaptive_lr_max", "4e-4", "--max_train_epochs", "30", "--save_every_n_epochs", "30"]
        run(python, repo / "src/fizgig/families/train.py", "--family", "qwen_image21", *common, *recipe, cwd=repo, env=env)

# ltx-trainer names its LoRA checkpoints lora_weights_step_*; Fizgig and musubi name the file after the trigger word.
saved = list(out.rglob("lora_weights*.safetensors")) if family == "ltx" else list(out.rglob("*.safetensors"))
final = sorted(saved, key=lambda path: path.stat().st_mtime)[-1]
shutil.copy(final, f"/content/{jobName}.safetensors")
for source in items:
    source.unlink()
    source.with_suffix(".txt").unlink(missing_ok=True)
Path(f"/content/{jobName}.json").unlink()
shutil.rmtree(data, ignore_errors=True)
shutil.rmtree(trainingWeights, ignore_errors=True)
print("COLAB_DONE")
