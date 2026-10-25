/**
 * Server-only Gemini request with automatic recovery: Google's free models are often briefly overloaded
 * (503) or rate-limited (429). Retry the chosen model, then try other free Flash models before giving up.
 */
const FALLBACKS = ["gemini-flash-latest", "gemini-2.5-flash", "gemini-flash-lite-latest", "gemini-2.5-flash-lite"];
// Only for local testing against a mock server.
const BASE = process.env.VIRALCUT_GEMINI_BASE || "https://generativelanguage.googleapis.com";
const RETRYABLE = new Set([500, 502, 503, 504]);

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(t);
      reject(new DOMException("Aborted", "AbortError"));
    });
  });

export async function geminiFetch(
  model: string, action: "generateContent" | "streamGenerateContent?alt=sse", body: unknown, key: string, signal?: AbortSignal,
): Promise<{ res: Response; model: string }> {
  const models = [model, ...FALLBACKS.filter((m) => m !== model)];
  let last: Response | null = null;
  for (const m of models) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const res = await fetch(`${BASE}/v1beta/models/${encodeURIComponent(m)}:${action}`, {
        method: "POST",
        signal,
        headers: { "Content-Type": "application/json", "x-goog-api-key": key },
        body: JSON.stringify(body),
      });
      if (res.ok) return { res, model: m };
      last = res;
      if (res.status === 400 || res.status === 401 || res.status === 403) return { res, model: m }; // bad key or request: retrying won't help
      if (!RETRYABLE.has(res.status)) break; // 404 (model gone) or 429 (quota): try the next model
      if (attempt === 0) await sleep(2000, signal);
    }
  }
  return { res: last!, model: models[models.length - 1] };
}
