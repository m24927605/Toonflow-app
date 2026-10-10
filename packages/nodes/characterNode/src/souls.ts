export type SoulKind = "soul_2" | "soul_cinematic";
export type Soul = { id: string; name: string; kind: SoulKind; status: string; failReason: string | null; createdAt: string };

export const soulKinds: Record<SoulKind, string> = { soul_2: "Soul 2.0", soul_cinematic: "Soul Cinematic" };

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { cache: "no-store", ...init, headers: { "x-toonflow-workspace": "1", ...init?.headers } });
  const result = await response.json();
  if (!response.ok || result.code !== 200) throw new Error(result.message || `Higgsfield 请求失败（HTTP ${response.status}）`);
  return result.data;
}

export function listSouls() {
  return request<Soul[]>("/api/higgsfield/souls/list");
}

export function getSoul(id: string) {
  return request<Soul>(`/api/higgsfield/souls/get?id=${encodeURIComponent(id)}`);
}

/** Starts a paid Higgsfield training run from 5–20 workspace images. */
export function createSoul(input: { directory: string; name: string; kind: SoulKind; images: string[] }) {
  return request<Soul>("/api/higgsfield/souls/create", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) });
}
