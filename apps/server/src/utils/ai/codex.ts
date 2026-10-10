import { dirname, resolve } from "node:path";
import { ModelRuntime, readStoredCredential } from "@earendil-works/pi-coding-agent";
import conf from "@/utils/conf";

/** Pi's built-in Codex provider ID; text model settings reuse it so agents get the built-in models and OAuth refresh. */
export const codexProviderId = "openai-codex";

const authPath = resolve(dirname(conf.path), "auth.json");

type LoginSession = { controller: AbortController; done: Promise<void>; submit?: (code: string) => void; error?: string };
let login: LoginSession | undefined;

export function createCodexRuntime() {
  // ACT: Pi stores credentials in auth.json in the data directory (mode 0600, cross-instance file lock) and refreshes
  // them on demand; they stay out of settings, which the frontend overwrites as a whole.
  return ModelRuntime.create({ authPath, modelsPath: null, refreshOnCreate: false });
}

export async function startCodexLogin() {
  login?.controller.abort();
  const controller = new AbortController();
  // ACT: Abandon an unfinished login after 10 minutes to free the local callback port 1455.
  const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(600000)]);
  const runtime = await createCodexRuntime();
  const authUrl = Promise.withResolvers<string>();
  const session: LoginSession = { controller, done: Promise.resolve() };
  login = session;
  session.done = runtime.login(codexProviderId, "oauth", {
    signal,
    notify: event => { if (event.type === "auth_url") authUrl.resolve(event.url); },
    prompt: prompt => {
      if (prompt.type === "select") return Promise.resolve("browser");
      if (prompt.type !== "manual_code") return Promise.reject(new Error("不支持的登录步骤"));
      return new Promise((resolve, reject) => {
        session.submit = resolve;
        const abort = () => reject(new Error("登录已取消"));
        signal.addEventListener("abort", abort, { once: true });
        prompt.signal?.addEventListener("abort", abort, { once: true });
      });
    },
  }).then(() => {
    if (login === session) login = undefined;
  }, (error: unknown) => {
    session.error = signal.aborted && !controller.signal.aborted ? "登录超时，请重新登录" : error instanceof Error ? error.message : "登录失败";
    authUrl.reject(Object.assign(new Error(session.error), { status: 400 }));
    throw Object.assign(new Error(session.error), { status: 400 });
  });
  session.done.catch(() => {});
  return authUrl.promise;
}

/** Completes the login with the redirect URL or code when the browser cannot reach the local callback. */
export async function submitCodexCode(code: string) {
  const session = login;
  if (!session?.submit || session.error) throw Object.assign(new Error("没有等待中的登录，请重新登录"), { status: 409 });
  session.submit(code);
  await session.done;
}

export function getCodexStatus() {
  return { loggedIn: !!readStoredCredential(codexProviderId, authPath), pending: !!login && !login.error, error: login?.error ?? "" };
}

export async function logoutCodex() {
  login?.controller.abort();
  login = undefined;
  await (await createCodexRuntime()).logout(codexProviderId);
}
