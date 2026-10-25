/**
 * Offline viral-moment scoring and copywriting, used when no Claude API key is configured
 * (and as hints for Claude). Scores hooks, emotion, curiosity, pacing, topic and loudness.
 */
import type { ClipPlan, Plan, Platform, Sentence } from "./types.ts";

const STOPWORDS = new Set(
  `a about above after again against all am an and any are as at be because been before being below between both but by
  can cannot could did do does doing down during each few for from further gonna got had has have having he her here
  hers herself him himself his how i if in into is it its itself just me more most my myself no nor not now of off on
  once only or other our ours ourselves out over own really right same say said says she should so some such than that
  the their theirs them themselves then there these they thing things think this those through to too under until up us
  very want was we well were what when where which while who whom why will with would yeah yes you your yours yourself
  okay ok um uh actually basically literally kind sort going know mean get go one also lot even still much many make made
  every thats dont im youre ive ill cant wont nobody anybody somebody everybody someone anyone everyone something anything
  everything nothing talking talk tried try trying hit days day time times take takes took put tell told see saw look
  looking come came give gave need needs use used using start started work first last next ever new two three four five
  six seven eight nine ten twenty thirty hundred thousand wait people guys guy man stuff part point whole single month
  year week hour minute second back keep let lets doesnt didnt isnt wasnt arent`.split(/\s+/),
);

const HOOK_PATTERNS = [
  /\bwhy\b/, /\bhow (to|i|we|you)\b/, /\bwhat if\b/, /\bsecret/, /\bnobody\b/, /\bno one\b/, /\bnever\b/, /\bstop\b/,
  /\bmistake/, /\btruth\b/, /\bthe (real|biggest|best|worst)\b/, /\bhere'?s (why|how|what)\b/, /\byou (need|have) to\b/,
  /\bi (quit|lost|made|built|tried)\b/, /\bimagine\b/, /\bthis is (why|how|the)\b/, /\bdid you know\b/, /\bcrazy\b/,
  /\binsane\b/, /\bunbelievable\b/, /\bshocking\b/, /\bmillion/, /\bbillion/, /\$\d/, /\b\d+\s?(k|%|percent|x|times|days|years|hours)\b/,
];
const EMOTION = new Set(
  `amazing awesome crazy insane shocking love hate fear scared angry broke rich money died death kill win won lose lost fail
  failed failure success secret truth lie lies wrong worst best never always hilarious funny laugh cried crying wow omg
  unbelievable incredible huge massive dangerous illegal banned free viral famous fired quit rejected betrayed`.split(/\s+/),
);

export const tokenize = (text: string) => text.toLowerCase().match(/[a-z0-9][a-z0-9'$%]*/g) ?? [];
const isContent = (t: string) =>
  !STOPWORDS.has(t) && t.length > 2 && !/^\d/.test(t) && !t.includes("$") && !(t.endsWith("ly") && t.length > 5);

export function keywords(text: string, top = 12): string[] {
  const counts = new Map<string, number>();
  for (const raw of tokenize(text)) {
    const t = raw.replace(/'/g, "");
    if (isContent(t)) counts.set(t, (counts.get(t) ?? 0) + 1);
  }
  return [...counts.keys()]
    .sort((a, b) => counts.get(b)! * (1 + Math.min(b.length, 12) / 6) - counts.get(a)! * (1 + Math.min(a.length, 12) / 6))
    .slice(0, top);
}

export function keyPhrases(text: string, top = 3): string[] {
  const counts = new Map<string, number>();
  for (const clause of text.split(/[.!?,;:]+/)) {
    const toks = tokenize(clause);
    for (let i = 0; i + 1 < toks.length; i++) {
      if ((isContent(toks[i]) || toks[i] === "ai") && isContent(toks[i + 1])) {
        const p = toks[i] + toks[i + 1];
        counts.set(p, (counts.get(p) ?? 0) + 1);
      }
    }
  }
  return [...counts.entries()].filter(([, n]) => n > 1).sort((a, b) => b[1] - a[1]).slice(0, top).map(([p]) => p);
}

export function hashtagsFor(text: string, limit = 8): string[] {
  const tags: string[] = [];
  for (const w of [...keyPhrases(text), ...keywords(text, 15)]) {
    const tag = "#" + w.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (tag.length > 3 && !tags.includes(tag)) tags.push(tag);
  }
  return tags.slice(0, limit);
}

export function hookStrength(text: string): number {
  const t = text.toLowerCase();
  const hits = HOOK_PATTERNS.filter((p) => p.test(t)).length;
  let score = (Math.min(hits, 3) / 3) * 0.7;
  if (text.includes("?")) score += 0.15;
  if (/\byou\b/.test(t)) score += 0.1;
  if (t.split(/\s+/).length <= 14) score += 0.05;
  return Math.min(score, 1);
}

type Candidate = { start: number; end: number; group: Sentence[]; text: string; score: number; signals: Record<string, number> };

function normalizeLoudness(curve: number[] | null): number[] | null {
  if (!curve || curve.length < 4) return null;
  const sorted = [...curve].sort((a, b) => a - b);
  const lo = sorted[Math.floor(sorted.length * 0.1)];
  const hi = sorted[Math.floor(sorted.length * 0.98)];
  return curve.map((v) => Math.min(1, Math.max(0, (v - lo) / Math.max(hi - lo, 1e-6))));
}

function score(c: Candidate, energy: number[] | null, hop: number, topic: string[]): Candidate {
  const words = tokenize(c.text);
  const n = Math.max(words.length, 1);
  const hook = hookStrength(c.group[0]?.text ?? c.text);
  const emotion = Math.min((words.filter((w) => EMOTION.has(w)).length / n) * 12, 1);
  const curiosity = Math.min((c.text.match(/\?/g)?.length ?? 0) * 0.25 + (c.text.match(/\d/g)?.length ?? 0) * 0.05, 1);
  const topical = Math.min((words.filter((w) => topic.includes(w)).length / n) * 6, 1);
  const pace = n / Math.max(c.end - c.start, 1);
  const paceScore = Math.exp(-((pace - 3) ** 2) / 2);
  let energyScore = 0.5;
  if (energy) {
    const seg = energy.slice(Math.floor(c.start / hop), Math.max(Math.floor(c.end / hop), Math.floor(c.start / hop) + 1));
    if (seg.length) {
      const mean = seg.reduce((a, b) => a + b, 0) / seg.length;
      const peak = [...seg].sort((a, b) => a - b)[Math.floor(seg.length * 0.95)];
      energyScore = 0.6 * mean + 0.4 * peak;
    }
  }
  const complete = /[.!?]$/.test(c.group[c.group.length - 1]?.text ?? "") ? 1 : 0.4;
  c.signals = { hook, energy: energyScore, emotion, curiosity, pace: paceScore, topical, complete };
  const w = { hook: 0.27, energy: 0.2, emotion: 0.15, curiosity: 0.1, pace: 0.1, topical: 0.08, complete: 0.1 };
  const raw = Object.entries(w).reduce((s, [k, v]) => s + c.signals[k] * v, 0);
  c.score = Math.round(Math.min(99, 40 + raw * 75));
  return c;
}

/** Best non-overlapping sentence-aligned windows. */
export function findMoments(
  sentences: Sentence[], loudness: number[] | null, hop: number, count: number, minLen: number, maxLen: number,
): Candidate[] {
  const energy = normalizeLoudness(loudness);
  const topic = keywords(sentences.map((s) => s.text).join(" "), 15);
  const cands: Candidate[] = [];
  for (let i = 0; i < sentences.length; i++) {
    for (let j = i; j < sentences.length; j++) {
      const dur = sentences[j].end - sentences[i].start;
      if (dur > maxLen) break;
      if (dur >= minLen) {
        const group = sentences.slice(i, j + 1);
        cands.push(score({ start: group[0].start, end: group[group.length - 1].end, group, text: group.map((s) => s.text).join(" "), score: 0, signals: {} }, energy, hop, topic));
      }
    }
  }
  if (!cands.length && sentences.length) {
    const group = sentences.filter((s) => s.end - sentences[0].start <= maxLen);
    const g = group.length ? group : [sentences[0]];
    cands.push(score({ start: g[0].start, end: g[g.length - 1].end, group: g, text: g.map((s) => s.text).join(" "), score: 0, signals: {} }, energy, hop, topic));
  }
  const chosen: Candidate[] = [];
  for (const c of cands.sort((a, b) => b.score - a.score)) {
    const overlaps = chosen.some((o) => Math.max(0, Math.min(c.end, o.end) - Math.max(c.start, o.start)) > 0.1 * Math.min(c.end - c.start, o.end - o.start));
    if (!overlaps) chosen.push(c);
    if (chosen.length >= count) break;
  }
  return chosen;
}

const BROAD: Record<Platform, string[]> = {
  tiktok: ["#fyp", "#foryou", "#viral"],
  instagram: ["#reels", "#explorepage", "#viralreels"],
  youtube: ["#shorts", "#youtubeshorts"],
  x: [],
  linkedin: [],
  facebook: ["#reels", "#viral"],
};

const trimLine = (text: string, limit: number) => {
  let t = text.replace(/\s+/g, " ").trim().replace(/[.,]$/, "");
  if (t.length > limit) t = t.slice(0, limit).replace(/\s+\S*$/, "") + "…";
  return t.charAt(0).toUpperCase() + t.slice(1);
};

/** Template copy for one moment. */
function offlineClip(c: Candidate, platforms: Platform[]): ClipPlan {
  const first = c.group[0]?.text ?? "";
  const title = trimLine(first, 70) || "Best moment";
  const topic = keywords(c.text, 3).join(" ") || "this";
  const niche = hashtagsFor(c.text, 7);
  const templates: Record<Platform, string> = {
    tiktok: `${title} 🤯 Watch till the end`,
    instagram: `${title}\n\nThe part nobody talks about when it comes to ${topic}. 👀\nSave this and share it with someone who needs it. 🔁`,
    youtube: title.length > 68 ? title.slice(0, 66) + "…" : title,
    x: `${title}\n\nThe most underrated take on ${topic} 👇`,
    linkedin: `${title}\n\nOne lesson on ${topic} that changed how I think about it.\n\nWhat's your take? 👇`,
    facebook: `${title} 👀 Would you agree?`,
  };
  const labels: Record<string, string> = {
    hook: "strong opening hook", energy: "high vocal energy", emotion: "emotional language", curiosity: "curiosity and numbers",
    pace: "punchy pacing", topical: "on-topic", complete: "ends on a complete thought",
  };
  const why = Object.entries(c.signals).sort((a, b) => b[1] - a[1]).slice(0, 3).filter(([, v]) => v > 0.3).map(([k]) => labels[k]).join(", ");
  return {
    start: c.start, end: c.end, title, hook: trimLine(first, 42).toUpperCase(), quote: first,
    why: why ? why.charAt(0).toUpperCase() + why.slice(1) + "." : "Steady, engaging segment.", virality: c.score,
    posts: Object.fromEntries(platforms.map((p) => [p, templates[p]])),
    hashtags: Object.fromEntries(platforms.map((p) => [p, [...niche, ...BROAD[p]].slice(0, p === "x" || p === "linkedin" ? 4 : 10)])),
  };
}

export function offlinePlan(
  sentences: Sentence[], loudness: number[] | null, hop: number, title: string,
  opts: { count: number; minLen: number; maxLen: number; platforms: Platform[] },
): Plan {
  const moments = findMoments(sentences, loudness, hop, opts.count, opts.minLen, opts.maxLen);
  const all = sentences.map((s) => s.text).join(" ");
  const tags = hashtagsFor(all || title, 8);
  const clips = moments.map((m) => offlineClip(m, opts.platforms)).sort((a, b) => b.virality - a.virality);
  return {
    title: title || "Your video",
    summary: trimLine(all, 280),
    clips,
    full_video: {
      x_thread: [
        `${title || "New video"}: the ${clips.length} moments worth your time 🧵`,
        ...clips.slice(0, 4).map((c, i) => `${i + 1}. ${c.title}`),
        "Watch the full video. Which one hits hardest?",
      ],
      linkedin: `${title}\n\nWe pulled the ${clips.length} best moments from this conversation. ${clips[0] ? `My favourite: "${clips[0].quote}"` : ""}\n\nWhich one resonates with you?`,
      instagram: `${title} 🎬\nThe best moments are on our page. Save this for later!\n\n${tags.slice(0, 5).join(" ")}`,
    },
    hashtag_bank: { broad: ["#viral", "#fyp", "#shorts", "#reels", "#trending"], niche: tags },
    engine: "Offline scoring",
  };
}
