/**
 * Server-side YouTube caption fetching (no API key needed).
 * Tries YouTube's Android player API first, then the public watch page. Either can be refused by
 * YouTube for some videos or server IPs; callers fall back to asking for a transcript or the file.
 */
import { wordsToSentences } from "./transcript.ts";
import type { Sentence, Word } from "./types.ts";

export class TranscriptError extends Error {
  code: "no_captions" | "blocked" | "unavailable" | "bad_link";
  constructor(message: string, code: TranscriptError["code"]) {
    super(message);
    this.code = code;
  }
}

export function youtubeId(url: string): string | null {
  try {
    const u = new URL(url.trim());
    const host = u.hostname.replace(/^(www|m|music)\./, "");
    let id: string | null = null;
    if (host === "youtu.be") id = u.pathname.slice(1).split("/")[0];
    else if (host === "youtube.com" || host.endsWith(".youtube.com")) {
      id = u.searchParams.get("v");
      const m = u.pathname.match(/^\/(shorts|live|embed|v)\/([^/?#]+)/);
      if (!id && m) id = m[2];
    }
    return id && /^[A-Za-z0-9_-]{11}$/.test(id) ? id : null;
  } catch {
    return null;
  }
}

type Track = { baseUrl: string; languageCode: string; kind?: string; name?: { simpleText?: string; runs?: { text: string }[] } };
type PlayerResponse = {
  playabilityStatus?: { status?: string; reason?: string };
  videoDetails?: { title?: string; lengthSeconds?: string; author?: string };
  captions?: { playerCaptionsTracklistRenderer?: { captionTracks?: Track[] } };
};

const ANDROID_VERSION = "20.10.38";

async function androidPlayer(videoId: string): Promise<PlayerResponse> {
  const res = await fetch("https://www.youtube.com/youtubei/v1/player?prettyPrint=false", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "User-Agent": `com.google.android.youtube/${ANDROID_VERSION} (Linux; U; Android 14) gzip`,
      "X-YouTube-Client-Name": "3",
      "X-YouTube-Client-Version": ANDROID_VERSION,
    },
    body: JSON.stringify({
      context: { client: { clientName: "ANDROID", clientVersion: ANDROID_VERSION, androidSdkVersion: 34, hl: "en", gl: "US" } },
      videoId,
      contentCheckOk: true,
      racyCheckOk: true,
    }),
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`player ${res.status}`);
  return res.json();
}

async function watchPage(videoId: string): Promise<PlayerResponse> {
  const res = await fetch(`https://www.youtube.com/watch?v=${videoId}&hl=en&bpctr=9999999999&has_verified=1`, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36",
      "Accept-Language": "en-US,en;q=0.9",
      Cookie: "CONSENT=YES+cb; SOCS=CAI",
    },
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`watch ${res.status}`);
  const html = await res.text();
  const m = html.match(/ytInitialPlayerResponse\s*=\s*(\{.+?\})\s*;\s*(?:var\s|<\/script>)/s);
  if (!m) throw new Error("player response not found");
  return JSON.parse(m[1]);
}

function pickTrack(tracks: Track[], lang?: string): Track | undefined {
  const manual = tracks.filter((t) => t.kind !== "asr");
  const auto = tracks.filter((t) => t.kind === "asr");
  const byLang = (list: Track[], code?: string) => (code ? list.find((t) => t.languageCode.split("-")[0] === code) : undefined);
  return byLang(manual, lang) ?? byLang(auto, lang) ?? byLang(manual, "en") ?? manual[0] ?? auto[0];
}

type Json3 = { events?: { tStartMs?: number; dDurationMs?: number; segs?: { utf8?: string; tOffsetMs?: number }[] }[] };

function wordsFromJson3(data: Json3): Word[] {
  const words: Word[] = [];
  for (const ev of data.events ?? []) {
    if (!ev.segs || ev.tStartMs === undefined) continue;
    const evStart = ev.tStartMs / 1000;
    const evEnd = (ev.tStartMs + (ev.dDurationMs ?? 2000)) / 1000;
    const segs = ev.segs.filter((s) => (s.utf8 ?? "").trim() && s.utf8 !== "\n");
    segs.forEach((s, i) => {
      const start = evStart + (s.tOffsetMs ?? 0) / 1000;
      const nextStart = segs[i + 1] ? evStart + (segs[i + 1].tOffsetMs ?? 0) / 1000 : evEnd;
      const parts = (s.utf8 ?? "").replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
      const step = Math.max((nextStart - start) / parts.length, 0.05);
      parts.forEach((p, k) => words.push({ text: p, start: start + k * step, end: start + (k + 1) * step }));
    });
  }
  return words.sort((a, b) => a.start - b.start);
}

function wordsFromXml(xml: string): Word[] {
  const words: Word[] = [];
  const decode = (s: string) =>
    s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/<[^>]+>/g, "");
  for (const m of xml.matchAll(/<text start="([\d.]+)"(?: dur="([\d.]+)")?[^>]*>([\s\S]*?)<\/text>/g)) {
    const start = Number(m[1]);
    const dur = Number(m[2] ?? 2);
    const parts = decode(decode(m[3])).replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
    const step = dur / Math.max(parts.length, 1);
    parts.forEach((p, k) => words.push({ text: p, start: start + k * step, end: start + (k + 1) * step }));
  }
  return words;
}

async function fetchTrack(track: Track): Promise<Word[]> {
  const base = track.baseUrl.replace(/&fmt=[^&]*/, "");
  const res = await fetch(`${base}&fmt=json3`, { cache: "no-store" });
  const body = res.ok ? await res.text() : "";
  if (body.trim().startsWith("{")) {
    const words = wordsFromJson3(JSON.parse(body));
    if (words.length) return words;
  }
  const xmlRes = await fetch(base, { cache: "no-store" });
  return xmlRes.ok ? wordsFromXml(await xmlRes.text()) : [];
}

export type YouTubeTranscript = { videoId: string; title: string; author: string; duration: number; language: string; sentences: Sentence[] };

export async function fetchYouTubeTranscript(url: string, lang?: string): Promise<YouTubeTranscript> {
  const videoId = youtubeId(url);
  if (!videoId) throw new TranscriptError("That isn't a YouTube video link.", "bad_link");
  let lastStatus = "";
  for (const load of [androidPlayer, watchPage]) {
    let player: PlayerResponse;
    try {
      player = await load(videoId);
    } catch {
      continue;
    }
    lastStatus = player.playabilityStatus?.status ?? "";
    const tracks = player.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? [];
    const track = pickTrack(tracks, lang);
    if (!track) continue;
    const words = await fetchTrack(track).catch(() => [] as Word[]);
    if (!words.length) continue;
    return {
      videoId,
      title: player.videoDetails?.title ?? "",
      author: player.videoDetails?.author ?? "",
      duration: Number(player.videoDetails?.lengthSeconds ?? 0) || words[words.length - 1].end,
      language: track.languageCode,
      sentences: wordsToSentences(words),
    };
  }
  if (lastStatus === "LOGIN_REQUIRED") throw new TranscriptError("YouTube asked this server to sign in, so it can't read the captions.", "blocked");
  if (lastStatus && lastStatus !== "OK") throw new TranscriptError("This video is private, age-restricted or unavailable.", "unavailable");
  throw new TranscriptError("Couldn't read captions for this video. It may have none, or YouTube refused the request.", "no_captions");
}
