import { accessDenied } from "@/lib/access";
import { LlmError, streamPlan } from "@/lib/llm";
import { pickTask, postsTask, type Task } from "@/lib/planner";
import { availableProviders } from "@/lib/providers";
import { PLATFORMS, type ClipRequest, type Platform, type PostsRequest } from "@/lib/types";

export const maxDuration = 300;

const MAX_TRANSCRIPT = 400_000; // characters, roughly 4-5 hours of speech

const platformsOf = (list: unknown) =>
  (Array.isArray(list) ? list : []).filter((p): p is Platform => (PLATFORMS as readonly string[]).includes(p));
const text = (v: unknown, max: number, fallback = "") => String(v ?? fallback).slice(0, max);

function pickRequest(body: Partial<ClipRequest>): ClipRequest | string {
  if (typeof body.transcript !== "string" || body.transcript.trim().length < 20) return "The transcript is empty.";
  if (body.transcript.length > MAX_TRANSCRIPT) return "This video is too long. Use a part under about 4 hours.";
  const platforms = platformsOf(body.platforms);
  if (!platforms.length) return "Choose at least one platform.";
  const count = Math.min(Math.max(Math.round(Number(body.count) || 5), 1), 12);
  const minLen = Math.min(Math.max(Number(body.minLen) || 20, 5), 170);
  const maxLen = Math.min(Math.max(Number(body.maxLen) || 60, minLen + 5), 180);
  return {
    transcript: body.transcript, title: text(body.title, 200), count, minLen, maxLen, platforms,
    tone: text(body.tone, 40, "Hype"), language: text(body.language, 80, "the same language as the transcript"),
  };
}

function postsRequest(body: Partial<PostsRequest>): PostsRequest | string {
  const platforms = platformsOf(body.platforms);
  if (!platforms.length) return "Choose at least one platform.";
  if (!body.clip || typeof body.clip.text !== "string" || !body.clip.text.trim()) return "The clip has no transcript.";
  return {
    title: text(body.title, 200),
    clip: { title: text(body.clip.title, 200), hook: text(body.clip.hook, 120), text: text(body.clip.text, 8000) },
    platforms, tone: text(body.tone, 40, "Hype"), language: text(body.language, 80, "the same language as the transcript"),
  };
}

/**
 * Streams NDJSON: {"t":"ping"} right away, {"t":"delta","d":"…"} chunks of the JSON answer, then {"t":"done"} or
 * {"t":"error"}. mode "pick" chooses the clips; mode "posts" writes one clip's posts and hashtags.
 */
export async function POST(req: Request) {
  const denied = accessDenied(req);
  if (denied) return denied;
  const providers = availableProviders();
  if (!providers.length) return Response.json({ error: "No AI API key is set on the server.", code: "no_key" }, { status: 501 });

  let task: Task | string;
  try {
    const body = await req.json();
    const parsed = body?.mode === "posts" ? postsRequest(body) : pickRequest(body);
    task = typeof parsed === "string" ? parsed : body?.mode === "posts" ? postsTask(parsed as PostsRequest) : pickTask(parsed as ClipRequest);
  } catch {
    task = "Send the request as JSON.";
  }
  if (typeof task === "string") return Response.json({ error: task }, { status: 400 });
  const job = task;

  const encoder = new TextEncoder();
  const line = (o: unknown) => encoder.encode(JSON.stringify(o) + "\n");
  const body = new ReadableStream({
    async start(controller) {
      controller.enqueue(line({ t: "ping" })); // send headers now so the platform never sees a silent request
      const keepAlive = setInterval(() => controller.enqueue(line({ t: "ping" })), 15000);
      try {
        let lastError = "";
        for (const provider of providers) {
          let sent = false;
          try {
            await streamPlan(provider, job, (d) => {
              sent = true;
              controller.enqueue(line({ t: "delta", d }));
            }, req.signal);
            controller.enqueue(line({ t: "done", model: `${provider.label} · ${provider.model}` }));
            return;
          } catch (err) {
            if (!(err instanceof LlmError)) console.error(`${provider.label} failed`, err);
            lastError = err instanceof LlmError ? err.message : `${provider.label} is unavailable right now. Try again in a minute.`;
            if (sent || req.signal.aborted) break; // part of an answer already went out: can't switch services mid-answer
          }
        }
        controller.enqueue(line({ t: "error", error: lastError, code: "api_error" }));
      } finally {
        clearInterval(keepAlive);
        controller.close();
      }
    },
  });
  return new Response(body, { headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store, no-transform" } });
}
