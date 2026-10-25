import Anthropic from "@anthropic-ai/sdk";

import { accessDenied } from "@/lib/access";
import { MODEL, SYSTEM, planPrompt, planSchema } from "@/lib/planner";
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
  if (!process.env.ANTHROPIC_API_KEY) {
    return Response.json({ error: "No Claude API key is set on the server.", code: "no_key" }, { status: 501 });
  }
  let parsed: ClipRequest | string;
  try {
    parsed = validate(await req.json());
  } catch {
    parsed = "Send the request as JSON.";
  }
  if (typeof parsed === "string") return Response.json({ error: parsed }, { status: 400 });
  const request = parsed;

  const client = new Anthropic();
  const encoder = new TextEncoder();
  const line = (o: unknown) => encoder.encode(JSON.stringify(o) + "\n");

  const body = new ReadableStream({
    async start(controller) {
      try {
        const stream = client.beta.messages.stream(
          {
            model: MODEL,
            max_tokens: 32000,
            system: SYSTEM,
            messages: [{ role: "user", content: planPrompt(request) }],
            output_config: { effort: "medium", format: { type: "json_schema", schema: planSchema(request.platforms) } },
            betas: ["server-side-fallback-2026-07-01"],
            fallbacks: "default",
          },
          { signal: req.signal },
        );
        for await (const event of stream) {
          if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
            controller.enqueue(line({ t: "delta", d: event.delta.text }));
          }
        }
        const final = await stream.finalMessage();
        if (final.stop_reason === "refusal") {
          controller.enqueue(line({ t: "error", error: "Claude declined to work with this video.", code: "refused" }));
        } else if (final.stop_reason === "max_tokens") {
          controller.enqueue(line({ t: "error", error: "The answer was too long. Choose fewer clips or platforms.", code: "too_long" }));
        } else {
          controller.enqueue(line({ t: "done", model: final.model }));
        }
      } catch (err) {
        let message = "Claude is unavailable right now. Try again in a minute.";
        if (err instanceof Anthropic.AuthenticationError) message = "The server's Claude API key is invalid.";
        else if (err instanceof Anthropic.RateLimitError) message = "Claude rate limit reached. Wait a minute and try again.";
        else if (err instanceof Anthropic.BadRequestError) message = `Claude rejected the request: ${err.message}`;
        console.error("clips failed", err);
        controller.enqueue(line({ t: "error", error: message, code: "api_error" }));
      } finally {
        controller.close();
      }
    },
  });
  return new Response(body, { headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store" } });
}
