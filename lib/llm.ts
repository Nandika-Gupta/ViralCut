/** Server-only: stream one JSON answer from Gemini, Groq or Claude as plain text chunks. */
import Anthropic from "@anthropic-ai/sdk";

import { geminiFetch } from "./gemini.ts";
import { SYSTEM, type Task } from "./planner.ts";
import type { Provider } from "./providers.ts";

export class LlmError extends Error {}

type Emit = (text: string) => void;

async function failure(res: Response, service: string): Promise<LlmError> {
  const body = await res.text().catch(() => "");
  let detail = body.slice(0, 300);
  try {
    detail = JSON.parse(body).error?.message ?? detail;
  } catch {
    /* not JSON */
  }
  if (res.status === 401 || res.status === 403 || /api key/i.test(detail)) return new LlmError(`The server's ${service} API key is invalid.`);
  if (res.status === 503 || res.status === 500) return new LlmError(`${service} is overloaded right now (Google's servers are busy). Wait a minute and click Generate Clips again.`);
  if (res.status === 429) return new LlmError(`${service} free-tier limit reached. Wait a minute and try again, or use a shorter video.`);
  if (res.status === 413 || /too large|context|tokens/i.test(detail)) return new LlmError(`This transcript is too long for ${service}'s limits. Try a shorter video${service === "Groq" ? " or use a Gemini key" : ""}.`);
  return new LlmError(`${service} error (${res.status}): ${detail}`);
}

async function* sseData(res: Response): AsyncGenerator<string> {
  const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += value;
    const events = buf.split(/\r?\n\r?\n/);
    buf = events.pop() ?? "";
    for (const ev of events) {
      const data = ev.split(/\r?\n/).filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join("");
      if (data) yield data;
    }
  }
}

async function gemini(p: Provider, task: Task, emit: Emit, signal: AbortSignal): Promise<void> {
  const { res } = await geminiFetch(
    p.model,
    "streamGenerateContent?alt=sse",
    {
      systemInstruction: { parts: [{ text: SYSTEM }] },
      contents: [{ role: "user", parts: [{ text: `${task.prompt}\n\n${task.shape}` }] }],
      generationConfig: { responseMimeType: "application/json", maxOutputTokens: 32768, temperature: 0.7 },
    },
    p.key,
    signal,
  );
  if (!res.ok || !res.body) throw await failure(res, "Gemini");
  let finish = "";
  for await (const data of sseData(res)) {
    const chunk = JSON.parse(data);
    if (chunk.error) throw new LlmError(`Gemini error: ${chunk.error.message}`);
    const cand = chunk.candidates?.[0];
    for (const part of cand?.content?.parts ?? []) if (part.text && !part.thought) emit(part.text);
    if (cand?.finishReason) finish = cand.finishReason;
    if (chunk.promptFeedback?.blockReason) throw new LlmError("Gemini declined to work with this video.");
  }
  if (finish === "MAX_TOKENS") throw new LlmError("The answer was too long. Choose fewer clips or platforms.");
  if (finish === "SAFETY" || finish === "PROHIBITED_CONTENT") throw new LlmError("Gemini declined to work with this video.");
}

async function groq(p: Provider, task: Task, emit: Emit, signal: AbortSignal): Promise<void> {
  // Groq's JSON mode doesn't stream, so the whole answer arrives at once.
  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    signal,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${p.key}` },
    body: JSON.stringify({
      model: p.model,
      messages: [
        { role: "system", content: SYSTEM },
        { role: "user", content: `${task.prompt}\n\n${task.shape}` },
      ],
      response_format: { type: "json_object" },
      temperature: 0.7,
      max_completion_tokens: 16000,
    }),
  });
  if (!res.ok) throw await failure(res, "Groq");
  const data = await res.json();
  const choice = data.choices?.[0];
  if (choice?.finish_reason === "length") throw new LlmError("The answer was too long. Choose fewer clips or platforms.");
  const text = choice?.message?.content;
  if (!text) throw new LlmError("Groq returned an empty answer. Try again.");
  emit(text);
}

async function claude(p: Provider, task: Task, emit: Emit, signal: AbortSignal): Promise<void> {
  const client = new Anthropic({ apiKey: p.key });
  try {
    const stream = client.beta.messages.stream(
      {
        model: p.model,
        max_tokens: 32000,
        system: SYSTEM,
        messages: [{ role: "user", content: task.prompt }],
        output_config: { effort: "medium", format: { type: "json_schema", schema: task.schema } },
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
      },
      { signal },
    );
    for await (const event of stream) {
      if (event.type === "content_block_delta" && event.delta.type === "text_delta") emit(event.delta.text);
    }
    const final = await stream.finalMessage();
    if (final.stop_reason === "refusal") throw new LlmError("Claude declined to work with this video.");
    if (final.stop_reason === "max_tokens") throw new LlmError("The answer was too long. Choose fewer clips or platforms.");
  } catch (err) {
    if (err instanceof LlmError) throw err;
    if (err instanceof Anthropic.AuthenticationError) throw new LlmError("The server's Claude API key is invalid.");
    if (err instanceof Anthropic.RateLimitError) throw new LlmError("Claude rate limit reached. Wait a minute and try again.");
    if (err instanceof Anthropic.BadRequestError) throw new LlmError(`Claude rejected the request: ${err.message}`);
    throw err;
  }
}

export function streamPlan(p: Provider, task: Task, emit: Emit, signal: AbortSignal): Promise<void> {
  if (p.name === "gemini") return gemini(p, task, emit, signal);
  if (p.name === "groq") return groq(p, task, emit, signal);
  return claude(p, task, emit, signal);
}
