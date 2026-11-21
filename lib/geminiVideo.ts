/**
 * Server-only fallback when YouTube blocks caption requests from cloud servers: Gemini reads the public
 * YouTube video itself (Google fetches it) and returns a timestamped transcript.
 *
 * One request for a whole long video can take longer than the server's time limit, so the video is read in
 * 10-minute parts, several at a time, and the parts are joined.
 */
import { geminiFetch } from "./gemini.ts";
import { parseTranscript } from "./transcript.ts";
import type { Sentence } from "./types.ts";

export function geminiKey(): string | undefined {
  return process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || undefined;
}

export const PART_SECONDS = 600;
const MAX_PARTS = 18; // 3 hours
const UNKNOWN_LENGTH_PARTS = 6; // when YouTube won't say how long the video is: read the first hour
const PARALLEL = 4; // stays inside Gemini's free per-minute request limit
const TIME_BUDGET_MS = 270_000; // leave room inside the route's 300 s limit

const clock = (s: number) => {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}` : `${m}:${String(sec).padStart(2, "0")}`;
};

function prompt(start: number, end: number, first: boolean): string {
  return `Transcribe everything spoken in this part of the video (from ${clock(start)} to ${clock(end)}), in the language it is spoken.
Output format, and nothing else:
${first ? "TITLE: <the video's title or topic>\n" : ""}[m:ss] <sentence>
[m:ss] <sentence>
Rules: one sentence per line; each line starts with the exact time that sentence starts, counted from the start of the whole video
([h:mm:ss] after one hour); keep the speaker's exact words; no summaries, no speaker labels, no commentary.
If nothing is spoken in this part, or the video ends before ${clock(start)}, output only: NONE`;
}

class GeminiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

async function errorFrom(res: Response): Promise<GeminiError> {
  const errBody = await res.text().catch(() => "");
  let detail = errBody.slice(0, 300);
  try {
    detail = JSON.parse(errBody).error?.message ?? detail;
  } catch {
    /* not JSON */
  }
  if (res.status === 503 || res.status === 500)
    return new GeminiError("Gemini is overloaded right now (Google's servers are busy). Wait a minute and try again, or paste the transcript under Clip settings.", res.status);
  if (res.status === 429) return new GeminiError("Gemini's free daily limit for YouTube videos was reached. Paste the transcript instead, or try tomorrow.", 429);
  return new GeminiError(`Gemini couldn't read this video (${res.status}): ${detail}`, res.status);
}

/** Puts a part's sentences on the whole video's clock, whether Gemini counted from the video start or the part start. */
export function placePart(sentences: Sentence[], start: number, end: number): Sentence[] {
  if (!sentences.length) return [];
  const relative = start > 0 && sentences[sentences.length - 1].start < start - 5;
  const shift = relative ? start : 0;
  return sentences
    .map((s) => ({ ...s, start: s.start + shift, end: s.end + shift, words: s.words.map((w) => ({ ...w, start: w.start + shift, end: w.end + shift })) }))
    .filter((s) => s.start >= start - 2 && s.start < end + 2);
}

/** Joins the parts in time order, dropping a sentence repeated across a part boundary. */
export function joinParts(parts: Sentence[][]): Sentence[] {
  const all = parts.flat().sort((a, b) => a.start - b.start);
  const out: Sentence[] = [];
  for (const s of all) {
    const prev = out[out.length - 1];
    if (prev && Math.abs(prev.start - s.start) < 3 && prev.text.toLowerCase() === s.text.toLowerCase()) continue;
    if (prev && prev.end > s.start) prev.end = s.start;
    out.push(s);
  }
  return out;
}

async function readPart(videoId: string, start: number, end: number, first: boolean, key: string, model: string, signal: AbortSignal) {
  const body = {
    contents: [
      {
        role: "user",
        parts: [
          // One frame every 10 s at low resolution keeps the request small; speech is what matters.
          {
            fileData: { fileUri: `https://www.youtube.com/watch?v=${videoId}` },
            videoMetadata: { fps: 0.1, startOffset: `${start}s`, endOffset: `${end}s` },
          },
          { text: prompt(start, end, first) },
        ],
      },
    ],
    generationConfig: { mediaResolution: "MEDIA_RESOLUTION_LOW", maxOutputTokens: 32768, temperature: 0 },
  };
  const { res } = await geminiFetch(model, "generateContent", body, key, signal);
  if (!res.ok) throw await errorFrom(res);
  const data = await res.json();
  const text: string = (data.candidates?.[0]?.content?.parts ?? []).filter((p: { thought?: boolean }) => !p.thought).map((p: { text?: string }) => p.text ?? "").join("");
  const title = text.match(/^\s*TITLE:\s*(.+)$/m)?.[1]?.trim() ?? "";
  if (/^\s*NONE\s*$/.test(text.replace(/^\s*TITLE:.*$/m, ""))) return { title, sentences: [] as Sentence[] };
  return { title, sentences: placePart(parseTranscript(text.replace(/^\s*TITLE:.*$/m, "")), start, end) };
}

export async function transcribeYouTubeWithGemini(
  videoId: string, signal?: AbortSignal, durationSeconds = 0,
): Promise<{ title: string; sentences: Sentence[] }> {
  const key = geminiKey();
  if (!key) throw new Error("no Gemini key");
  const model = process.env.VIRALCUT_TRANSCRIBE_MODEL || "gemini-flash-latest";

  const count = durationSeconds > 0 ? Math.min(Math.ceil(durationSeconds / PART_SECONDS), MAX_PARTS) : UNKNOWN_LENGTH_PARTS;
  const ranges = Array.from({ length: count }, (_, i) => {
    const start = i * PART_SECONDS;
    const end = durationSeconds > 0 ? Math.min(start + PART_SECONDS, Math.ceil(durationSeconds)) : start + PART_SECONDS;
    return { start, end };
  });

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIME_BUDGET_MS);
  signal?.addEventListener("abort", () => ctl.abort());

  const results: ({ title: string; sentences: Sentence[] } | null)[] = ranges.map(() => null);
  const errors: GeminiError[] = [];
  let next = 0;
  const worker = async () => {
    while (next < ranges.length && !ctl.signal.aborted) {
      const i = next++;
      try {
        results[i] = await readPart(videoId, ranges[i].start, ranges[i].end, i === 0, key, model, ctl.signal);
        // An empty part with no known length means the video has ended: skip the parts after it.
        if (!durationSeconds && !results[i]!.sentences.length) next = Math.max(next, ranges.length);
      } catch (err) {
        if ((err as Error).name === "AbortError") return;
        // A part that starts after the video ends comes back as "empty or malformed" media: the video is over.
        if (i > 0 && err instanceof GeminiError && err.status === 400 && /empty|malformed|corrupt|offset|duration/i.test(err.message)) {
          results[i] = { title: "", sentences: [] };
          if (!durationSeconds) next = Math.max(next, ranges.length);
          continue;
        }
        console.warn(`gemini part ${clock(ranges[i].start)}-${clock(ranges[i].end)} failed:`, (err as Error).message);
        errors.push(err instanceof GeminiError ? err : new GeminiError((err as Error).message, 0));
        // A bad key, or a video Gemini can't open at all (first part), fails every part the same way: stop early.
        if (err instanceof GeminiError && ([401, 403].includes(err.status) || (err.status === 400 && i === 0))) ctl.abort();
      }
    }
  };
  try {
    await Promise.all(Array.from({ length: Math.min(PARALLEL, ranges.length) }, worker));
  } finally {
    clearTimeout(timer);
  }

  const done = results.filter((r): r is { title: string; sentences: Sentence[] } => r !== null);
  const sentences = joinParts(done.map((r) => r.sentences));
  if (sentences.length < 2) {
    if (errors.length) throw errors[0];
    if (ctl.signal.aborted) throw new GeminiError("Reading this video took too long. Paste the transcript under Clip settings and try again.", 504);
    throw new Error("Gemini couldn't find speech in this video.");
  }
  const missing = results.filter((r) => r === null).length;
  if (missing) console.warn(`gemini transcript: ${missing} of ${ranges.length} parts missing (${errors.length} failed)`);
  return { title: done[0]?.title ?? "", sentences };
}
