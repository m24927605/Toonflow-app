import { devNull, homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { lstat, mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from "@toonflow/file";
import { findCommand } from "@/utils/cli";

export type ColabJob = {
  /** Python source executed on the session; it must print COLAB_DONE once every output is written. */
  script: string;
  /** Files written to /content/<name> before the script runs. */
  uploads: { name: string; data: string | Uint8Array }[];
  /** Plain-token environment variables for the script. */
  env: Record<string, string | number>;
  /** Absolute remote paths downloaded after the script succeeds, in order. */
  outputs: string[];
};

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
 * Runs one script on a fresh Colab A100 session with the user's local Colab CLI login and returns the downloaded
 * outputs. The session is always stopped. Toonflow never reads or forwards the Colab credentials.
 */
export async function runColabJob({ script, uploads, env, outputs }: ColabJob, signal?: AbortSignal) {
  // Every value below reaches argv, so only plain tokens are accepted; free text travels as uploaded files.
  for (const { name } of uploads) if (!/^[\w.-]+$/.test(name)) throw new Error(`Colab 上传文件名无效：${name}`);
  for (const [name, value] of Object.entries(env)) if (!/^[A-Z][A-Z0-9_]*$/.test(name) || !/^[\w.:-]+$/.test(String(value))) throw new Error(`Colab 环境变量无效：${name}`);
  for (const output of outputs) if (!/^\/content\/[\w./-]+$/.test(output) || output.includes("..")) throw new Error(`Colab 输出路径无效：${output}`);
  const command = findCommand("colab", "未找到 Colab CLI，请先安装 google-colab-cli 并在终端执行 colab sessions 完成 Google 登录");
  await guardColabLog();
  const directory = await mkdtemp(join(tmpdir(), "toonflow-colab-"));
  const session = `toonflow-${crypto.randomUUID().slice(0, 8)}`;
  let created = false;
  let failure: unknown;
  try {
    const scriptPath = join(directory, "job.py");
    await writeFile(scriptPath, script);
    const files: [string, string][] = [];
    for (const [index, { name, data }] of uploads.entries()) {
      const path = join(directory, `upload${index}`);
      await writeFile(path, data);
      files.push([path, `/content/${name}`]);
    }
    await colab(command, ["new", "--session", session, "--gpu", "A100"], signal);
    created = true;
    for (const [local, remote] of files) await colab(command, ["upload", "--session", session, local, remote], signal);
    const output = await colab(command, [
      "exec", "--session", session, "--timeout", "7200",
      ...Object.entries(env).flatMap(([name, value]) => ["--env", `${name}=${value}`]),
      "--file", scriptPath,
    ], signal);
    if (!output.includes("COLAB_DONE")) throw new Error(`Colab 任务失败：${output.trim().slice(-2000)}`);
    const results: Uint8Array[] = [];
    for (const [index, remote] of outputs.entries()) {
      const local = join(directory, `output${index}`);
      await colab(command, ["download", "--session", session, remote, local], signal);
      results.push(new Uint8Array(await readFile(local)));
    }
    return results;
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

/** A random seed with 53 bits, so it stays exact as a JavaScript number. */
export function randomSeed() {
  return crypto.getRandomValues(new Uint32Array(2)).reduce((high, low) => (high & 0x1fffff) * 2 ** 32 + low);
}

/** Decodes a provider media input into bytes for upload; remote URLs are rejected so nothing is fetched on the host. */
export function inputBytes(input: MediaInput) {
  if (input.type === "url") throw new Error("Colab 参考素材需为本地数据，不支持远程地址");
  return input.type === "binary" ? input.data : Buffer.from(input.data.replace(/^data:[^,]*,/, ""), "base64");
}

/** File extension for an uploaded image, limited to plain characters. */
export function inputExtension(input: MediaInput) {
  return input.mimeType?.split("/")[1]?.replace(/[^a-z0-9]/gi, "") || "png";
}
