/**
 * Server-only fallback when YouTube blocks caption requests from cloud servers: Gemini reads the public
 * YouTube video itself (Google fetches it) and returns a timestamped transcript.
 */
import { geminiFetch } from "./gemini.ts";
import { parseTranscript } from "./transcript.ts";
import type { Sentence } from "./types.ts";

export function geminiKey(): string | undefined {
  return process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || undefined;
}

const PROMPT = `Transcribe everything spoken in this video, in the language it is spoken.
Output format, and nothing else:
TITLE: <the video's title or topic>
[m:ss] <sentence>
[m:ss] <sentence>
Rules: one sentence per line; each line starts with the exact time that sentence starts ([h:mm:ss] after one hour);
keep the speaker's exact words; no summaries, no speaker labels, no commentary.`;

export async function transcribeYouTubeWithGemini(videoId: string, signal?: AbortSignal): Promise<{ title: string; sentences: Sentence[] }> {
  const key = geminiKey();
  if (!key) throw new Error("no Gemini key");
  const model = process.env.VIRALCUT_TRANSCRIBE_MODEL || "gemini-flash-latest";
  const body = {
    contents: [
        {
          role: "user",
          parts: [
            // One frame every 10 s at low resolution keeps long videos inside free-tier token limits; speech is what matters.
            { fileData: { fileUri: `https://www.youtube.com/watch?v=${videoId}` }, videoMetadata: { fps: 0.1 } },
            { text: PROMPT },
          ],
        },
      ],
    generationConfig: { mediaResolution: "MEDIA_RESOLUTION_LOW", maxOutputTokens: 65536, temperature: 0 },
  };
  const { res } = await geminiFetch(model, "generateContent", body, key, signal);
  if (!res.ok) {
    const errBody = await res.text().catch(() => "");
    let detail = errBody.slice(0, 300);
    try {
      detail = JSON.parse(errBody).error?.message ?? detail;
    } catch {
      /* not JSON */
    }
    if (res.status === 503 || res.status === 500) throw new Error("Gemini is overloaded right now (Google's servers are busy). Wait a minute and try again, or paste the transcript under Clip settings.");
    if (res.status === 429) throw new Error("Gemini's free daily limit for YouTube videos was reached. Paste the transcript instead, or try tomorrow.");
    throw new Error(`Gemini couldn't read this video (${res.status}): ${detail}`);
  }
  const data = await res.json();
  const text: string = (data.candidates?.[0]?.content?.parts ?? []).filter((p: { thought?: boolean }) => !p.thought).map((p: { text?: string }) => p.text ?? "").join("");
  const title = text.match(/^\s*TITLE:\s*(.+)$/m)?.[1]?.trim() ?? "";
  const sentences = parseTranscript(text.replace(/^\s*TITLE:.*$/m, ""));
  if (sentences.length < 2) throw new Error("Gemini couldn't find speech in this video.");
  return { title, sentences };
}
