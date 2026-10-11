import { devNull, homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { lstat, mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from "@toonflow/file";
import type { ProviderTools } from "@toonflow/providers";
import { findCommand } from "@/utils/cli";
import pipeline from "./minimaxH3Colab.py" with { type: "text" };

export type MinimaxH3Request = Parameters<ProviderTools["minimaxH3"]>[0];

const resolutions = new Set(["480p", "720p", "1080p"]);

/**
 * The Colab CLI always writes a DEBUG log to ~/.config/colab-cli/colab.log, which records the Google OAuth tokens in
 * plain text and cannot be relocated, so the log must point at the null device before any command runs.
 */
async function guardColabLog() {
  const directory = join(homedir(), ".config", "colab-cli");
  const log = join(directory, "colab.log");
  const info = await lstat(log).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (info?.isSymbolicLink() && await readlink(log) === devNull) return;
  if (info) throw Object.assign(new Error(`Colab CLI 日志 ${log} 会以明文记录 Google 登录令牌，请先删除该文件后重试`), { status: 400 });
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await symlink(devNull, log);
}

async function colab(command: string, args: string[], signal?: AbortSignal) {
  const child = Bun.spawn([command, ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe", signal });
  const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
  await child.exited;
  signal?.throwIfAborted();
  if (child.exitCode !== 0) throw new Error((stderr.trim() || stdout.trim()).slice(-2000) || `Colab CLI 异常退出（${child.exitCode}）`);
  return stdout;
}

/**
 * Renders one MiniMax H3 video on a fresh Colab A100 session with the user's local Colab CLI login and returns the
 * MP4 bytes. Toonflow never reads or forwards the Colab credentials.
 */
export async function runMinimaxH3({ prompt, images = [], duration, resolution, ratio, audio }: MinimaxH3Request, signal?: AbortSignal) {
  // Every value below reaches argv, so only plain tokens are accepted; the prompt travels as an uploaded file.
  if (!prompt.trim()) throw new Error("MiniMax H3 提示词不能为空");
  if (!Number.isInteger(duration) || duration < 4 || duration > 15) throw new Error("MiniMax H3 时长须为 4 到 15 秒的整数");
  if (!resolutions.has(resolution)) throw new Error("MiniMax H3 只支持 480p、720p 和 1080p");
  if (!/^[1-9]\d?:[1-9]\d?$/.test(ratio)) throw new Error("MiniMax H3 画面比例无效");
  if (images.length > 9) throw new Error("MiniMax H3 最多支持 9 张参考图片");
  const command = findCommand("colab", "未找到 Colab CLI，请先安装 google-colab-cli 并在终端执行 colab sessions 完成 Google 登录");
  await guardColabLog();
  const directory = await mkdtemp(join(tmpdir(), "toonflow-h3-"));
  const session = `toonflow-h3-${crypto.randomUUID().slice(0, 8)}`;
  let created = false;
  let failure: unknown;
  try {
    const script = join(directory, "minimaxH3Colab.py");
    const promptFile = join(directory, "prompt.txt");
    await writeFile(script, pipeline);
    await writeFile(promptFile, prompt);
    const uploads: [string, string][] = [[promptFile, "/content/h3in_prompt.txt"]];
    for (const [index, image] of images.entries()) {
      if (image.type === "url") throw new Error("MiniMax H3 参考图片需为本地数据，不支持远程地址");
      const extension = image.mimeType.split("/")[1]?.replace(/[^a-z0-9]/gi, "") || "png";
      const path = join(directory, `ref${index}.${extension}`);
      await writeFile(path, image.type === "binary" ? image.data : Buffer.from(image.data.replace(/^data:[^,]*,/, ""), "base64"));
      uploads.push([path, `/content/h3in_ref_${index}.${extension}`]);
    }
    await colab(command, ["new", "--session", session, "--gpu", "A100"], signal);
    created = true;
    for (const [local, remote] of uploads) await colab(command, ["upload", "--session", session, local, remote], signal);
    // 53 random bits keep the seed exact as a JavaScript number.
    const seed = crypto.getRandomValues(new Uint32Array(2)).reduce((high, low) => (high & 0x1fffff) * 2 ** 32 + low);
    const env = { H3_SEED: seed, H3_RESOLUTION: resolution, H3_RATIO: ratio, H3_DURATION: duration, H3_AUDIO: audio ? 1 : 0 };
    const output = await colab(command, [
      "exec", "--session", session, "--timeout", "7200",
      ...Object.entries(env).flatMap(([name, value]) => ["--env", `${name}=${value}`]),
      "--file", script,
    ], signal);
    if (!output.includes("COLAB_DONE")) throw new Error(`MiniMax H3 生成失败：${output.trim().slice(-2000)}`);
    const video = join(directory, "final.mp4");
    await colab(command, ["download", "--session", session, "/content/h3out/final.mp4", video], signal);
    return { data: new Uint8Array(await readFile(video)), mimeType: "video/mp4" as const };
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    // ACT: A session that failed to start may not exist, so stop errors are only fatal once `new` succeeded.
    // A failed stop keeps the A100 billing, so it is never swallowed; the original error stays as its cause.
    const stopped = await colab(command, ["stop", "--session", session]).then(() => true, () => !created);
    await rm(directory, { recursive: true, force: true });
    if (!stopped) throw new Error(`Colab 工作阶段 ${session} 未能关闭，请执行 colab stop --session ${session}，以免持续消耗算力`, { cause: failure });
  }
}
