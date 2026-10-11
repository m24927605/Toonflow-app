const rules = [
  {
    type: "input",
    field: "apiKey" as const,
    title: "API Key",
    value: "",
    props: { type: "password", showPassword: true, autocomplete: "off" },
  },
] as const;

const version = "1.1.0";
const baseUrl = "https://api.sunoapi.org/api/v1";
const failures = new Set(["CREATE_TASK_FAILED", "GENERATE_AUDIO_FAILED", "SENSITIVE_WORD_ERROR"]);
// The API insists on a callback URL. A reserved .invalid host (RFC 6761) never resolves, so results are only read by polling
// and never sent to any other server; the failed callback then shows up as CALLBACK_EXCEPTION after the audio is done.
const callBackUrl = "https://callback.invalid/";

type TaskRecord = { data?: { status?: string; errorMessage?: string; response?: { sunoData?: { audio_url?: string }[] } } };

function wait(signal: AbortSignal, ms: number) {
  signal.throwIfAborted();
  return new Promise<void>((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, ms);
    signal.addEventListener("abort", abort, { once: true });
  });
}

export default {
  id: "suno",
  label: "Suno",
  version,
  readme: "Instrumental music, scores and sound effects with Suno V6 through [sunoapi.org](https://sunoapi.org). Create an API key at sunoapi.org/api-key; enter `env:VARIABLE_NAME` to read it from the Toonflow process environment or `~/.env` instead of storing it.\n\nThe prompt is the music style description (genre, instruments, tempo, structure over time, up to 1000 characters) and the duration setting sets the length (10–360 seconds). The sound effect models create a sound effect instead of music from a description of up to 500 characters, such as a creature roar or an explosion; Suno picks the length and the duration setting is ignored. Each run returns the variations Suno makes, all saved to the node folder; files on Suno's side expire after 14 days. Runs use the credits of your sunoapi.org account.",
  rules,
  models: [
    { id: "V6", label: "Suno V6 (music)", type: "audio" },
    { id: "V6_WILD", label: "Suno V6 Wild (music)", type: "audio" },
    { id: "V6_MINI", label: "Suno V6 Mini (music)", type: "audio" },
    { id: "sounds_V6", label: "Suno V6 (sound effects)", type: "audio" },
    { id: "sounds_V6_WILD", label: "Suno V6 Wild (sound effects)", type: "audio" },
  ] satisfies ProviderModel[],
  async generateAudio(request: AudioRequest): Promise<MediaAsset[]> {
    const apiKey = this.config.apiKey?.trim();
    if (!apiKey) throw new Error("Enter the API key");
    const prompt = (request.prompt ?? request.text ?? "").trim();
    const sound = request.model.startsWith("sounds_");
    let body: Record<string, unknown>;
    if (sound) {
      if (!prompt) throw new Error("Enter a sound effect description");
      if (prompt.length > 500) throw new Error("Suno sound effect descriptions are limited to 500 characters");
      body = { prompt, model: request.model.slice("sounds_".length), callBackUrl };
    } else {
      if (!prompt) throw new Error("Enter a music style description");
      if (prompt.length > 1000) throw new Error("Suno style descriptions are limited to 1000 characters");
      const duration = request.duration ?? 30;
      if (!Number.isInteger(duration) || duration < 10 || duration > 360) throw new Error("Suno duration must be a whole number from 10 to 360 seconds");
      body = { customMode: true, instrumental: true, model: request.model, style: prompt, title: "Toonflow", duration, callBackUrl };
    }
    // ACT: Instrumental only; songs with lyrics need a lyrics field in the audio node first.
    // Wait at most 10 minutes per generation.
    const signal = AbortSignal.any([AbortSignal.timeout(10 * 60_000), ...(this.signal ? [this.signal] : [])]);
    const headers = { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" };
    const submit = await this.tool.fetch(`${baseUrl}/generate${sound ? "/sounds" : ""}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal,
    });
    if (!submit.ok) throw new Error(`Task submission failed: HTTP ${submit.status}`);
    const submitted = await submit.json() as { code?: number; msg?: string; data?: { taskId?: string } };
    const taskId = submitted.data?.taskId;
    if (submitted.code !== 200 || !taskId) throw new Error(submitted.msg || "Task submission returned no task ID");
    while (true) {
      await wait(signal, 5000);
      const response = await this.tool.fetch(`${baseUrl}/generate/record-info?taskId=${encodeURIComponent(taskId)}`, { headers, signal });
      if (!response.ok) throw new Error(`Task status request failed: HTTP ${response.status}`);
      const record = await response.json() as TaskRecord;
      const status = record.data?.status ?? "";
      if (failures.has(status)) throw new Error(record.data?.errorMessage || `Suno generation failed: ${status}`);
      const tracks = record.data?.response?.sunoData ?? [];
      const urls = tracks.flatMap(track => track.audio_url ? [track.audio_url] : []);
      // A failed early callback can report CALLBACK_EXCEPTION before the tracks finish; keep polling until audio exists.
      if (status !== "SUCCESS" && !(status === "CALLBACK_EXCEPTION" && urls.length && urls.length === tracks.length)) continue;
      if (!urls.length || urls.length < tracks.length) throw new Error("Suno generation succeeded but returned no audio URL");
      return urls.map(url => ({ mediaType: "audio" as const, type: "url" as const, url }));
    }
  },
} satisfies ProviderDefinition<typeof rules>;
