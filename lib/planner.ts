/** Server-only: the prompt and JSON schema for picking clips and writing posts (shared by every AI service). */
import type { ClipRequest, Platform, PostsRequest } from "./types.ts";

/** One AI request: the prompt, a strict schema (Claude) and a spelled-out shape (Gemini, Groq). */
export type Task = { prompt: string; schema: Record<string, unknown>; shape: string };

const PLATFORM_RULES: Record<Platform, string> = {
  tiktok: "TikTok caption: punchy, under 150 characters, conversational, 1-2 emojis max, no hashtags in the text",
  instagram: "Instagram Reels caption: strong first line, 2-4 short lines of value or story, a save/share call to action, no hashtags in the text",
  youtube: "YouTube Shorts title: under 70 characters, curiosity-driven, no hashtags in the text",
  x: "X post: under 260 characters, opinionated, no hashtags in the text",
  linkedin: "LinkedIn post: hook line, 3-6 short lines with a clear takeaway, ends with a question, no hashtags in the text",
  facebook: "Facebook post: friendly, 2-3 sentences that make people want to watch and comment, no hashtags in the text",
};

const str = { type: "string" } as const;
const strList = { type: "array", items: { type: "string" } } as const;
const obj = (properties: Record<string, unknown>) => ({
  type: "object",
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
});

export const SYSTEM = `You are a top short-form video editor and social media strategist who has grown creators to millions of \
followers by clipping podcasts, interviews, streams and talks into viral shorts for TikTok, Instagram Reels and YouTube Shorts.

What makes a great clip:
- The first 3 seconds hook the viewer: a bold claim, a question, a surprising number, conflict, emotion or a story opening.
- It stands alone: someone with no context understands it and gets a payoff (insight, laugh, twist, resolution).
- It starts at the beginning of a sentence and ends on a complete thought, never mid-sentence.
- Strong opinions, stories, numbers and controversy beat intros, small talk and sponsor reads.
- Clips never overlap. Use only what is actually said in the transcript; never invent quotes or events.

Hashtags: 5-10 per platform for TikTok, Instagram, YouTube and Facebook; 2-4 for X and LinkedIn. Every tag starts with "#" and \
has no spaces. Mix 2-3 broad discovery tags for that platform with specific niche tags from the content.
Copy must sound human and native to each platform, with no corporate filler.`;

const tagRule = (platforms: Platform[]) => platforms.map((p) => `- ${p}: ${PLATFORM_RULES[p]}`).join("\n");

/**
 * Step 1: read the whole transcript and pick the clips. The answer is short (no per-platform posts),
 * so it finishes well inside hosting time limits even for long videos.
 */
export function pickTask(req: ClipRequest): Task {
  const prompt = `Video title: ${req.title || "unknown"}

<transcript>
${req.transcript}
</transcript>

Pick the ${req.count} best clips, each between ${req.minLen} and ${req.maxLen} seconds long.
- start: the [m:ss] mark, converted to seconds, where the clip's first sentence begins.
- end: where its last sentence ends (the next line's mark), in seconds.
- title: a scroll-stopping title for the clip.
- hook: on-screen text for the first 3 seconds, at most 7 words.
- quote: the single strongest line in the clip, verbatim.
- why: one sentence on why this moment will perform.
- virality: your 0-100 prediction. Order clips best first.

Also write posts promoting the full video (an X thread of 5-7 tweets, a LinkedIn post, an Instagram caption) and a hashtag bank \
of broad and niche tags for the whole video.
Tone: ${req.tone}. Write titles, hooks and posts in ${req.language}.`;
  const schema = obj({
    title: str,
    summary: str,
    clips: {
      type: "array",
      items: obj({ start: { type: "number" }, end: { type: "number" }, title: str, hook: str, quote: str, why: str, virality: { type: "integer" } }),
    },
    full_video: obj({ x_thread: strList, linkedin: str, instagram: str }),
    hashtag_bank: obj({ broad: strList, niche: strList }),
  });
  const shape = `Reply with ONLY one JSON object (no markdown, no commentary) in exactly this shape:
{
  "title": "video title or topic",
  "summary": "2-3 sentences on what the video is about and who it's for",
  "clips": [ { "start": 83, "end": 131, "title": "…", "hook": "…", "quote": "…", "why": "…", "virality": 0 } ],
  "full_video": { "x_thread": ["tweet 1", "tweet 2"], "linkedin": "…", "instagram": "…" },
  "hashtag_bank": { "broad": ["#…"], "niche": ["#…"] }
}`;
  return { prompt, schema, shape };
}

/** Step 2: posts and hashtags for one clip (run in parallel for all clips). */
export function postsTask(req: PostsRequest): Task {
  const prompt = `This is a short clip cut from the video "${req.title || "unknown"}".
Clip title: ${req.clip.title}
On-screen hook: ${req.clip.hook}

<clip_transcript>
${req.clip.text}
</clip_transcript>

Write a post and hashtags for each platform:
${tagRule(req.platforms)}

Tone: ${req.tone}. Write in ${req.language}. Use only what is said in the clip.`;
  const schema = obj({
    posts: obj(Object.fromEntries(req.platforms.map((p) => [p, str]))),
    hashtags: obj(Object.fromEntries(req.platforms.map((p) => [p, strList]))),
  });
  const posts = req.platforms.map((p) => `"${p}": "post text"`).join(", ");
  const tags = req.platforms.map((p) => `"${p}": ["#tag"]`).join(", ");
  const shape = `Reply with ONLY one JSON object (no markdown, no commentary) in exactly this shape:
{ "posts": { ${posts} }, "hashtags": { ${tags} } }`;
  return { prompt, schema, shape };
}
