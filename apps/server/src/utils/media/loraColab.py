# LoRA training for MiniMax H3 (video) or Qwen-Image 2.1 (image) on a Colab GPU session, run by lora.ts.
# Input: /content/lora_job.json ({"trigger", "family", "kind", "slider"?}) and /content/lora_item_* media, each with an
# optional lora_item_*.txt caption written by Toonflow (voice lines carry their transcript this way).
# Output: /content/lora_final.safetensors, followed by a COLAB_DONE line on success.
# Fizgig is pinned and installed into its own venv with uv: Colab's Python has no ensurepip, and uv's default
# first-index rule fails on packages the PyTorch index also lists, so it resolves across indexes like pip.
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

os.environ.update(HF_HUB_DISABLE_TELEMETRY="1", HF_HUB_DISABLE_IMPLICIT_TOKEN="1", DO_NOT_TRACK="1")
fizgigCommit = "7ee4986dae28fe35cc4ef636b984729624b32b42"
repo, venv, models, data = Path("/content/fizgig"), Path("/content/fzenv"), Path("/content/models"), Path("/content/loradata")
job = json.loads(Path("/content/lora_job.json").read_text())
trigger, family, kind = job["trigger"], job["family"], job["kind"]
assert trigger.isalpha() and trigger.islower() and 4 <= len(trigger) <= 12
assert family in ("h3", "qwen") and kind in ("character", "scene", "costume", "style", "motion", "voice", "slider")


def run(*args, **kwargs):
    result = subprocess.run([str(arg) for arg in args], capture_output=True, text=True, **kwargs)
    print(result.stdout[-2000:], flush=True)
    if result.returncode:
        raise RuntimeError(f"{args[0]} {args[1] if len(args) > 1 else ''} failed ({result.returncode}): {result.stderr[-3000:]}")


if not (repo / ".git").exists():
    run("git", "clone", "-q", "https://github.com/shootthesound/Fizgig.git", repo)
run("git", "-C", repo, "checkout", "-q", fizgigCommit)
python = venv / "bin/python"
if not python.exists():
    run(sys.executable, "-m", "pip", "install", "-q", "uv")
    run("uv", "venv", "-q", "--python", sys.executable, venv)
    run("uv", "pip", "install", "-q", "--index-strategy", "unsafe-best-match", "--python", python, "-r", repo / "requirements.txt",
        env={**os.environ, "DISABLE_CUDA": "1"})

from huggingface_hub import hf_hub_download

items = sorted(path for path in Path("/content").glob("lora_item_*") if path.suffix != ".txt")
videos = [path for path in items if path.suffix.lower() in (".mp4", ".mov", ".webm")]
audios = [path for path in items if path.suffix.lower() in (".wav", ".mp3", ".flac", ".ogg", ".m4a")]
files = {
    "h3": {
        "dit": ("Comfy-Org/MiniMax-H3", "diffusion_models/minimax_h3_ref2va_pruned_int8_convrot.safetensors"),
        "te": ("Comfy-Org/MiniMax-H3", "text_encoders/qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors"),
        "vae": ("Comfy-Org/MiniMax-H3", "vae/minimax_h3_video_vae_fp16.safetensors"),
        "adapter": ("circlestone-labs/MiniMax-H3-Image-Training-Adapter", "minimax_h3_image_training_adapter.safetensors"),
        **({"audioVae": ("Comfy-Org/MiniMax-H3", "vae/minimax_h3_audio_vae_fp32.safetensors")} if videos or audios else {}),
    },
    "qwen": {
        "dit": ("Comfy-Org/Qwen-Image-2.1", "diffusion_models/qwen_image_2.1_bf16.safetensors"),
        "te": ("Comfy-Org/Qwen-Image-2.1", "text_encoders/qwen3vl_8b_bf16.safetensors"),
        "vae": ("Qwen/Qwen-Image-2.1", "vae/diffusion_pytorch_model.safetensors"),
        "adapter": ("ShootTheSound/Fizgig-Qwen-Image-2.1-Training-Adapter", "fizgig_qwen_image_2.1_training_adapter_v2.safetensors"),
        **({"speed": ("Comfy-Org/Qwen-Image-2.1", "loras/qwen_image_2.1_turbo_lora_avg_rank_178_bf16.safetensors")} if kind == "slider" else {}),
    },
}[family]
paths = {key: hf_hub_download(repoId, name, local_dir=models / family) for key, (repoId, name) in files.items()}
fizgigFamily = "minimax" if family == "h3" else "qwen_image21"
env = {**os.environ, "PYTHONPATH": str(repo / "src")}
out = data / "out"
shutil.rmtree(data, ignore_errors=True)
data.mkdir(parents=True)

if kind == "slider":
    # A slider trains from three prompts, rendering its own practice pictures; no dataset or cache. At commit 7ee4986 a
    # negative prompt reaches the Qwen practice renders with an extra batch dimension and crashes, so they run without
    # CFG (no negative) on the Turbo LoRA, which renders well at CFG 1, as Fizgig's app does.
    slider = job["slider"]
    speed = ["--speed_lora", paths["speed"]] if "speed" in paths else []
    run(python, repo / "src/fizgig/families/train.py", "--family", fizgigFamily, "--dit", paths["dit"], "--vae", paths["vae"],
        "--text_encoder", paths["te"], "--output_dir", out, "--output_name", trigger, "--network_dim", "8", "--network_alpha", "8",
        "--learning_rate", "2e-4", "--max_train_epochs", "30", "--save_every_n_epochs", "30", "--seed", "42", "--precision", "auto",
        "--blocks_to_swap", "-1", "--optimizer_type", "adamw8bit", "--slider_prompts", slider["base"], f'{slider["base"]} {slider["positive"]}',
        f'{slider["base"]} {slider["negative"]}', "--slider_guidance", "2", "--sample_cfg_scale", "1", *speed, cwd=repo, env=env)
else:
    media = data / "media"
    media.mkdir()
    for index, source in enumerate(items):
        target = media / f"item_{index:02d}{source.suffix.lower()}"
        shutil.copy(source, target)
        caption = source.with_suffix(".txt")
        if caption.exists():
            target.with_suffix(".txt").write_text(caption.read_text())
    # Fizgig refuses H3 media off its spec, so items are brought onto it here. A recording is padded with silence to the
    # next voice length (0.917 to 5.167 s), keeping every spoken word of its transcript. A clip is centre-cropped to
    # multiples of 32, converted to 24 fps (real-time speed is kept) and 32 kHz stereo sound, and cut to the longest
    # 17n+5 frame count it holds (at most 124 frames, about 5 s).
    # ACT: a recording over 5.167 s is cut there and may lose the end of its line; split long recordings before training.
    fit = r'''
import sys, subprocess, numpy as np
from pathlib import Path
from fizgig.families.clips import read_frames
from fizgig.minimax.audio import AUDIO_GRID_FRAMES, AUDIO_SAMPLE_RATE, AUDIO_CHANNELS, read_audio_file, trim_to_grid
from fizgig.minimax.clip import GRID_FRAMES, SPEC, _ffmpeg
from fizgig.minimax.model import FPS
ffmpeg = [_ffmpeg(), "-hide_banner", "-loglevel", "error", "-y"]
for name in sys.argv[1:]:
    path = Path(name)
    if path.suffix in (".mp4", ".mov", ".webm"):
        edge, temp = SPEC.edge_multiple, path.with_name(f"{path.stem}_fit.mp4")
        encode = ["-c:v", "libx264", "-crf", "16", "-pix_fmt", "yuv420p", "-ar", str(SPEC.audio_rate), "-ac", str(SPEC.audio_channels)]
        subprocess.run([*ffmpeg, "-i", str(path), "-vf", f"crop=trunc(iw/{edge})*{edge}:trunc(ih/{edge})*{edge},fps={SPEC.fps}", *encode, str(temp)], check=True)
        count = len(read_frames(str(temp)))
        frames = max(frames for frames in GRID_FRAMES if frames <= count)
        path.unlink()
        subprocess.run([*ffmpeg, "-i", str(temp), "-frames:v", str(frames), "-t", f"{frames / SPEC.fps:.4f}", *encode, str(path.with_suffix(".mp4"))], check=True)
        temp.unlink()
        print(path.name, f"{count} frames ->", frames, flush=True)
        continue
    wav = read_audio_file(str(path))
    seconds = wav.shape[1] / AUDIO_SAMPLE_RATE
    frames = next((frames for frames in AUDIO_GRID_FRAMES if frames / FPS >= seconds), AUDIO_GRID_FRAMES[-1])
    wav = trim_to_grid(wav, frames)
    path.unlink()
    subprocess.run([*ffmpeg, "-f", "f32le", "-ar", str(AUDIO_SAMPLE_RATE), "-ac", str(AUDIO_CHANNELS), "-i", "-", str(path.with_suffix(".wav"))],
                   input=wav.T.astype(np.float32).tobytes(), check=True)
    print(path.name, f"{seconds:.2f} s ->", f"{frames / FPS:.3f} s", flush=True)
'''
    timed = [path for path in media.iterdir() if path.suffix in (".wav", ".mp3", ".flac", ".ogg", ".m4a", ".mp4", ".mov", ".webm")]
    if family == "h3" and timed:
        run(python, "-c", fit, *timed, env=env)
    # Character sets also learn from a square crop of each clear face: a face filling a small part of a training image
    # carries almost no identity.
    if kind == "character":
        crop = r'''
import sys, cv2
from pathlib import Path
media = Path(sys.argv[1])
detector = cv2.CascadeClassifier(cv2.data.haarcascades + "haarcascade_frontalface_default.xml")
for source in sorted(media.glob("item_*")):
    image = cv2.imread(str(source))
    if image is None:
        continue
    faces = sorted(detector.detectMultiScale(cv2.cvtColor(image, cv2.COLOR_BGR2GRAY), 1.1, 6, minSize=(96, 96)), key=lambda box: box[2] * box[3], reverse=True)
    if not len(faces):
        continue
    x, y, w, h = faces[0]
    side = int(max(w, h) * 2.2)
    left, top = max(0, x + w // 2 - side // 2), max(0, y + h // 2 - side // 2)
    face = image[top:top + side, left:left + side]
    if min(face.shape[:2]) >= 256:
        cv2.imwrite(str(media / f"face_{source.stem}.png"), cv2.resize(face, (768, 768), interpolation=cv2.INTER_LANCZOS4))
'''
        run(python, "-c", crop, media)
    # Captions describe everything except what the LoRA learns, so that one thing binds to the trigger word.
    asks = {
        "character": "the framing (close-up, half-body or full-body), the person's clothing or lack of it, pose and expression, the background and the lighting. Start with 'a woman' or 'a man'. Do not describe the face, eyes, hair, skin or body features.",
        "scene": "the people, their clothing and poses, the objects they hold and the lighting. Do not describe the room or place itself: its walls, doors, floor, windows, furniture or layout.",
        "costume": "the framing, the person (their face, hair and body), their pose and expression, the background and the lighting. Do not describe the clothing, accessories or fabric.",
        "style": "only the content: the subjects, what they do and the setting. Never describe colours, light quality, grain, grading, film stock or any visual style.",
        "motion": "the person, their clothing and the setting, as in the first moment. Do not describe how they move or what action they perform.",
        "voice": "",
    }
    captioner = r'''
import sys, cv2, torch
from pathlib import Path
from PIL import Image
from transformers import AutoModelForImageTextToText, AutoProcessor
media, trigger, ask = Path(sys.argv[1]), sys.argv[2], sys.argv[3]
name = "Qwen/Qwen3-VL-4B-Instruct"
model = AutoModelForImageTextToText.from_pretrained(name, torch_dtype=torch.bfloat16, device_map="cuda")
processor = AutoProcessor.from_pretrained(name)
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
    if asks[kind]:
        run(python, "-c", captioner, media, trigger, asks[kind])
    print("dataset:", sorted(path.name for path in media.iterdir()), flush=True)
    resolution = 512 if family == "h3" else 704
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
    sound = ["--aux", f"audio_vae={paths['audioVae']}"] if "audioVae" in paths else []
    run(python, cache, "--family", fizgigFamily, "--stage", "latents", "--dataset_config", data / "dataset.toml", "--model", paths["vae"], *sound, cwd=repo, env=env)
    run(python, cache, "--family", fizgigFamily, "--stage", "text", "--dataset_config", data / "dataset.toml", "--model", paths["te"], cwd=repo, env=env)
    common = ["--dataset_config", data / "dataset.toml", "--dit", paths["dit"], "--vae", paths["vae"], "--text_encoder", paths["te"],
              "--output_dir", out, "--output_name", trigger, "--seed", "42", "--precision", "auto", "--blocks_to_swap", "-1",
              "--ema_decay", "0.98", "--optimizer_type", "adamw8bit", "--training_adapter", paths["adapter"]]
    if family == "h3":
        # Fizgig's documented default H3 recipe; motion reaches more of the model (blocks 6-49), as its guide advises.
        blocks = "6-49" if kind == "motion" else "20-49"
        recipe = ["--network_dim", "8", "--network_alpha", "8", "--learning_rate", "2e-4", "--max_train_epochs", "50", "--save_every_n_epochs", "50",
                  "--family_option", "lownoise_pct=60", "--family_option", "highnoise_lr_pct=100", "--family_option", f"photo_blocks={blocks}",
                  "--family_option", f"clip_blocks={blocks}", "--family_option", f"audio_blocks={blocks}", "--family_option", "caption_dropout=0.05",
                  *(["--family_option", f"audio_vae={paths['audioVae']}"] if "audioVae" in paths else [])]
    elif kind == "style":
        # Fizgig's Qwen Style preset: a flat rate, since adaptive rates overbake styles.
        recipe = ["--network_dim", "16", "--network_alpha", "16", "--learning_rate", "1.5e-4", "--max_train_epochs", "30", "--save_every_n_epochs", "30"]
    else:
        # Fizgig's Qwen Fast preset.
        recipe = ["--network_dim", "8", "--network_alpha", "8", "--learning_rate", "1e-4", "--adaptive_lr", "--adaptive_lr_min", "2e-4",
                  "--adaptive_lr_max", "4e-4", "--max_train_epochs", "30", "--save_every_n_epochs", "30"]
    run(python, repo / "src/fizgig/families/train.py", "--family", fizgigFamily, *common, *recipe, cwd=repo, env=env)

final = sorted(out.rglob("*.safetensors"), key=lambda path: path.stat().st_mtime)[-1]
shutil.copy(final, "/content/lora_final.safetensors")
print("COLAB_DONE")
