/**
 * Browser-only: talk to the ViralCut app running on the viewer's own computer. YouTube blocks cloud servers,
 * so the app downloads the video locally and hands it to the website, which then creates the shorts.
 */
// The app takes 8000, or the first free port up to 8019 when 8000 is busy.
const PORTS = Array.from({ length: 20 }, (_, i) => 8000 + i);
export const HELPER_DOWNLOAD_URL = "https://github.com/Nandika-Gupta/ViralCut/releases/latest";

let found: string | null = null;
// Chrome's Local Network Access names this computer's address space "loopback" (it may ask the viewer once).
// Browsers that don't know the option get a plain request.
let space: Record<string, string> = { targetAddressSpace: "loopback" };

async function localFetch(url: string, init: RequestInit = {}): Promise<Response> {
  try {
    return await fetch(url, { ...init, ...space } as RequestInit);
  } catch (err) {
    if ((err as Error).name === "AbortError" || !Object.keys(space).length) throw err;
    const res = await fetch(url, init);
    space = {};
    return res;
  }
}

/** The helper's address, or null when the app isn't running (or the browser blocked local access). */
export async function findHelper(): Promise<string | null> {
  const candidates = found ? [found] : PORTS.map((p) => `http://127.0.0.1:${p}`);
  // Ask every port at once: a closed port answers instantly, so this takes as long as the slowest one.
  const ping = async (base: string) => {
    const ctl = new AbortController();
    const t = window.setTimeout(() => ctl.abort(), 2500);
    try {
      const res = await localFetch(`${base}/api/helper/ping`, { signal: ctl.signal });
      if (res.ok && (await res.json()).app === "viralcut-helper") return base;
    } catch {
      /* not running on this port */
    } finally {
      window.clearTimeout(t);
    }
    throw new Error("no helper");
  };
  try {
    found = await Promise.any(candidates.map(ping));
    return found;
  } catch {
    found = null;
    return null;
  }
}

/** Download the video through the helper. Reports progress once the file starts arriving. */
export async function downloadWithHelper(
  base: string, url: string, onStatus: (msg: string, fraction: number | null) => void, signal?: AbortSignal,
): Promise<{ file: File; title: string }> {
  onStatus("Downloading the video on your computer (ViralCut app)…", null);
  const res = await localFetch(`${base}/api/helper/download`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url }),
    signal,
  });
  if (!res.ok || !res.body) {
    const err = await res.json().catch(() => ({ detail: `Download failed (${res.status})` }));
    throw new Error(err.detail || `Download failed (${res.status})`);
  }
  const total = Number(res.headers.get("Content-Length")) || 0;
  const reader = res.body.getReader();
  const parts: BlobPart[] = [];
  let received = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    parts.push(value);
    received += value.length;
    onStatus(`Loading the video into ViralCut · ${(received / 1e6).toFixed(0)} MB`, total ? received / total : null);
  }
  const title = decodeURIComponent(res.headers.get("X-Video-Title") || "");
  return { file: new File(parts, "video.mp4", { type: "video/mp4" }), title };
}
