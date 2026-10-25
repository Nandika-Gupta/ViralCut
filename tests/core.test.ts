import assert from "node:assert/strict";
import { test } from "node:test";

import { findMoments, hashtagsFor, hookStrength, offlinePlan } from "../lib/analysis.ts";
import { buildIcs, nextBestTime } from "../lib/ics.ts";
import { pickTask, postsTask } from "../lib/planner.ts";
import { parseTranscript, snapToSentences, transcriptText, wordsBetween } from "../lib/transcript.ts";
import { youtubeId } from "../lib/youtube.ts";

const SRT = `1
00:00:01,000 --> 00:00:04,000
Why is nobody talking about the AI clipping business?

2
00:00:04,500 --> 00:00:09,000
Creators pay millions every month for short clips.

3
00:00:09,500 --> 00:00:12,000
Here's how it works.

4
00:00:12,500 --> 00:00:20,000
You take one long podcast and turn it into ten viral shorts.

5
00:00:21,000 --> 00:00:30,000
uh so yeah anyway we were just sitting around and stuff
`;

const YT_COPY = `0:00
So today we talk about money.
0:07
Why does nobody price their work right?
1:02:05
That's the end.`;

test("parses SRT into timed sentences", () => {
  const s = parseTranscript(SRT);
  assert.equal(s[0].start, 1);
  assert.match(s[0].text, /^Why is nobody/);
  const words = s.flatMap((x) => x.words);
  assert.ok(words.every((w, i) => i === 0 || words[i - 1].start <= w.start));
});

test("parses a transcript copied from YouTube, including hour marks", () => {
  const s = parseTranscript(YT_COPY);
  assert.equal(s.length, 3);
  assert.equal(s[1].start, 7);
  assert.equal(s[2].start, 3725);
  assert.equal(transcriptText(s).split("\n")[2], "[1:02:05] That's the end.");
});

test("parses inline timestamps and VTT", () => {
  assert.equal(parseTranscript("0:00 hello there friend.\n0:05 second line here.")[1].start, 5);
  const vtt = parseTranscript("WEBVTT\n\n00:00.500 --> 00:02.000\n<v Bob>Hello there world.</v>\n");
  assert.equal(vtt[0].text, "Hello there world.");
});

test("hooks with curiosity score higher", () => {
  assert.ok(hookStrength("Why is nobody talking about this?") > hookStrength("so we were sitting there"));
});

test("finds the hooky moment and never overlaps", () => {
  const s = parseTranscript(SRT);
  const one = findMoments(s, null, 0.25, 1, 8, 20);
  assert.equal(one[0].start, 1);
  const many = findMoments(s, null, 0.25, 3, 4, 12).sort((a, b) => a.start - b.start);
  for (let i = 1; i < many.length; i++) assert.ok(many[i - 1].end <= many[i].start + 0.1 * (many[i].end - many[i].start));
});

test("offline plan writes posts and hashtags for chosen platforms", () => {
  const plan = offlinePlan(parseTranscript(SRT), null, 0.25, "Test", { count: 2, minLen: 5, maxLen: 15, platforms: ["tiktok", "youtube"] });
  assert.ok(plan.clips.length >= 1);
  assert.deepEqual(Object.keys(plan.clips[0].posts).sort(), ["tiktok", "youtube"]);
  assert.ok(plan.clips[0].hashtags.youtube!.includes("#shorts"));
  assert.ok(hashtagsFor("AI clipping business. The AI clipping business pays.").includes("#aiclipping"));
});

test("snaps clips to sentence boundaries within the length limit", () => {
  const s = parseTranscript(SRT);
  const r = snapToSentences(1.3, 11, s, 5, 15);
  assert.equal(r.start, s[0].start);
  assert.ok(r.end - r.start <= 15);
  assert.ok(wordsBetween(s, r.start, r.end).length > 5);
});

test("pick step is small; posts step covers only chosen platforms", () => {
  const pick = pickTask({ transcript: "[0:00] hi", title: "t", count: 3, minLen: 20, maxLen: 60, platforms: ["tiktok"], tone: "Hype", language: "English" }) as any;
  const clip = pick.schema.properties.clips.items;
  assert.equal(clip.additionalProperties, false);
  assert.ok(!("posts" in clip.properties));
  assert.ok(pick.schema.required.includes("hashtag_bank"));
  const posts = postsTask({ title: "t", clip: { title: "c", hook: "h", text: "words" }, platforms: ["tiktok", "x"], tone: "Hype", language: "English" }) as any;
  assert.deepEqual(posts.schema.properties.posts.required, ["tiktok", "x"]);
  assert.match(posts.shape, /"x": \["#tag"\]/);
});

test("youtube link parsing", () => {
  assert.equal(youtubeId("https://youtu.be/dQw4w9WgXcQ?t=3"), "dQw4w9WgXcQ");
  assert.equal(youtubeId("https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=x"), "dQw4w9WgXcQ");
  assert.equal(youtubeId("https://youtube.com/shorts/abcDEF12345"), "abcDEF12345");
  assert.equal(youtubeId("https://vimeo.com/1"), null);
});

test("calendar export and best times", () => {
  const ics = buildIcs([{ id: "1", clipTitle: "A, b", platform: "TikTok", time: "2026-11-01T13:30:00.000Z", caption: "Hi\nthere" }]);
  assert.match(ics, /DTSTART:20261101T133000Z/);
  assert.match(ics, /SUMMARY:Post on TikTok: A\\, b/);
  const t = nextBestTime("tiktok", new Date(2026, 9, 25, 12));
  assert.ok([2, 4, 5].includes(t.getDay()) && t.getHours() === 19);
});

test("extracts JSON from fenced or chatty model answers", async () => {
  const { extractJson } = await import("../lib/json.ts");
  assert.deepEqual(extractJson('{"a":1}'), { a: 1 });
  assert.deepEqual(extractJson('```json\n{"a":2}\n```'), { a: 2 });
  assert.deepEqual(extractJson('Here you go: {"a":3} Enjoy!'), { a: 3 });
  assert.throws(() => extractJson("no json here"));
});

test("provider is picked from whichever key is set", async () => {
  const { activeProvider } = await import("../lib/providers.ts");
  const saved = { ...process.env };
  for (const k of ["GEMINI_API_KEY", "GOOGLE_API_KEY", "GROQ_API_KEY", "ANTHROPIC_API_KEY", "VIRALCUT_PROVIDER", "VIRALCUT_MODEL"]) delete process.env[k];
  assert.equal(activeProvider(), null);
  process.env.GROQ_API_KEY = "g";
  assert.equal(activeProvider()?.name, "groq");
  process.env.GEMINI_API_KEY = "x";
  assert.equal(activeProvider()?.name, "gemini");
  assert.equal(activeProvider()?.model, "gemini-flash-latest");
  process.env.VIRALCUT_PROVIDER = "groq";
  assert.equal(activeProvider()?.name, "groq");
  process.env = saved;
});

test("reads Gemini's streamed answer and Groq's JSON answer", async () => {
  const { streamPlan } = await import("../lib/llm.ts");
  const req = pickTask({ transcript: "[0:00] hi there", title: "t", count: 1, minLen: 5, maxLen: 10, platforms: ["tiktok"], tone: "Hype", language: "English" });
  const realFetch = globalThis.fetch;
  const sse = (chunks: object[]) =>
    new Response(chunks.map((c) => `data: ${JSON.stringify(c)}\r\n\r\n`).join(""), { headers: { "Content-Type": "text/event-stream" } });
  try {
    let sent: any;
    globalThis.fetch = (async (_url: string, init: any) => {
      sent = JSON.parse(init.body);
      return sse([
        { candidates: [{ content: { parts: [{ text: "thinking", thought: true }, { text: '{"title":' }] } }] },
        { candidates: [{ content: { parts: [{ text: '"x"}' }] }, finishReason: "STOP" }] },
      ]);
    }) as typeof fetch;
    let out = "";
    await streamPlan({ name: "gemini", label: "Gemini", model: "m", key: "k" }, req, (t) => (out += t), new AbortController().signal);
    assert.equal(out, '{"title":"x"}');
    assert.equal(sent.generationConfig.responseMimeType, "application/json");

    globalThis.fetch = (async () => Response.json({ choices: [{ message: { content: '{"ok":1}' }, finish_reason: "stop" }] })) as typeof fetch;
    out = "";
    await streamPlan({ name: "groq", label: "Groq", model: "m", key: "k" }, req, (t) => (out += t), new AbortController().signal);
    assert.equal(out, '{"ok":1}');

    globalThis.fetch = (async () => new Response(JSON.stringify({ error: { message: "API key not valid" } }), { status: 400 })) as typeof fetch;
    await assert.rejects(streamPlan({ name: "gemini", label: "Gemini", model: "m", key: "k" }, req, () => {}, new AbortController().signal), /API key is invalid/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("Gemini video transcript is parsed into timed sentences", async () => {
  const { transcribeYouTubeWithGemini } = await import("../lib/geminiVideo.ts");
  const realFetch = globalThis.fetch;
  const saved = process.env.GEMINI_API_KEY;
  process.env.GEMINI_API_KEY = "k";
  let sent: any;
  try {
    globalThis.fetch = (async (_u: string, init: any) => {
      sent = JSON.parse(init.body);
      return Response.json({ candidates: [{ content: { parts: [{ text: "TITLE: My Talk\n[0:00] Why does nobody price right?\n[0:06] Here is the secret.\n[1:02:03] The end." }] } }] });
    }) as typeof fetch;
    const t = await transcribeYouTubeWithGemini("RKF42sgl8QQ");
    assert.equal(t.title, "My Talk");
    assert.equal(t.sentences.length, 3);
    assert.equal(t.sentences[2].start, 3723);
    assert.equal(sent.contents[0].parts[0].fileData.fileUri, "https://www.youtube.com/watch?v=RKF42sgl8QQ");
  } finally {
    globalThis.fetch = realFetch;
    if (saved === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = saved;
  }
});

test("handles YouTube transcripts with >> markers, duration labels or no timestamps", () => {
  const withMarkers = parseTranscript("0:00\n6 seconds\n>> Exactly.\n0:02\n2 seconds\n>> The only time that you get to rest [Music]\n0:05\nis when you stop.");
  assert.equal(withMarkers[0].text, "Exactly.");
  assert.ok(withMarkers.every((s) => !s.text.includes(">>") && !s.text.includes("seconds") && !s.text.includes("[Music]")));
  const plain = parseTranscript("So today we talk about money. Why does nobody price their work right? Here is the secret that changed everything for me and my business.");
  assert.ok(plain.length >= 3);
  assert.equal(plain[0].start, 0);
  assert.ok(plain[2].start > 4);
});

test("Gemini overload retries, then switches to another free model", async () => {
  const { geminiFetch } = await import("../lib/gemini.ts");
  const realFetch = globalThis.fetch;
  const calls: string[] = [];
  try {
    globalThis.fetch = (async (url: string) => {
      calls.push(url.split("/models/")[1].split(":")[0]);
      return calls.length <= 2 ? new Response("busy", { status: 503 }) : Response.json({ ok: true });
    }) as typeof fetch;
    const { res, model } = await geminiFetch("gemini-flash-latest", "generateContent", {}, "k");
    assert.equal(res.ok, true);
    assert.deepEqual(calls, ["gemini-flash-latest", "gemini-flash-latest", "gemini-2.5-flash"]);
    assert.equal(model, "gemini-2.5-flash");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("backup services are listed after the preferred one", async () => {
  const { availableProviders } = await import("../lib/providers.ts");
  const saved = { ...process.env };
  for (const k of ["GEMINI_API_KEY", "GOOGLE_API_KEY", "GROQ_API_KEY", "ANTHROPIC_API_KEY", "VIRALCUT_PROVIDER", "VIRALCUT_MODEL"]) delete process.env[k];
  process.env.GEMINI_API_KEY = "a";
  process.env.GROQ_API_KEY = "b";
  assert.deepEqual(availableProviders().map((p) => p.name), ["gemini", "groq"]);
  process.env.VIRALCUT_PROVIDER = "groq";
  assert.deepEqual(availableProviders().map((p) => p.name), ["groq", "gemini"]);
  process.env = saved;
});
