import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp, rm, writeFile } from "@toonflow/file";
import type { ProviderTools } from "@toonflow/providers";
import { findCommand } from "@/utils/cli";

export type HiggsfieldRequest = Parameters<ProviderTools["higgsfield"]>[0];

const mediaFlags = new Set(["image-references", "video-references", "audio-references", "start-image", "end-image"]);
// Params share the flag namespace with the CLI's own options, so these names are reserved.
const reservedParams = new Set(["prompt", "wait", "json", "help", "no_color"]);

/**
 * Runs one `higgsfield generate create ... --wait --json` job with the user's local CLI login and returns the
 * result URL. Toonflow never reads or forwards the Higgsfield credentials.
 */
export async function runHiggsfield({ jobType, prompt, params = {}, media = {} }: HiggsfieldRequest, signal?: AbortSignal) {
  // Provider files may only choose a job type, schema params and the fixed media flags, never arbitrary CLI options.
  if (!/^[a-z0-9_]+$/.test(jobType)) throw new Error("Higgsfield 模型 ID 无效");
  const command = findCommand("higgsfield", "未找到 Higgsfield CLI，请先在运行 Toonflow 的电脑上安装并执行 higgsfield auth login");
  // Free text never goes into argv: on Windows the npm `.cmd` shim runs through cmd.exe, which would re-parse it.
  // The prompt goes through stdin and param values are limited to plain tokens such as 16:9, 720p or 5.
  const args = [command, "generate", "create", jobType];
  for (const [name, value] of Object.entries(params)) {
    if (!/^[a-z][a-z0-9_]*$/.test(name) || reservedParams.has(name)) throw new Error(`Higgsfield 参数名无效：${name}`);
    if (!/^[\w.:-]+$/.test(String(value))) throw new Error(`Higgsfield 参数值无效：${name}`);
    args.push(`--${name}=${value}`);
  }
  const directory = await mkdtemp(join(tmpdir(), "toonflow-higgsfield-"));
  try {
    let index = 0;
    for (const [flag, inputs] of Object.entries(media)) {
      if (!mediaFlags.has(flag)) throw new Error(`Higgsfield 素材参数无效：${flag}`);
      for (const input of inputs) {
        if (input.type === "url") throw new Error("Higgsfield 参考素材需为本地数据，不支持远程地址");
        const extension = input.mimeType.split("/")[1]?.replace(/[^a-z0-9]/gi, "") || "bin";
        const path = join(directory, `${index++}.${extension}`);
        await writeFile(path, input.type === "binary" ? input.data : Buffer.from(input.data.replace(/^data:[^,]*,/, ""), "base64"));
        // The CLI only recognises its own flags in the "--flag value" form; temp paths never start with "-".
        args.push(`--${flag}`, path);
      }
    }
    args.push("--wait", "--wait-timeout", "30m", "--json");
    const child = Bun.spawn(args, { env: { ...process.env, HIGGSFIELD_DISABLE_TELEMETRY: "1" }, stdin: new Blob([prompt]), stdout: "pipe", stderr: "pipe", signal });
    const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
    await child.exited;
    signal?.throwIfAborted();
    if (child.exitCode !== 0) throw new Error(stderr.trim() || stdout.trim() || `Higgsfield CLI 异常退出（${child.exitCode}）`);
    // ACT: The exact `--wait --json` output shape is undocumented; accept one JSON document or one per line and
    // take the last job that carries a result_url. Pin this to the documented shape once Higgsfield publishes it.
    const values = (() => {
      try { return [JSON.parse(stdout)]; }
      catch { return stdout.split("\n").filter(line => /^\s*[[{]/.test(line)).map(line => JSON.parse(line)); }
    })().flat() as { status?: string; result_url?: string }[];
    const job = values.findLast(item => typeof item?.result_url === "string" && item.result_url);
    if (!job?.result_url) throw new Error(`Higgsfield 未返回生成结果${values.at(-1)?.status ? `（${values.at(-1)!.status}）` : ""}`);
    return { url: job.result_url };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
