"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import ClipCard, { type RenderState } from "./ClipCard";
import ProjectsPanel, { ProjectTitle } from "./Projects";
import { Drive, Dropbox, Kick, Loom, PLATFORM_ICONS, Twitch, Upload, YouTube } from "./icons";
import { offlineCopy, offlinePlan } from "@/lib/analysis";
import { LOUDNESS_HOP, decodeAudio, loudnessCurve } from "@/lib/audio";
import { getYouTubeToken, shortsTitle, uploadToYouTube, type YouTubeMeta } from "@/lib/youtubeUpload";
import { renderClip, type CaptionStyle, type Layout } from "@/lib/render";
import { extractJson } from "@/lib/json";
import { formatTime, hasTimestamps, parseTimestamp, parseTranscript, snapToSentences, spreadWords, transcriptText, wordsBetween, wordsToSentences } from "@/lib/transcript";
import { PLATFORMS, PLATFORM_LABELS, type ClipPlan, type Plan, type Platform, type Sentence, type Word } from "@/lib/types";

/* ---------------- settings ---------------- */

const LENGTHS = [
  { label: "15–30s", min: 15, max: 30 },
  { label: "20–60s", min: 20, max: 60 },
  { label: "45–90s", min: 45, max: 90 },
  { label: "1–3 min", min: 60, max: 180 },
];
const COUNTS = [3, 5, 8, 10];
const TONES = ["Hype", "Educational", "Funny", "Inspirational", "Professional"];
const OUTPUT_LANGS: [string, string][] = [
  ["the same language as the transcript", "Same as video"], ["English", "English"],
  ["Hinglish (Hindi in Latin script mixed with English)", "Hinglish"], ["Hindi (Devanagari script)", "Hindi"],
  ["Spanish", "Spanish"], ["Portuguese", "Portuguese"], ["French", "French"], ["German", "German"], ["Arabic", "Arabic"],
];
const SPOKEN_LANGS: [string, string][] = [
  ["", "Detect automatically"], ["english", "English"], ["hindi", "Hindi"], ["spanish", "Spanish"], ["portuguese", "Portuguese"],
  ["french", "French"], ["german", "German"], ["arabic", "Arabic"], ["urdu", "Urdu"], ["bengali", "Bengali"],
];
const PLATFORM_NAMES: Record<Platform, string> = { youtube: "YouTube", instagram: "Instagram", facebook: "Facebook", x: "X", linkedin: "LinkedIn" };
const STEP_NAMES = ["Import", "Transcribe", "Find viral moments", "Write posts", "Render shorts"] as const;
const VIDEO_EXT = /\.(mp4|m4v|mov|webm|mkv|ogv)(\?|$)/i;

type Config = { ai: boolean; model: string; accessCode: boolean; googleClientId?: string };
type Source = { kind: "youtube"; url: string; videoId: string } | { kind: "file"; name: string };
export type Project = {
  id: string; created: number; title: string; summary: string; duration: number; engine: string; transcriptSource: string;
  source: Source; platforms: Platform[]; plan: Plan; sentences: Sentence[];
};
type Settings = {
  count: number; length: number; platforms: Platform[]; tone: string; outLang: string; spokenLang: string;
  layout: Layout; captions: CaptionStyle; hook: boolean; hd: boolean; useAi: boolean;
};
const DEFAULTS: Settings = {
  count: 5, length: 1, platforms: ["youtube", "instagram", "facebook", "x"], tone: "Hype", outLang: OUTPUT_LANGS[0][0],
  spokenLang: "", layout: "auto", captions: "bold", hook: true, hd: false, useAi: true,
};

const store = {
  get<T>(key: string, fallback: T): T {
    try { const v = localStorage.getItem(key); return v ? (JSON.parse(v) as T) : fallback; } catch { return fallback; }
  },
  set(key: string, value: unknown) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage full or blocked */ }
  },
};

function youtubeIdOf(url: string): string | null {
  try {
    const u = new URL(url.trim());
    const host = u.hostname.replace(/^(www|m|music)\./, "");
    let id: string | null = null;
    if (host === "youtu.be") id = u.pathname.slice(1).split("/")[0];
    else if (host.endsWith("youtube.com")) id = u.searchParams.get("v") ?? u.pathname.match(/^\/(shorts|live|embed)\/([^/?#]+)/)?.[2] ?? null;
    return id && /^[A-Za-z0-9_-]{11}$/.test(id) ? id : null;
  } catch {
    return null;
  }
}

function slug(s: string) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "clip";
}

/* ---------------- AI planning ---------------- */

class AccessCodeError extends Error {}

async function askAI<T>(
  body: Record<string, unknown>, accessCode: string, onText: (text: string) => void, signal: AbortSignal,
): Promise<{ data: T; model: string } | null> {
  const res = await fetch("/api/clips", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-access-code": accessCode },
    body: JSON.stringify(body),
    signal,
  });
  if (res.status === 501) return null; // no API key on the server: use offline scoring
  if (res.status === 401) throw new AccessCodeError("Enter the access code to use ViralCut.");
  if (res.status === 504) throw new Error("The AI took too long to answer. Try again, or choose fewer clips.");
  if (!res.ok || !res.body) {
    const err = await res.json().catch(() => ({ error: `Server error ${res.status}` }));
    throw new Error(err.error ?? `Server error ${res.status}`);
  }
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  let text = "";
  let model = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += value;
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const ln of lines) {
      if (!ln.trim()) continue;
      const msg = JSON.parse(ln) as { t: string; d?: string; error?: string; model?: string };
      if (msg.t === "delta" && msg.d) {
        text += msg.d;
        onText(text);
      } else if (msg.t === "error") throw new Error(msg.error ?? "The AI request failed.");
      else if (msg.t === "done") model = msg.model ?? "";
    }
  }
  try {
    if (!text.trim()) throw new Error("empty");
    return { data: extractJson<T>(text), model };
  } catch {
    throw new Error("The AI's answer came back incomplete. Try again, or choose fewer clips or platforms.");
  }
}

type Copy = Pick<ClipPlan, "posts" | "hashtags">;
const tagOf = (t: string) => "#" + String(t).replace(/^#+/, "").replace(/\s+/g, "");

/**
 * Step 2: write the posts and hashtags, up to 5 clips per request (fewer requests = inside free-tier rate limits).
 * Clips whose batch fails get template copy, and the reason is returned so the page can say so.
 */
async function writePosts(
  plan: Plan, sentences: Sentence[], s: Settings, accessCode: string, signal: AbortSignal, onProgress: (done: number) => void,
): Promise<string | null> {
  let problem: string | null = null;
  let done = 0;
  for (let i = 0; i < plan.clips.length; i += 5) {
    const batch = plan.clips.slice(i, i + 5);
    const texts = batch.map((c) => wordsBetween(sentences, c.start, c.end).map((w) => w.text).join(" ") || c.quote);
    let copies: Copy[] = [];
    try {
      const result = await askAI<{ clips?: Copy[] }>(
        { mode: "posts", title: plan.title, clips: batch.map((c, k) => ({ title: c.title, hook: c.hook, text: texts[k] })), platforms: s.platforms, tone: s.tone, language: s.outLang },
        accessCode, () => undefined, signal,
      );
      copies = Array.isArray(result?.data?.clips) ? result!.data.clips : [];
      if (copies.length < batch.length) problem ??= "The AI skipped some clips.";
    } catch (err) {
      if ((err as Error).name === "AbortError" || err instanceof AccessCodeError) throw err;
      problem ??= (err as Error).message;
    }
    batch.forEach((clip, k) => {
      const copy = copies[k];
      const fallback = offlineCopy(clip.title, texts[k], s.platforms);
      clip.posts = Object.fromEntries(s.platforms.map((p) => [p, String(copy?.posts?.[p] ?? "") || fallback.posts[p]!]));
      clip.hashtags = Object.fromEntries(s.platforms.map((p) => {
        const tags = (Array.isArray(copy?.hashtags?.[p]) ? copy!.hashtags[p]! : []).map(tagOf).filter((t) => t.length > 1);
        return [p, tags.length ? tags : fallback.hashtags[p]!];
      }));
    });
    done += batch.length;
    onProgress(done);
  }
  return problem;
}

/** Models sometimes answer "1:23" instead of 83. */
function toSeconds(v: unknown): number {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  const str = String(v ?? "").trim();
  return parseTimestamp(str) ?? (Number(str) || 0);
}

function cleanPlan(raw: Omit<Plan, "engine">, sentences: Sentence[], s: Settings, engine: string): Plan {
  const { min, max } = LENGTHS[s.length];
  const tag = tagOf;
  const taken: [number, number][] = [];
  const clips: ClipPlan[] = [];
  for (const c of Array.isArray(raw.clips) ? raw.clips : []) {
    const snapped = snapToSentences(toSeconds(c.start), toSeconds(c.end), sentences, min, max);
    const { start, end } = snapped;
    if (end - start < Math.max(5, min * 0.5)) continue; // too short to stand alone (e.g. cut off at the end of the video)
    if (taken.some(([a, b]) => Math.min(end, b) - Math.max(start, a) > 0.25 * Math.min(end - start, b - a))) continue;
    taken.push([start, end]);
    clips.push({
      title: String(c.title ?? "Untitled clip"), hook: String(c.hook ?? ""), quote: String(c.quote ?? ""), why: String(c.why ?? ""),
      posts: Object.fromEntries(Object.entries(c.posts ?? {}).map(([k, v]) => [k, String(v ?? "")])),
      start, end,
      virality: Math.max(0, Math.min(100, Math.round(Number(c.virality) || 0))),
      hashtags: Object.fromEntries(Object.entries(c.hashtags ?? {}).map(([k, v]) => [k, (Array.isArray(v) ? v : []).map(tag).filter((t) => t.length > 1)])),
    });
  }
  return {
    title: raw.title || "Your video",
    summary: raw.summary || "",
    clips: clips.sort((a, b) => b.virality - a.virality),
    full_video: {
      x_thread: Array.isArray(raw.full_video?.x_thread) ? raw.full_video.x_thread.map(String) : [],
      linkedin: String(raw.full_video?.linkedin ?? ""),
      instagram: String(raw.full_video?.instagram ?? ""),
    },
    hashtag_bank: { broad: (Array.isArray(raw.hashtag_bank?.broad) ? raw.hashtag_bank.broad : []).map(tag), niche: (Array.isArray(raw.hashtag_bank?.niche) ? raw.hashtag_bank.niche : []).map(tag) },
    engine,
  };
}

/* ---------------- speech recognition ---------------- */

function transcribeInBrowser(audio: Float32Array, language: string, onStatus: (msg: string, fraction: number | null) => void): Promise<Sentence[]> {
  return new Promise((resolve, reject) => {
    const worker = new Worker("/workers/whisper.js", { type: "module" });
    worker.onmessage = (e: MessageEvent) => {
      const m = e.data;
      if (m.type === "download") onStatus(`Downloading the speech model (one time) · ${Math.round((m.loaded / m.total) * 100)}%`, m.loaded / m.total);
      else if (m.type === "ready") onStatus(`Transcribing on ${m.device === "webgpu" ? "your GPU" : "your CPU"}…`, 0);
      else if (m.type === "progress") onStatus(`Transcribing · ${formatTime(m.done * 30)} of ${formatTime(audio.length / 16000)}`, m.done / m.total);
      else if (m.type === "done") {
        worker.terminate();
        const words: Word[] = (m.segments as { text: string; start: number; end: number }[]).flatMap((seg) => spreadWords(seg.text, seg.start, seg.end));
        resolve(wordsToSentences(words));
      } else if (m.type === "error") {
        worker.terminate();
        reject(new Error(`Speech recognition failed: ${m.error}`));
      }
    };
    worker.onerror = (e) => {
      worker.terminate();
      reject(new Error(`Speech recognition couldn't start: ${e.message || "worker error"}`));
    };
    worker.postMessage({ audio, language, model: "Xenova/whisper-base" }, [audio.buffer]);
  });
}

function videoDuration(url: string): Promise<{ duration: number; width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const v = document.createElement("video");
    v.preload = "metadata";
    v.onloadedmetadata = () => resolve({ duration: v.duration, width: v.videoWidth, height: v.videoHeight });
    v.onerror = () => reject(new Error("This browser can't open this video file. Try an MP4 (H.264) file."));
    v.src = url;
  });
}

/* ---------------- saved projects ---------------- */

const PROJECTS_KEY = "viralcut-projects";
const MAX_PROJECTS = 30;
type StoredProject = Omit<Project, "sentences"> & { lines?: [number, number, string][] };

/** Sentences are stored without word timings (re-estimated on load) so many projects fit in browser storage. */
function packProject(p: Project): StoredProject {
  const { sentences, ...rest } = p;
  const r = (n: number) => Math.round(n * 100) / 100;
  return { ...rest, lines: sentences.map((x) => [r(x.start), r(x.end), x.text]) };
}

function unpackProject(sp: StoredProject & { sentences?: Sentence[] }): Project {
  const lines = sp.lines ?? [];
  const sentences = lines.length
    ? lines.map(([a, b, t]) => ({ text: t, start: a, end: b, words: spreadWords(t, a, b) }))
    : (sp.sentences ?? []);
  const { lines: _drop, ...rest } = sp;
  void _drop;
  return { ...rest, sentences } as Project;
}

function saveProjects(list: Project[]) {
  const packed = list.slice(0, MAX_PROJECTS).map(packProject);
  for (let keepTranscripts = packed.length; keepTranscripts >= 0; keepTranscripts--) {
    try {
      // If storage is full, older projects drop their transcripts first (their clips, posts and hashtags stay).
      localStorage.setItem(PROJECTS_KEY, JSON.stringify(packed.map((p, i) => (i < keepTranscripts ? p : { ...p, lines: [] }))));
      return;
    } catch {
      /* quota exceeded: try again with fewer transcripts */
    }
  }
}

/* ---------------- component ---------------- */

export default function Studio() {
  const [config, setConfig] = useState<Config | null>(null);
  const [accessCode, setAccessCode] = useState("");
  const [url, setUrl] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [pasted, setPasted] = useState("");
  const [s, setS] = useState<Settings>(DEFAULTS);
  const [phase, setPhase] = useState<"idle" | "working" | "done">("idle");
  const [step, setStep] = useState(0);
  const [status, setStatus] = useState("");
  const [fraction, setFraction] = useState<number | null>(null);
  const [found, setFound] = useState(0);
  const [error, setError] = useState<{ message: string; askTranscript?: boolean } | null>(null);
  const [project, setProject] = useState<Project | null>(null);
  const [renders, setRenders] = useState<Record<number, RenderState>>({});
  const [history, setHistory] = useState<Project[]>([]);
  const [dragging, setDragging] = useState(false);
  const [toast, setToast] = useState("");
  const [ytPost, setYtPost] = useState<{ index: number; meta: YouTubeMeta; schedule: string; phase: "edit" | "uploading" | "done" | "error"; progress: number; message: string } | null>(null);
  const [posted, setPosted] = useState<Record<number, string>>({});
  const ytDialog = useRef<HTMLDialogElement>(null);
  const toastTimer = useRef<number | undefined>(undefined);
  const abortRef = useRef<AbortController | null>(null);
  const renderVideo = useRef<HTMLVideoElement>(null);
  const fileUrl = useRef<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const exportInput = useRef<HTMLInputElement>(null);
  const createInput = useRef<HTMLInputElement>(null);
  const studioRef = useRef<HTMLElement>(null);

  useEffect(() => {
    fetch("/api/config").then((r) => r.json()).then(setConfig).catch(() => setConfig({ ai: false, model: "", accessCode: false }));
    setAccessCode(store.get("viralcut-code", ""));
    const saved = { ...DEFAULTS, ...store.get<Partial<Settings>>("viralcut-settings", {}) };
    const valid = (list: unknown): Platform[] => (Array.isArray(list) ? list : []).filter((p): p is Platform => (PLATFORMS as readonly string[]).includes(p));
    saved.platforms = valid(saved.platforms).length ? valid(saved.platforms) : DEFAULTS.platforms;
    setS(saved);
    // Older projects may list platforms that were removed (e.g. TikTok).
    setHistory(store.get<StoredProject[]>(PROJECTS_KEY, []).map((h) => {
      const p = unpackProject(h);
      return { ...p, platforms: valid(p.platforms).length ? valid(p.platforms) : DEFAULTS.platforms };
    }));
  }, []);
  useEffect(() => store.set("viralcut-settings", s), [s]);

  const notify = useCallback((msg: string) => {
    setToast(msg);
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(""), msg.length > 60 ? 6000 : 2200);
  }, []);
  const copy = useCallback((text: string) => {
    navigator.clipboard.writeText(text).then(() => notify("Copied"), () => notify("Couldn't copy. Select the text instead."));
  }, [notify]);

  /* ---- whole-page drag & drop ---- */
  useEffect(() => {
    const over = (e: DragEvent) => {
      if (e.dataTransfer?.types.includes("Files")) {
        e.preventDefault();
        setDragging(true);
      }
    };
    const leave = (e: DragEvent) => { if (!e.relatedTarget) setDragging(false); };
    const drop = (e: DragEvent) => {
      e.preventDefault();
      setDragging(false);
      const f = e.dataTransfer?.files?.[0];
      if (f && f.type.startsWith("video/")) chooseFile(f);
    };
    window.addEventListener("dragover", over);
    window.addEventListener("dragleave", leave);
    window.addEventListener("drop", drop);
    return () => {
      window.removeEventListener("dragover", over);
      window.removeEventListener("dragleave", leave);
      window.removeEventListener("drop", drop);
    };
  });

  function chooseFile(f: File) {
    setFile(f);
    setUrl("");
    setError(null);
  }

  const toggle = (p: Platform) =>
    setS((cur) => ({ ...cur, platforms: cur.platforms.includes(p) ? (cur.platforms.length > 1 ? cur.platforms.filter((x) => x !== p) : cur.platforms) : [...cur.platforms, p] }));

  function setSourceVideo(f: Blob) {
    if (fileUrl.current) URL.revokeObjectURL(fileUrl.current);
    fileUrl.current = URL.createObjectURL(f);
    return fileUrl.current;
  }

  /* ---- main pipeline ---- */
  async function generate(e?: React.FormEvent) {
    e?.preventDefault();
    setError(null);
    const link = url.trim();
    if (!file && !link) return setError({ message: "Paste a video link or upload a video file." });
    if (config?.accessCode && !accessCode) return setError({ message: "Enter your access code (under Clip settings) first." });
    abortRef.current?.abort();
    const ctl = new AbortController();
    abortRef.current = ctl;
    const settings = s;
    const { min, max } = LENGTHS[settings.length];
    setPhase("working");
    setProject(null);
    setRenders({});
    setPosted({});
    setFound(0);
    setStep(0);
    setFraction(null);
    window.setTimeout(() => studioRef.current?.scrollIntoView({ behavior: "smooth" }), 50);

    try {
      let sentences: Sentence[] = [];
      let loudness: number[] | null = null;
      let title = "";
      let duration = 0;
      let source: Source;
      let transcriptSource = "";
      let videoBlob: Blob | null = file;

      // 1. import
      setStatus("Importing your video…");
      const ytId = !file ? youtubeIdOf(link) : null;
      if (!file && !ytId) {
        if (!/^https?:\/\//i.test(link)) throw new Error("That doesn't look like a link. It should start with https://");
        if (!VIDEO_EXT.test(link) && !/dropbox(usercontent)?\.com/.test(link)) {
          throw Object.assign(new Error("Twitch, Kick, Google Drive and Loom links can't be read from a website. Download the video and use Upload Video, or paste a direct .mp4 link."), { upload: true });
        }
        const direct = link.replace(/([?&])dl=0/, "$1dl=1");
        const res = await fetch(direct, { signal: ctl.signal }).catch(() => null);
        if (!res || !res.ok) throw new Error("That video link can't be downloaded from the browser (the site blocks it). Download the file and use Upload Video.");
        videoBlob = await res.blob();
      }

      if (ytId) {
        source = { kind: "youtube", url: link, videoId: ytId };
        if (pasted.trim()) {
          sentences = parseTranscript(pasted);
          transcriptSource = hasTimestamps(pasted) ? "pasted transcript" : "pasted transcript (no timestamps, times estimated)";
        } else {
          setStep(1);
          setStatus("Reading the video's speech (long videos can take a couple of minutes)…");
          const res = await fetch("/api/transcript", {
            method: "POST",
            headers: { "Content-Type": "application/json", "x-access-code": accessCode },
            body: JSON.stringify({ url: link }),
            signal: ctl.signal,
          });
          if (res.status === 504) throw Object.assign(new Error("Reading this video took too long. Paste the transcript under Clip settings and try again."), { askTranscript: true });
          const data = await res.json().catch(() => ({ error: `Server error ${res.status}` }));
          if (res.status === 401) throw new AccessCodeError(data.error);
          if (!res.ok) throw Object.assign(new Error(data.error ?? "Couldn't read this video's captions."), { askTranscript: true });
          sentences = data.sentences;
          title = data.title;
          duration = data.duration;
          transcriptSource = data.source === "gemini" ? "Gemini (watched the video)" : `YouTube captions (${data.language})`;
        }
        if (!title) title = "YouTube video";
      } else {
        const blob = videoBlob!;
        const name = file?.name ?? link.split("/").pop()?.split("?")[0] ?? "video";
        source = { kind: "file", name };
        title = name.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ");
        const meta = await videoDuration(setSourceVideo(blob));
        duration = meta.duration;
        setStep(1);
        const audio = await decodeAudio(blob, (m) => setStatus(m));
        loudness = loudnessCurve(audio);
        if (pasted.trim()) {
          sentences = parseTranscript(pasted);
          transcriptSource = hasTimestamps(pasted) ? "pasted transcript" : "pasted transcript (no timestamps, times estimated)";
        } else {
          sentences = await transcribeInBrowser(audio, settings.spokenLang, (m, f) => { setStatus(m); setFraction(f); });
          transcriptSource = "Whisper (in your browser)";
        }
        setFraction(null);
      }
      if (ctl.signal.aborted) return;
      if (sentences.length < 2) throw Object.assign(new Error(pasted.trim() ? "The pasted transcript is too short or couldn't be read. Copy the whole transcript panel from YouTube (with timestamps) and paste it again." : "No speech was found in this video, so there's nothing to clip. Paste a transcript under Clip settings to continue."), { askTranscript: true });
      if (!duration) duration = sentences[sentences.length - 1].end;

      // 2-3. find moments + write posts
      setStep(2);
      setStatus("AI detection: analyzing video content…");
      let plan: Plan | null = null;
      if (settings.useAi && config?.ai) {
        setStep(3);
        const result = await askAI<Omit<Plan, "engine">>(
          {
            mode: "pick", transcript: transcriptText(sentences), title, count: settings.count, minLen: min, maxLen: max,
            platforms: settings.platforms, tone: settings.tone, language: settings.outLang,
          },
          accessCode,
          (text) => {
            const n = (text.match(/"virality"\s*:/g) ?? []).length;
            setFound(n);
            setStatus(n ? `Found ${n} potential clip${n > 1 ? "s" : ""}…` : "AI detection: analyzing video content…");
          },
          ctl.signal,
        );
        if (result) {
          plan = cleanPlan(result.data, sentences, settings, result.model || config.model);
          if (plan.clips.length) {
            const total = plan.clips.length;
            setStatus(`Writing posts & hashtags · 0 of ${total} clips`);
            const problem = await writePosts(plan, sentences, settings, accessCode, ctl.signal, (n) => setStatus(`Writing posts & hashtags · ${n} of ${total} clips`));
            if (problem) plan.notice = `Some posts and hashtags are basic templates because the AI couldn't write them: ${problem}`;
          }
        }
      }
      if (plan && !plan.clips.length) plan = null; // unusable AI answer: fall back to built-in scoring
      if (!plan) {
        plan = offlinePlan(sentences, loudness, LOUDNESS_HOP, title, { count: settings.count, minLen: min, maxLen: max, platforms: settings.platforms });
        if (!config?.ai) plan.engine = "Offline scoring (add a GEMINI_API_KEY for AI)";
      }
      if (!plan.clips.length) throw new Error("Couldn't find any clips of that length. Try a shorter clip length.");
      setFound(plan.clips.length);

      const proj: Project = {
        id: Date.now().toString(36), created: Date.now(), title: plan.title || title, summary: plan.summary, duration,
        engine: plan.engine, transcriptSource, source, platforms: settings.platforms, plan, sentences,
      };
      upsertProject(proj);

      // 4. render
      if (source.kind === "file") {
        setStep(4);
        await renderAll(proj, settings, ctl.signal);
      }
      setPhase("done");
      setStatus("");
    } catch (err) {
      if ((err as Error).name === "AbortError") return;
      const e2 = err as Error & { askTranscript?: boolean };
      setError({ message: e2.message, askTranscript: e2.askTranscript });
      setPhase(project ? "done" : "idle");
    }
  }

  async function renderAll(proj: Project, settings: Settings, signal: AbortSignal) {
    const video = renderVideo.current;
    if (!video || !fileUrl.current) return;
    if (video.src !== fileUrl.current) {
      video.src = fileUrl.current;
      await new Promise<void>((res, rej) => {
        video.onloadeddata = () => res();
        video.onerror = () => rej(new Error("This browser can't play this video file. Try an MP4 (H.264) file in Chrome."));
      });
    }
    const queued: Record<number, RenderState> = {};
    proj.plan.clips.forEach((_, i) => (queued[i] = { status: "queued", progress: 0 }));
    setRenders(queued);
    const W = settings.hd ? 1080 : 720;
    for (let i = 0; i < proj.plan.clips.length; i++) {
      if (signal.aborted) return;
      const clip = proj.plan.clips[i];
      setStatus(`Rendering short ${i + 1} of ${proj.plan.clips.length} · keep this tab open`);
      setRenders((r) => ({ ...r, [i]: { status: "rendering", progress: 0 } }));
      try {
        const out = await renderClip(
          video,
          {
            start: clip.start, end: clip.end, words: wordsBetween(proj.sentences, clip.start, clip.end), hook: clip.hook,
            layout: settings.layout, captionStyle: settings.captions, showHook: settings.hook, width: W, height: Math.round((W * 16) / 9),
          },
          (p) => setRenders((r) => ({ ...r, [i]: { ...r[i], status: "rendering", progress: p } })),
          signal,
        );
        const blobUrl = URL.createObjectURL(out.blob);
        setRenders((r) => ({ ...r, [i]: { status: "done", progress: 1, url: blobUrl, ext: out.ext, thumb: out.thumbnail } }));
      } catch (err) {
        if ((err as Error).name === "AbortError") return;
        setRenders((r) => ({ ...r, [i]: { status: "error", progress: 0, error: `Render failed: ${(err as Error).message}` } }));
      }
    }
  }

  async function exportWithFile(f: File | null) {
    if (!project) return;
    const ctl = new AbortController();
    abortRef.current = ctl;
    if (f) setSourceVideo(f);
    setPhase("working");
    setStep(4);
    setError(null);
    try {
      await renderAll(project, s, ctl.signal);
      const pending = pendingPublish.current;
      pendingPublish.current = null;
      if (pending) notify(`Shorts ready! Click ${PLATFORM_NAMES[pending.platform]} again to publish clip #${pending.index + 1}.`);
    } catch (err) {
      setError({ message: (err as Error).message });
    }
    setPhase("done");
    setStatus("");
  }

  function cancel() {
    abortRef.current?.abort();
    setPhase(project ? "done" : "idle");
    setStatus("");
  }

  /** Save a new or changed project: it becomes the open project and is stored in this browser. */
  function upsertProject(p: Project) {
    setProject(p);
    setHistory((prev) => {
      const next = prev.some((h) => h.id === p.id) ? prev.map((h) => (h.id === p.id ? p : h)) : [p, ...prev];
      saveProjects(next);
      return next;
    });
  }

  function deleteProject(id: string) {
    setHistory((prev) => {
      const next = prev.filter((h) => h.id !== id);
      saveProjects(next);
      return next;
    });
    if (project?.id === id) {
      setProject(null);
      setRenders({});
      setPosted({});
      setPhase("idle");
    }
    notify("Project deleted");
  }

  function deleteAllProjects() {
    setHistory([]);
    saveProjects([]);
    setProject(null);
    setRenders({});
    setPosted({});
    setPhase("idle");
    notify("All projects deleted");
  }

  function renameProject(id: string, title: string) {
    const clean = title.trim();
    if (!clean) return;
    const target = history.find((h) => h.id === id) ?? (project?.id === id ? project : null);
    if (!target) return;
    const renamed = { ...target, title: clean, plan: { ...target.plan, title: clean } };
    if (project?.id === id) upsertProject(renamed);
    else
      setHistory((prev) => {
        const next = prev.map((h) => (h.id === id ? renamed : h));
        saveProjects(next);
        return next;
      });
  }

  function updateClip(index: number, clip: ClipPlan) {
    if (!project) return;
    const clips = project.plan.clips.map((c, i) => (i === index ? clip : c));
    upsertProject({ ...project, plan: { ...project.plan, clips } });
    notify("Clip saved");
  }

  function deleteClip(index: number) {
    if (!project) return;
    const clips = project.plan.clips.filter((_, i) => i !== index);
    const shift = <T,>(m: Record<number, T>) =>
      Object.fromEntries(Object.entries(m).filter(([k]) => Number(k) !== index).map(([k, v]) => [Number(k) > index ? Number(k) - 1 : Number(k), v]));
    setRenders((r) => shift(r));
    setPosted((r) => shift(r));
    upsertProject({ ...project, plan: { ...project.plan, clips } });
    notify("Clip deleted");
  }

  function openProject(p: Project) {
    setProject(p);
    setRenders({});
    setPosted({});
    setPhase("done");
    window.setTimeout(() => studioRef.current?.scrollIntoView({ behavior: "smooth" }), 50);
  }

  /* ---- post to YouTube ---- */
  function openYouTubePost(index: number) {
    const clip = project!.plan.clips[index];
    const tags = clip.hashtags.youtube ?? clip.hashtags[project!.platforms[0]] ?? [];
    const title = clip.posts.youtube || clip.title;
    const description = `${clip.posts.youtube && clip.posts.youtube !== title ? clip.posts.youtube + "\n\n" : ""}${clip.quote ? `"${clip.quote}"\n\n` : ""}${tags.join(" ")}`.trim();
    setYtPost({ index, meta: { title: shortsTitle(title), description, tags, privacy: "public" }, schedule: "", phase: "edit", progress: 0, message: "" });
    window.setTimeout(() => ytDialog.current?.showModal(), 0);
  }

  async function submitYouTube(e: React.FormEvent) {
    e.preventDefault();
    if (!ytPost || !project) return;
    const clientId = config?.googleClientId;
    if (!clientId) return;
    const r = renders[ytPost.index];
    if (!r?.url) return;
    setYtPost({ ...ytPost, phase: "uploading", progress: 0, message: "Signing in to Google…" });
    try {
      const accessToken = await getYouTubeToken(clientId);
      setYtPost((cur) => cur && { ...cur, message: "Uploading to YouTube…" });
      const blob = await (await fetch(r.url)).blob();
      const meta = { ...ytPost.meta, publishAt: ytPost.schedule ? new Date(ytPost.schedule).toISOString() : undefined };
      const id = await uploadToYouTube(accessToken, blob, meta, (f) => setYtPost((cur) => cur && { ...cur, progress: f }));
      const url = `https://youtube.com/shorts/${id}`;
      setPosted((cur) => ({ ...cur, [ytPost.index]: url }));
      setYtPost((cur) => cur && { ...cur, phase: "done", progress: 1, message: url });
    } catch (err) {
      setYtPost((cur) => cur && { ...cur, phase: "error", message: (err as Error).message });
    }
  }

  /* ---- post to other platforms ---- */
  // Facebook, Instagram and X only allow direct API posting for apps they have reviewed (X's API is paid),
  // so: phones get the share sheet with the video attached; computers get the file, the caption on the clipboard,
  // and the platform's upload page (X and LinkedIn with the caption pre-filled).
  function captionFor(clip: ClipPlan, platform: Platform): string {
    const first = project!.platforms[0];
    const text = clip.posts[platform] || clip.posts.youtube || clip.posts[first] || clip.title;
    const tags = clip.hashtags[platform]?.length ? clip.hashtags[platform]! : clip.hashtags[first] ?? [];
    return `${text}\n\n${tags.join(" ")}`.trim();
  }

  async function shareTo(platform: Platform, index: number) {
    const clip = project!.plan.clips[index];
    const r = renders[index];
    if (!r?.url) return;
    const caption = captionFor(clip, platform);
    const fileName = `viralcut-${index + 1}-${slug(clip.title)}.${r.ext}`;
    const name = PLATFORM_NAMES[platform];
    const phone = window.matchMedia("(pointer: coarse)").matches;
    const enc = encodeURIComponent(caption);
    const pages: Record<Platform, string> = {
      instagram: "https://www.instagram.com/",
      facebook: "https://www.facebook.com/reels/create",
      x: `https://x.com/intent/post?text=${enc}`,
      linkedin: `https://www.linkedin.com/feed/?shareActive=true&text=${enc}`,
      youtube: "https://www.youtube.com/upload",
    };
    // Open the tab right away (before any await) so the browser doesn't block it as a pop-up.
    const tab = phone ? null : window.open(pages[platform], "_blank");
    if (tab) tab.opener = null;
    navigator.clipboard.writeText(caption).catch(() => undefined);
    if (phone) {
      try {
        const blob = await (await fetch(r.url)).blob();
        const file = new File([blob], fileName, { type: blob.type || "video/mp4" });
        if (navigator.canShare?.({ files: [file] })) {
          await navigator.share({ files: [file], text: caption, title: clip.title });
          notify(`Caption copied. Paste it in ${name} if it's not filled in.`);
          return;
        }
      } catch (err) {
        if ((err as Error).name === "AbortError") return;
      }
    }
    const a = document.createElement("a");
    a.href = r.url;
    a.download = fileName;
    a.click();
    if (!phone && !tab) {
      notify(`Your browser blocked the new tab. Video downloaded and caption copied. Open ${name} and upload ${fileName}.`);
      return;
    }
    notify(
      platform === "x" || platform === "linkedin"
        ? `Video downloaded and caption filled in. Attach ${fileName} in ${name}.`
        : `Video downloaded and caption copied. In ${name}, upload ${fileName} and paste the caption.`,
    );
  }

  /* ---- publish buttons ---- */
  const pendingPublish = useRef<{ platform: Platform; index: number } | null>(null);
  const [needFile, setNeedFile] = useState<{ platform?: Platform; index: number } | null>(null);
  const needFileDialog = useRef<HTMLDialogElement>(null);

  /** The big Publish buttons. X, Facebook and LinkedIn work right away with a link to the moment; YouTube and Instagram need the short's video. */
  function publish(platform: Platform, index: number) {
    if (!project) return;
    const clip = project.plan.clips[index];
    const r = renders[index];
    if (r?.status === "done" && r.url) {
      if (platform === "youtube" && config?.googleClientId) return openYouTubePost(index);
      return void shareTo(platform, index);
    }
    const vid = project.source.kind === "youtube" ? project.source.videoId : "";
    const momentLink = vid ? `https://youtu.be/${vid}?t=${Math.floor(clip.start)}` : "";
    if (momentLink && (platform === "x" || platform === "facebook" || platform === "linkedin")) {
      const caption = captionFor(clip, platform);
      const enc = encodeURIComponent;
      const url = {
        x: `https://x.com/intent/post?text=${enc(caption)}&url=${enc(momentLink)}`,
        facebook: `https://www.facebook.com/sharer/sharer.php?u=${enc(momentLink)}`,
        linkedin: `https://www.linkedin.com/feed/?shareActive=true&text=${enc(`${caption}\n\n${momentLink}`)}`,
      }[platform];
      const tab = window.open(url, "_blank");
      if (tab) tab.opener = null;
      navigator.clipboard.writeText(`${caption}\n\n${momentLink}`).catch(() => undefined);
      notify(platform === "facebook" ? "Caption copied. Paste it into the Facebook post." : `Post opened in ${PLATFORM_NAMES[platform]} with your caption and a link to this moment.`);
      return;
    }
    createShort(index, platform);
  }

  /** Render the shorts (asking for the video file if this project doesn't have it yet). */
  function createShort(index: number, platform?: Platform) {
    if (!project) return;
    if (renders[index]?.status === "rendering" || renders[index]?.status === "queued") {
      return notify("This short is being created. Keep this tab open, then click the button again.");
    }
    pendingPublish.current = platform ? { platform, index } : null;
    if (fileUrl.current && renderVideo.current?.src) {
      notify("Creating your shorts…");
      void exportWithFile(null);
      return;
    }
    setNeedFile({ platform, index });
    window.setTimeout(() => needFileDialog.current?.showModal(), 0);
  }

  const plan = project?.plan;
  const videoId = project?.source.kind === "youtube" ? project.source.videoId : undefined;
  const allRendered = plan ? plan.clips.every((_, i) => renders[i]?.status === "done") : false;
  const timelineEnd = plan ? Math.max(project!.duration, ...plan.clips.map((c) => c.end)) : 1;

  return (
    <>
      {dragging && <div className="drop-overlay">Drop your video to start</div>}
      <section className="hero" id="top">
        <div className="sky" />
        <div className="stars" />
        <svg className="hills" viewBox="0 0 1440 190" preserveAspectRatio="none" aria-hidden="true">
          <path d="M0 120 C 180 70, 330 140, 520 96 S 860 60, 1040 104 S 1300 80, 1440 100 V190 H0Z" fill="#1a1530" />
          <path d="M0 150 C 220 112, 420 168, 640 136 S 1040 118, 1240 150 S 1380 140, 1440 146 V190 H0Z" fill="#100d1f" />
          <path d="M0 176 C 300 158, 600 186, 900 168 S 1300 172, 1440 170 V190 H0Z" fill="#060914" />
        </svg>
        <div className="wrap hero-inner">
          <span className="new-pill"><b>NEW</b> Face-tracking reframes + AI-written posts for every platform</span>
          <h1>Turn One Video Into <em>Viral Shorts</em> Automatically</h1>
          <p className="lede">
            Paste a YouTube link or upload a video. ViralCut finds the best moments, adds captions, and generates ready-to-post
            clips with posts and hashtags for YouTube Shorts, Instagram Reels, Facebook and X in minutes.
          </p>
          <form className="composer" onSubmit={generate}>
            <span className="free-tag">⚡ Free to use · no sign-up · runs in your browser</span>
            <div className="composer-row">
              <div className="link-box">
                <YouTube size={22} />
                {file ? (
                  <input value={`📁 ${file.name} (${(file.size / 1e6).toFixed(0)} MB)`} readOnly aria-label="Selected file" />
                ) : (
                  <input
                    type="url"
                    inputMode="url"
                    placeholder="Paste a YouTube, Dropbox or direct video link…"
                    value={url}
                    onChange={(e) => setUrl(e.target.value)}
                    aria-label="Video link"
                  />
                )}
                {file && <button type="button" className="btn small ghost" onClick={() => setFile(null)} aria-label="Remove file">✕</button>}
                <button className="btn primary" type="submit" disabled={phase === "working"}>
                  {phase === "working" ? "Working…" : "Generate Clips ›"}
                </button>
              </div>
              <span className="or">or</span>
              <button type="button" className="btn" onClick={() => fileInput.current?.click()}>
                <Upload /> Upload Video
              </button>
              <input ref={fileInput} type="file" accept="video/*" hidden onChange={(e) => e.target.files?.[0] && chooseFile(e.target.files[0])} />
            </div>
            <div className="works">
              <span>Works with</span>
              <span className="icons"><YouTube /><Dropbox /><Drive /><Twitch /><Kick /><Loom /></span>
              <span>+ any video file</span>
            </div>
            <span className="fineprint">No credit card · Captions added automatically · Your video never leaves your computer</span>
          </form>

          {error && (
            <div className="error-box" role="alert">
              <span>{error.message}</span>
              {error.askTranscript && (
                <span>
                  Open <b>Clip settings</b> below and paste the transcript (on YouTube: <b>…more → Show transcript</b>, select all, copy), or{" "}
                  <button type="button" className="btn small" onClick={() => fileInput.current?.click()}>upload the video file</button>
                </span>
              )}
            </div>
          )}

          <details className="advanced" open={Boolean(error?.askTranscript) || undefined}>
            <summary>Clip settings</summary>
            <div className="opts">
              <div className="opt">
                <span className="label">Number of clips</span>
                <div className="chips">{COUNTS.map((n) => <button key={n} type="button" className="chip" aria-pressed={s.count === n} onClick={() => setS({ ...s, count: n })}>{n}</button>)}</div>
              </div>
              <div className="opt">
                <span className="label">Clip length</span>
                <div className="chips">{LENGTHS.map((l, i) => <button key={l.label} type="button" className="chip" aria-pressed={s.length === i} onClick={() => setS({ ...s, length: i })}>{l.label}</button>)}</div>
              </div>
              <div className="opt" style={{ gridColumn: "1 / -1" }}>
                <span className="label">Post to</span>
                <div className="chips">
                  {PLATFORMS.map((p) => {
                    const Icon = PLATFORM_ICONS[p];
                    return <button key={p} type="button" className="chip" aria-pressed={s.platforms.includes(p)} onClick={() => toggle(p)}><Icon size={14} /> {PLATFORM_LABELS[p]}</button>;
                  })}
                </div>
              </div>
              <div className="opt">
                <span className="label">Tone</span>
                <div className="chips">{TONES.map((t) => <button key={t} type="button" className="chip" aria-pressed={s.tone === t} onClick={() => setS({ ...s, tone: t })}>{t}</button>)}</div>
              </div>
              <div className="opt">
                <label htmlFor="outLang">Write posts in</label>
                <select id="outLang" className="field" value={s.outLang} onChange={(e) => setS({ ...s, outLang: e.target.value })}>
                  {OUTPUT_LANGS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                </select>
              </div>
              <div className="opt">
                <label htmlFor="layout">Framing</label>
                <select id="layout" className="field" value={s.layout} onChange={(e) => setS({ ...s, layout: e.target.value as Layout })}>
                  <option value="auto">Auto (face tracking for wide videos)</option>
                  <option value="track">AI face-tracking crop</option>
                  <option value="fit">Full frame + blurred background</option>
                  <option value="center">Center crop</option>
                </select>
              </div>
              <div className="opt">
                <label htmlFor="captions">Captions</label>
                <select id="captions" className="field" value={s.captions} onChange={(e) => setS({ ...s, captions: e.target.value as CaptionStyle })}>
                  <option value="bold">Bold pop (yellow highlight)</option>
                  <option value="karaoke">Karaoke (green highlight)</option>
                  <option value="neon">Neon glow</option>
                  <option value="minimal">Minimal</option>
                  <option value="none">No captions</option>
                </select>
              </div>
              <div className="opt">
                <label htmlFor="spoken">Spoken language (uploads)</label>
                <select id="spoken" className="field" value={s.spokenLang} onChange={(e) => setS({ ...s, spokenLang: e.target.value })}>
                  {SPOKEN_LANGS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                </select>
              </div>
              <div className="opt">
                <span className="label">Options</span>
                <label className="check"><input type="checkbox" checked={s.hook} onChange={(e) => setS({ ...s, hook: e.target.checked })} /> Hook title in first 3s</label>
                <label className="check"><input type="checkbox" checked={s.hd} onChange={(e) => setS({ ...s, hd: e.target.checked })} /> 1080p export (slower)</label>
                <label className="check"><input type="checkbox" checked={s.useAi} disabled={!config?.ai} onChange={(e) => setS({ ...s, useAi: e.target.checked })} /> Use AI for clips & posts {config?.ai ? `(${config.model.split(" · ")[0]})` : "(not set up)"}</label>
              </div>
              {config?.accessCode && (
                <div className="opt">
                  <label htmlFor="code">Access code</label>
                  <input id="code" className="field" type="password" value={accessCode} onChange={(e) => { setAccessCode(e.target.value); store.set("viralcut-code", e.target.value); }} />
                </div>
              )}
              <div className="opt" style={{ gridColumn: "1 / -1" }}>
                <label htmlFor="pasted">Transcript (optional)</label>
                <textarea id="pasted" className="field" placeholder={"Paste a YouTube transcript or .srt to skip speech recognition:\n0:00\nSo today we're talking about…"} value={pasted} onChange={(e) => setPasted(e.target.value)} />
              </div>
            </div>
          </details>
        </div>
      </section>

      <section className="studio" ref={studioRef} id="studio">
        <div className="wrap">
          {phase === "working" && (
            <div className="panel progress-panel" aria-live="polite">
              <div className="detect-card">
                <div className="detect-head"><span className="dot" /> {status || "Working…"}</div>
                <div className={`bar${fraction === null ? " indeterminate" : ""}`}><i style={{ width: `${Math.round((fraction ?? 0) * 100)}%` }} /></div>
                {found > 0 && <span className="muted">Found {found} potential clips</span>}
              </div>
              <ol className="steps">
                {STEP_NAMES.map((n, i) => <li key={n} className={i < step ? "done" : i === step ? "active" : ""}>{n}</li>)}
              </ol>
              <div className="row"><button type="button" className="btn small" onClick={cancel}>Stop</button></div>
            </div>
          )}

          {project && plan && (
            <div style={{ marginTop: phase === "working" ? 22 : 0 }}>
              <div className="results-head">
                <div>
                  <span className="eyebrow">{plan.clips.length} viral shorts</span>
                  <ProjectTitle title={project.title} onRename={(t) => renameProject(project.id, t)} onDelete={() => deleteProject(project.id)} />
                  <p>{plan.summary}</p>
                  {plan.notice && <p className="notice">⚠️ {plan.notice}</p>}
                  <p className="fineprint">{formatTime(project.duration)} video · {project.engine} · transcript: {project.transcriptSource}</p>
                </div>
                {allRendered && (
                  <button type="button" className="btn primary" onClick={() => plan.clips.forEach((c, i) => {
                    const r = renders[i];
                    if (!r?.url) return;
                    const a = document.createElement("a");
                    a.href = r.url;
                    a.download = `viralcut-${i + 1}-${slug(c.title)}.${r.ext}`;
                    a.click();
                  })}>⬇ Download all shorts</button>
                )}
              </div>

              <div className="timeline">
                <div className="track">
                  {plan.clips.map((c, i) => (
                    <button key={i} type="button" className="seg" title={c.title} aria-label={`Clip ${i + 1}: ${c.title}`}
                      style={{ left: `${(c.start / timelineEnd) * 100}%`, width: `${Math.max(((c.end - c.start) / timelineEnd) * 100, 2)}%` }}
                      onClick={() => document.getElementById(`clip-${i}`)?.scrollIntoView({ behavior: "smooth" })}>{i + 1}</button>
                  ))}
                </div>
                <div className="ticks">{[0, 0.25, 0.5, 0.75, 1].map((f) => <span key={f}>{formatTime(timelineEnd * f)}</span>)}</div>
              </div>

              {phase === "done" && Object.keys(renders).length === 0 && (
                <div className="export-drop">
                  <span>
                    <b>Export 9:16 MP4s with captions:</b>{" "}
                    {videoId ? "add the video file and ViralCut renders every clip in your browser." : "add the original video file again to render these clips."}
                  </span>
                  <button type="button" className="btn" onClick={() => exportInput.current?.click()}><Upload /> Add video file</button>
                  <input ref={exportInput} type="file" accept="video/*" hidden onChange={(e) => e.target.files?.[0] && exportWithFile(e.target.files[0])} />
                </div>
              )}

              <div className="clips">
                {plan.clips.map((c, i) => (
                  <ClipCard key={`${project.id}-${i}`} index={i} clip={c} platforms={project.platforms} videoId={videoId}
                    render={renders[i]} onCopy={copy} onPublish={(p) => publish(p, i)} onCreate={() => createShort(i)} onUpdate={(c) => updateClip(i, c)} onDelete={() => deleteClip(i)} postedUrl={posted[i]} fileName={`viralcut-${i + 1}-${slug(c.title)}`} />
                ))}
              </div>

              <div className="grid-2">
                <div className="panel">
                  <h3>📣 Posts for the full video</h3>
                  {plan.full_video.x_thread.length > 0 && (
                    <>
                      <ol className="thread">
                        {plan.full_video.x_thread.map((t, i) => <li key={i}><b>{i + 1}/{plan.full_video.x_thread.length}</b><p>{t}</p></li>)}
                      </ol>
                      <div className="row" style={{ marginTop: 10 }}><button type="button" className="btn small" onClick={() => copy(plan.full_video.x_thread.join("\n\n"))}>Copy X thread</button></div>
                    </>
                  )}
                  {plan.full_video.linkedin && (
                    <div className="post-box" style={{ marginTop: 14 }}>
                      <b>LinkedIn</b><p className="post-text">{plan.full_video.linkedin}</p>
                      <div className="row"><button type="button" className="btn small" onClick={() => copy(plan.full_video.linkedin)}>Copy</button></div>
                    </div>
                  )}
                  {plan.full_video.instagram && (
                    <div className="post-box" style={{ marginTop: 10 }}>
                      <b>Instagram</b><p className="post-text">{plan.full_video.instagram}</p>
                      <div className="row"><button type="button" className="btn small" onClick={() => copy(plan.full_video.instagram)}>Copy</button></div>
                    </div>
                  )}
                </div>
                <div className="panel">
                  <h3># Hashtag bank</h3>
                  <span className="label muted">Broad reach</span>
                  <div className="tags" style={{ margin: "6px 0 14px" }}>{plan.hashtag_bank.broad.map((t) => <span key={t}>{t}</span>)}</div>
                  <span className="label muted">Niche & topic</span>
                  <div className="tags" style={{ margin: "6px 0 14px" }}>{plan.hashtag_bank.niche.map((t) => <span key={t}>{t}</span>)}</div>
                  <button type="button" className="btn small" onClick={() => copy([...plan.hashtag_bank.broad, ...plan.hashtag_bank.niche].join(" "))}>Copy all hashtags</button>

                </div>
              </div>
            </div>
          )}

          {history.length > 0 && (
            <ProjectsPanel
              projects={history}
              openId={project?.id}
              onOpen={openProject}
              onRename={renameProject}
              onDelete={deleteProject}
              onDeleteAll={deleteAllProjects}
            />
          )}
        </div>
      </section>

      <video ref={renderVideo} playsInline preload="auto" style={{ position: "fixed", width: 2, height: 2, opacity: 0, pointerEvents: "none", left: 0, bottom: 0 }} />

      <dialog ref={ytDialog} className="modal" onClose={() => setYtPost(null)}>
        {ytPost && !config?.googleClientId && (
          <div>
            <h3>Set up YouTube posting</h3>
            <p className="muted">Posting needs a free Google OAuth client ID for this website (one-time, about 10 minutes):</p>
            <ol className="setup-steps">
              <li>Open <b>console.cloud.google.com</b>, create a project, then enable <b>YouTube Data API v3</b>.</li>
              <li><b>Google Auth Platform → Branding</b>: fill in the app name and your email. <b>Audience</b>: External, and add your Google account as a <b>test user</b>.</li>
              <li><b>Clients → Create client → Web application</b>. Under <b>Authorized JavaScript origins</b> add <code>{typeof window !== "undefined" ? window.location.origin : ""}</code>.</li>
              <li>Copy the <b>Client ID</b>. In Vercel, add the environment variable <code>GOOGLE_CLIENT_ID</code> with it and redeploy.</li>
            </ol>
            <div className="modal-actions"><button type="button" className="btn primary" onClick={() => ytDialog.current?.close()}>OK</button></div>
          </div>
        )}
        {ytPost && config?.googleClientId && (
          <form onSubmit={submitYouTube}>
            <h3>Post to YouTube Shorts</h3>
            <p className="muted" style={{ margin: 0 }}>Uploads this short to the YouTube channel you sign in with.</p>
            <label htmlFor="ytTitle">Title <span className="muted">({ytPost.meta.title.length}/100)</span></label>
            <input id="ytTitle" className="field" maxLength={100} required value={ytPost.meta.title} disabled={ytPost.phase !== "edit" && ytPost.phase !== "error"}
              onChange={(e) => setYtPost({ ...ytPost, meta: { ...ytPost.meta, title: e.target.value } })} />
            <label htmlFor="ytDesc">Description & hashtags</label>
            <textarea id="ytDesc" className="field" rows={5} value={ytPost.meta.description} disabled={ytPost.phase !== "edit" && ytPost.phase !== "error"} style={{ fontFamily: "var(--sans)" }}
              onChange={(e) => setYtPost({ ...ytPost, meta: { ...ytPost.meta, description: e.target.value } })} />
            <label>Visibility</label>
            <div className="chips">
              {(["public", "unlisted", "private"] as const).map((v) => (
                <button key={v} type="button" className="chip" aria-pressed={!ytPost.schedule && ytPost.meta.privacy === v} disabled={ytPost.phase === "uploading"}
                  onClick={() => setYtPost({ ...ytPost, schedule: "", meta: { ...ytPost.meta, privacy: v } })}>{v[0].toUpperCase() + v.slice(1)}</button>
              ))}
            </div>
            <p className="fineprint" style={{ marginTop: 10 }}>
              Google keeps uploads from new, unreviewed apps <b>private</b>. If that happens, open YouTube Studio and switch the video to Public.
            </p>
            {ytPost.phase === "uploading" && (
              <div style={{ display: "grid", gap: 6, marginTop: 10 }}>
                <span className="muted">{ytPost.message} {Math.round(ytPost.progress * 100)}%</span>
                <div className="bar"><i style={{ width: `${Math.round(ytPost.progress * 100)}%` }} /></div>
              </div>
            )}
            {ytPost.phase === "error" && <p className="error-box" style={{ marginTop: 10 }}>{ytPost.message}</p>}
            {ytPost.phase === "done" && (
              <p className="notice" style={{ color: "#b8f5d2", borderColor: "rgba(53,208,127,.4)", background: "rgba(53,208,127,.08)" }}>
                ✓ Uploaded! <a href={ytPost.message} target="_blank" rel="noopener noreferrer">{ytPost.message}</a>. YouTube may take a few minutes to process it.
              </p>
            )}
            <div className="modal-actions">
              <button type="button" className="btn ghost" onClick={() => ytDialog.current?.close()}>{ytPost.phase === "done" ? "Close" : "Cancel"}</button>
              {ytPost.phase !== "done" && (
                <button type="submit" className="btn yt-btn" disabled={ytPost.phase === "uploading"}>
                  {ytPost.phase === "uploading" ? "Uploading…" : "Post to YouTube"}
                </button>
              )}
            </div>
          </form>
        )}
      </dialog>

      <dialog ref={needFileDialog} className="modal" onClose={() => setNeedFile(null)}>
        {needFile && (
          <div>
            <h3>{needFile.platform ? `${PLATFORM_NAMES[needFile.platform]} needs the video itself` : "Create the short"}</h3>
            <p className="muted">
              {needFile.platform === "youtube" || needFile.platform === "instagram"
                ? `${needFile.platform === "youtube" ? "YouTube Shorts" : "Instagram Reels"} only accept an uploaded video, not a link. `
                : ""}
              ViralCut turns each clip into a vertical 9:16 short with captions, right here in your browser. It needs the
              original video file once (the same video you pasted the link for).
            </p>
            <ol className="setup-steps">
              <li>Click <b>Choose video file</b> and pick the video (MP4) from your computer.</li>
              <li>Keep this tab open while the shorts are created (about as long as each clip).</li>
              <li>Click <b>{needFile.platform ? PLATFORM_NAMES[needFile.platform] : "Publish"}</b> again to post it.</li>
            </ol>
            <p className="fineprint">Don&apos;t have the file? Facebook and X work without it: they post a link to this moment.</p>
            <div className="modal-actions">
              <button type="button" className="btn ghost" onClick={() => needFileDialog.current?.close()}>Cancel</button>
              <button type="button" className="btn primary" onClick={() => { needFileDialog.current?.close(); createInput.current?.click(); }}>Choose video file</button>
            </div>
          </div>
        )}
      </dialog>

      <input ref={createInput} type="file" accept="video/*" hidden onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) void exportWithFile(f); }} />
      <div className={`toast${toast ? " show" : ""}`} role="status">{toast}</div>
    </>
  );
}
