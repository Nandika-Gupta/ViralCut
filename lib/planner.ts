/** Server-only: the prompt and JSON schema for picking clips and writing posts (shared by every AI service). */
import type { ClipRequest, Platform } from "./types.ts";

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

export function planSchema(platforms: Platform[]) {
  const posts = obj(Object.fromEntries(platforms.map((p) => [p, str])));
  const tags = obj(Object.fromEntries(platforms.map((p) => [p, strList])));
  return obj({
    title: str,
    summary: str,
    clips: {
      type: "array",
      items: obj({
        start: { type: "number" },
        end: { type: "number" },
        title: str,
        hook: str,
        quote: str,
        why: str,
        virality: { type: "integer" },
        posts,
        hashtags: tags,
      }),
    },
    full_video: obj({ x_thread: strList, linkedin: str, instagram: str }),
    hashtag_bank: obj({ broad: strList, niche: strList }),
  });
}

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

export function planPrompt(req: ClipRequest): string {
  const rules = req.platforms.map((p) => `- ${p}: ${PLATFORM_RULES[p]}`).join("\n");
  return `Video title: ${req.title || "unknown"}

<transcript>
${req.transcript}
</transcript>

Pick the ${req.count} best clips, each between ${req.minLen} and ${req.maxLen} seconds long.
- start: the [m:ss] mark (in seconds) where the clip's first sentence begins.
- end: where its last sentence ends (the next line's mark, in seconds).
- hook: on-screen text for the first 3 seconds, at most 7 words.
- quote: the single strongest line in the clip, verbatim.
- why: one sentence on why this moment will perform.
- virality: your 0-100 prediction. Order clips best first.

Tone: ${req.tone}. Write every post, title and hook in ${req.language}.
Write a post and hashtags for each platform:
${rules}

Also write posts promoting the full video (an X thread of 5-7 tweets, a LinkedIn post, an Instagram caption) and a hashtag bank \
of broad and niche tags for the whole video.`;
}

/** Spelled-out JSON shape for services that don't take a strict schema (Gemini JSON mode, Groq). */
export function shapeHint(platforms: Platform[]): string {
  const posts = platforms.map((p) => `"${p}": "post text"`).join(", ");
  const tags = platforms.map((p) => `"${p}": ["#tag"]`).join(", ");
  return `Reply with ONLY one JSON object (no markdown, no commentary) in exactly this shape:
{
  "title": "video title or topic",
  "summary": "2-3 sentences on what the video is about and who it's for",
  "clips": [
    { "start": 0, "end": 0, "title": "…", "hook": "…", "quote": "…", "why": "…", "virality": 0,
      "posts": { ${posts} },
      "hashtags": { ${tags} } }
  ],
  "full_video": { "x_thread": ["tweet 1", "tweet 2"], "linkedin": "…", "instagram": "…" },
  "hashtag_bank": { "broad": ["#…"], "niche": ["#…"] }
}`;
}
