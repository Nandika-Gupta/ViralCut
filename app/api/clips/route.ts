import { accessDenied } from "@/lib/access";
import { LlmError, streamPlan } from "@/lib/llm";
import { activeProvider } from "@/lib/providers";
import { PLATFORMS, type ClipRequest, type Platform } from "@/lib/types";

export const maxDuration = 300;

const MAX_TRANSCRIPT = 400_000; // characters, roughly 4-5 hours of speech

function validate(body: Partial<ClipRequest>): ClipRequest | string {
  if (typeof body.transcript !== "string" || body.transcript.trim().length < 20) return "The transcript is empty.";
  if (body.transcript.length > MAX_TRANSCRIPT) return "This video is too long. Use a part under about 4 hours.";
  const platforms = (body.platforms ?? []).filter((p): p is Platform => (PLATFORMS as readonly string[]).includes(p));
  if (!platforms.length) return "Choose at least one platform.";
  const count = Math.min(Math.max(Math.round(Number(body.count) || 5), 1), 12);
  const minLen = Math.min(Math.max(Number(body.minLen) || 20, 5), 170);
  const maxLen = Math.min(Math.max(Number(body.maxLen) || 60, minLen + 5), 180);
  return {
    transcript: body.transcript,
    title: String(body.title ?? "").slice(0, 200),
    count, minLen, maxLen, platforms,
    tone: String(body.tone ?? "Hype").slice(0, 40),
    language: String(body.language ?? "the same language as the transcript").slice(0, 80),
  };
}

/** Streams NDJSON: {"t":"delta","d":"…"} chunks of the JSON plan, then {"t":"done"} or {"t":"error"}. */
export async function POST(req: Request) {
  const denied = accessDenied(req);
  if (denied) return denied;
  const provider = activeProvider();
  if (!provider) {
    return Response.json({ error: "No AI API key is set on the server.", code: "no_key" }, { status: 501 });
  }
  let parsed: ClipRequest | string;
  try {
    parsed = validate(await req.json());
  } catch {
    parsed = "Send the request as JSON.";
  }
  if (typeof parsed === "string") return Response.json({ error: parsed }, { status: 400 });
  const request = parsed;

  const encoder = new TextEncoder();
  const line = (o: unknown) => encoder.encode(JSON.stringify(o) + "\n");

  const body = new ReadableStream({
    async start(controller) {
      try {
        await streamPlan(provider, request, (d) => controller.enqueue(line({ t: "delta", d })), req.signal);
        controller.enqueue(line({ t: "done", model: `${provider.label} · ${provider.model}` }));
      } catch (err) {
        const message = err instanceof LlmError ? err.message : `${provider.label} is unavailable right now. Try again in a minute.`;
        if (!(err instanceof LlmError)) console.error("clips failed", err);
        controller.enqueue(line({ t: "error", error: message, code: "api_error" }));
      } finally {
        controller.close();
      }
    },
  });
  return new Response(body, { headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store" } });
}
