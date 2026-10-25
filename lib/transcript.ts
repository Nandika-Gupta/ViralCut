import type { Sentence, Word } from "./types.ts";

const SENTENCE_END = /[.!?…]+["')\]]*$/;

/** Group timed words into sentences using punctuation, pauses and a length cap. */
export function wordsToSentences(words: Word[], maxGap = 1.2, maxLen = 14): Sentence[] {
  const out: Sentence[] = [];
  let cur: Word[] = [];
  words.forEach((w, i) => {
    cur.push(w);
    const next = words[i + 1];
    const ends = SENTENCE_END.test(w.text);
    const pause = next !== undefined && next.start - w.end > maxGap;
    const tooLong = cur[cur.length - 1].end - cur[0].start > maxLen;
    if (!next || ends || pause || tooLong) {
      out.push({ text: cur.map((x) => x.text).join(" ").trim(), start: cur[0].start, end: cur[cur.length - 1].end, words: cur });
      cur = [];
    }
  });
  return out;
}

/** Approximate word timings across a cue, weighted by word length. */
export function spreadWords(text: string, start: number, end: number): Word[] {
  const tokens = text.split(/\s+/).filter(Boolean);
  if (!tokens.length) return [];
  const weights = tokens.map((t) => t.length + 2);
  const total = weights.reduce((a, b) => a + b, 0);
  const span = Math.max(end - start, 0.01);
  let t = start;
  return tokens.map((tok, i) => {
    const d = (span * weights[i]) / total;
    const w = { text: tok, start: round(t), end: round(t + d) };
    t += d;
    return w;
  });
}

const round = (n: number) => Math.round(n * 1000) / 1000;

export function parseTimestamp(value: string): number | null {
  const m = value.trim().match(/^(?:(\d+):)?(\d{1,2}):(\d{2})(?:[.,](\d{1,3}))?$/);
  if (!m) return null;
  const [, h, mi, s, ms] = m;
  return Number(h || 0) * 3600 + Number(mi) * 60 + Number(s) + Number((ms || "0").padEnd(3, "0")) / 1000;
}

/**
 * Parse SRT, WebVTT, or a transcript copied from YouTube ("0:00\ntext" or "0:00 text")
 * into sentences with estimated word timings. A transcript copied without timestamps gets times estimated
 * from a normal speaking pace (about 2.6 words per second).
 */
export function parseTranscript(raw: string): Sentence[] {
  const lines = raw.replace(/\r/g, "").split("\n").map((l) => l.trim());
  const cues: { start: number; end: number | null; text: string }[] = [];
  let pending: { start: number; end: number | null } | null = null;
  for (const line of lines) {
    if (!line || line === "WEBVTT" || /^\d+$/.test(line) || /^(NOTE|STYLE|Kind:|Language:)/.test(line)) continue;
    if (DURATION_LABEL.test(line)) continue; // YouTube's spoken-time labels, e.g. "1 minute, 5 seconds"
    const range = line.match(/^((?:\d+:)?\d{1,2}:\d{2}(?:[.,]\d{1,3})?)\s*-->\s*((?:\d+:)?\d{1,2}:\d{2}(?:[.,]\d{1,3})?)/);
    if (range) {
      pending = { start: parseTimestamp(range[1])!, end: parseTimestamp(range[2]) };
      continue;
    }
    const alone = parseTimestamp(line);
    if (alone !== null) {
      pending = { start: alone, end: null };
      continue;
    }
    const lead = line.match(/^\[?((?:\d+:)?\d{1,2}:\d{2})\]?\s+(.+)$/);
    const text = cleanLine(lead ? lead[2] : line);
    const start = lead ? parseTimestamp(lead[1]) : pending?.start ?? null;
    if (start === null || !text) continue;
    if (!lead && pending && cues.length && cues[cues.length - 1].start === pending.start) {
      cues[cues.length - 1].text += " " + text; // multi-line SRT cue
      continue;
    }
    cues.push({ start, end: lead ? null : pending?.end ?? null, text });
    pending = lead ? null : pending;
  }
  if (!cues.length) return estimateTimings(lines);
  cues.sort((a, b) => a.start - b.start);
  const words: Word[] = [];
  cues.forEach((c, i) => {
    const next = cues[i + 1];
    const guess = c.start + Math.max(1, c.text.split(/\s+/).length * 0.38);
    const end = c.end ?? (next ? Math.min(next.start, guess + 2) : guess);
    words.push(...spreadWords(c.text, c.start, Math.max(end, c.start + 0.3)));
  });
  return wordsToSentences(words);
}

const DURATION_LABEL = /^\d+\s+(hours?|minutes?|seconds?)(,?\s+\d+\s+(hours?|minutes?|seconds?))*$/i;

/** Drop speaker markers (">>"), sound tags ("[Music]") and markup from a transcript line. */
function cleanLine(text: string): string {
  return text
    .replace(/<[^>]+>|\{[^}]+\}/g, "")
    .replace(/\[(music|applause|laughter|laughs|inaudible|silence|__)\]|\((laughs|applause|music)\)/gi, "")
    .replace(/^\s*(>>|-|–|—)\s*/, "")
    .replace(/\s+/g, " ")
    .trim();
}

const WORDS_PER_SECOND = 2.6;

function estimateTimings(lines: string[]): Sentence[] {
  const text = lines
    .filter((l) => l && !DURATION_LABEL.test(l) && parseTimestamp(l) === null && !/-->/.test(l) && !/^\d+$/.test(l) && l !== "WEBVTT")
    .map(cleanLine)
    .filter(Boolean)
    .join(" ");
  const tokens = text.split(/\s+/).filter(Boolean);
  if (tokens.length < 8) return [];
  const words: Word[] = tokens.map((t, i) => ({ text: t, start: round(i / WORDS_PER_SECOND), end: round((i + 0.9) / WORDS_PER_SECOND) }));
  return wordsToSentences(words, 1.2, 12);
}

/** True when the pasted text carries its own timestamps (otherwise clip times are estimates). */
export function hasTimestamps(raw: string): boolean {
  return raw.split("\n").filter((l) => /^\[?(\d+:)?\d{1,2}:\d{2}/.test(l.trim())).length >= 2;
}

export function formatTime(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${r}` : `${m}:${r}`;
}

export function transcriptText(sentences: Sentence[], withTimes = true): string {
  return sentences.map((s) => (withTimes ? `[${formatTime(s.start)}] ${s.text}` : s.text)).join(withTimes ? "\n" : " ");
}

/** Align a proposed clip to sentence boundaries and the allowed length. */
export function snapToSentences(start: number, end: number, sentences: Sentence[], minLen: number, maxLen: number) {
  if (!sentences.length) return { start, end, group: [] as Sentence[] };
  let first = 0;
  sentences.forEach((s, i) => {
    if (Math.abs(s.start - start) < Math.abs(sentences[first].start - start)) first = i;
  });
  let last = first;
  for (let i = first; i < sentences.length; i++) {
    if (Math.abs(sentences[i].end - end) < Math.abs(sentences[last].end - end)) last = i;
  }
  while (last > first && sentences[last].end - sentences[first].start > maxLen) last--;
  while (last + 1 < sentences.length && sentences[last].end - sentences[first].start < minLen) last++;
  const group = sentences.slice(first, last + 1);
  return { start: group[0].start, end: group[group.length - 1].end, group };
}

export function wordsBetween(sentences: Sentence[], start: number, end: number): Word[] {
  return sentences.flatMap((s) => s.words).filter((w) => w.start >= start - 0.05 && w.start < end);
}
