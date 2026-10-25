"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import ClipCard, { type RenderState } from "./ClipCard";
import { Drive, Dropbox, Kick, Loom, PLATFORM_ICONS, Twitch, Upload, YouTube } from "./icons";
import { offlinePlan } from "@/lib/analysis";
import { LOUDNESS_HOP, decodeAudio, loudnessCurve } from "@/lib/audio";
import { buildIcs, nextBestTime, type ScheduledPost } from "@/lib/ics";
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
const STEP_NAMES = ["Import", "Transcribe", "Find viral moments", "Write posts", "Render shorts"] as const;
const VIDEO_EXT = /\.(mp4|m4v|mov|webm|mkv|ogv)(\?|$)/i;

type Config = { ai: boolean; model: string; accessCode: boolean };
type Source = { kind: "youtube"; url: string; videoId: string } | { kind: "file"; name: string };
type Project = {
  id: string; created: number; title: string; summary: string; duration: number; engine: string; transcriptSource: string;
  source: Source; platforms: Platform[]; plan: Plan; sentences: Sentence[];
};
type Settings = {
  count: number; length: number; platforms: Platform[]; tone: string; outLang: string; spokenLang: string;
  layout: Layout; captions: CaptionStyle; hook: boolean; hd: boolean; useAi: boolean;
};
const DEFAULTS: Settings = {
  count: 5, length: 1, platforms: ["tiktok", "instagram", "youtube", "x"], tone: "Hype", outLang: OUTPUT_LANGS[0][0],
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

async function planWithAI(
  body: Record<string, unknown>, accessCode: string, onText: (text: string) => void, signal: AbortSignal,
): Promise<{ plan: Omit<Plan, "engine">; model: string } | null> {
  const res = await fetch("/api/clips", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-access-code": accessCode },
    body: JSON.stringify(body),
    signal,
  });
  if (res.status === 501) return null; // no API key on the server: use offline scoring
  if (res.status === 401) throw new AccessCodeError("Enter the access code to use ViralCut.");
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
    return { plan: extractJson<Omit<Plan, "engine">>(text), model };
  } catch {
    throw new Error("The AI's answer came back incomplete. Try again, or choose fewer clips or platforms.");
  }
}

/** Models sometimes answer "1:23" instead of 83. */
function toSeconds(v: unknown): number {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  const str = String(v ?? "").trim();
  return parseTimestamp(str) ?? (Number(str) || 0);
}

function cleanPlan(raw: Omit<Plan, "engine">, sentences: Sentence[], s: Settings, engine: string): Plan {
  const { min, max } = LENGTHS[s.length];
  const tag = (t: string) => "#" + String(t).replace(/^#+/, "").replace(/\s+/g, "");
  const taken: [number, number][] = [];
  const clips: ClipPlan[] = [];
  for (const c of Array.isArray(raw.clips) ? raw.clips : []) {
    const snapped = snapToSentences(toSeconds(c.start), toSeconds(c.end), sentences, min, max);
    const { start, end } = snapped;
    if (end <= start) continue;
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
  const [schedule, setSchedule] = useState<ScheduledPost[]>([]);
  const [history, setHistory] = useState<Project[]>([]);
  const [dragging, setDragging] = useState(false);
  const [toast, setToast] = useState("");
  const [sched, setSched] = useState<{ clip: ClipPlan; platform: Platform; time: string; caption: string } | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const renderVideo = useRef<HTMLVideoElement>(null);
  const fileUrl = useRef<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const exportInput = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const studioRef = useRef<HTMLElement>(null);

  useEffect(() => {
    fetch("/api/config").then((r) => r.json()).then(setConfig).catch(() => setConfig({ ai: false, model: "", accessCode: false }));
    setAccessCode(store.get("viralcut-code", ""));
    setS({ ...DEFAULTS, ...store.get<Partial<Settings>>("viralcut-settings", {}) });
    setHistory(store.get<Project[]>("viralcut-projects", []));
  }, []);
  useEffect(() => store.set("viralcut-settings", s), [s]);
  useEffect(() => {
    if (project) store.set(`viralcut-schedule-${project.id}`, schedule);
  }, [schedule, project]);

  const notify = useCallback((msg: string) => {
    setToast(msg);
    window.setTimeout(() => setToast(""), 2000);
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
          const data = await res.json();
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
        const result = await planWithAI(
          {
            transcript: transcriptText(sentences), title, count: settings.count, minLen: min, maxLen: max,
            platforms: settings.platforms, tone: settings.tone, language: settings.outLang,
          },
          accessCode,
          (text) => {
            const n = (text.match(/"virality"\s*:/g) ?? []).length;
            setFound(n);
            setStatus(n ? `Found ${n} potential clip${n > 1 ? "s" : ""} · writing posts & hashtags…` : "AI detection: analyzing video content…");
          },
          ctl.signal,
        );
        if (result) plan = cleanPlan(result.plan, sentences, settings, result.model || config.model);
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
      setProject(proj);
      setSchedule([]);
      const nextHistory = [{ ...proj, sentences: [] }, ...history.filter((h) => h.id !== proj.id)].slice(0, 8);
      setHistory(nextHistory);
      store.set("viralcut-projects", nextHistory);

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

  async function exportWithFile(f: File) {
    if (!project) return;
    const ctl = new AbortController();
    abortRef.current = ctl;
    setSourceVideo(f);
    setPhase("working");
    setStep(4);
    setError(null);
    try {
      await renderAll(project, s, ctl.signal);
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

  function openProject(p: Project) {
    setProject(p);
    setRenders({});
    setSchedule(store.get<ScheduledPost[]>(`viralcut-schedule-${p.id}`, []));
    setPhase("done");
    window.setTimeout(() => studioRef.current?.scrollIntoView({ behavior: "smooth" }), 50);
  }

  /* ---- scheduling ---- */
  function openSchedule(clip: ClipPlan, platform: Platform) {
    const t = nextBestTime(platform);
    const local = new Date(t.getTime() - t.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
    setSched({ clip, platform, time: local, caption: `${clip.posts[platform] ?? ""}\n\n${(clip.hashtags[platform] ?? []).join(" ")}`.trim() });
    window.setTimeout(() => dialogRef.current?.showModal(), 0);
  }
  function changeSchedPlatform(p: Platform) {
    if (!sched) return;
    const t = nextBestTime(p);
    const local = new Date(t.getTime() - t.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
    setSched({ ...sched, platform: p, time: local, caption: `${sched.clip.posts[p] ?? ""}\n\n${(sched.clip.hashtags[p] ?? []).join(" ")}`.trim() });
  }
  function saveSchedule(e: React.FormEvent) {
    e.preventDefault();
    if (!sched) return;
    const item: ScheduledPost = { id: `${Date.now()}`, clipTitle: sched.clip.title, platform: PLATFORM_LABELS[sched.platform], time: new Date(sched.time).toISOString(), caption: sched.caption };
    setSchedule((cur) => [...cur, item].sort((a, b) => a.time.localeCompare(b.time)));
    dialogRef.current?.close();
    notify("Added to your posting schedule");
  }
  const icsUrl = useMemo(() => (schedule.length ? URL.createObjectURL(new Blob([buildIcs(schedule)], { type: "text/calendar" })) : ""), [schedule]);

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
            clips with posts and hashtags for TikTok, Reels, and Shorts in minutes.
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
                  <h2>{project.title}</h2>
                  <p>{plan.summary}</p>
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
                    render={renders[i]} onCopy={copy} onSchedule={openSchedule} fileName={`viralcut-${i + 1}-${slug(c.title)}`} />
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

                  <h3 style={{ marginTop: 26 }}>🗓 Posting schedule</h3>
                  {schedule.length === 0 ? (
                    <p className="muted" style={{ margin: 0 }}>Click <b>Schedule</b> on a clip to plan when it goes out. ViralCut suggests peak times per platform.</p>
                  ) : (
                    <>
                      <ul className="schedule-list">
                        {schedule.map((p) => (
                          <li key={p.id}>
                            <b>{p.platform}</b>
                            <span className="mono">{new Date(p.time).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}</span>
                            <span className="t">{p.clipTitle}</span>
                            <button type="button" className="btn small" onClick={() => copy(p.caption)}>Copy</button>
                            <button type="button" className="btn small ghost" aria-label="Remove" onClick={() => setSchedule((cur) => cur.filter((x) => x.id !== p.id))}>✕</button>
                          </li>
                        ))}
                      </ul>
                      <a className="btn small" style={{ marginTop: 12 }} href={icsUrl} download="viralcut-schedule.ics">Add to calendar (.ics)</a>
                    </>
                  )}
                </div>
              </div>
            </div>
          )}

          {phase === "idle" && !project && history.length > 0 && (
            <div className="panel">
              <h3>Recent projects</h3>
              <div className="row">
                {history.map((h) => (
                  <button key={h.id} type="button" className="btn small" onClick={() => openProject(h)}>
                    {h.title.slice(0, 40)} · {h.plan.clips.length} clips
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      </section>

      <video ref={renderVideo} playsInline preload="auto" style={{ position: "fixed", width: 2, height: 2, opacity: 0, pointerEvents: "none", left: 0, bottom: 0 }} />

      <dialog ref={dialogRef} className="modal" onClose={() => setSched(null)}>
        {sched && (
          <form onSubmit={saveSchedule}>
            <h3>Schedule this short</h3>
            <p className="muted" style={{ margin: 0 }}>{sched.clip.title}</p>
            <label>Platform</label>
            <div className="chips">
              {project?.platforms.map((p) => {
                const Icon = PLATFORM_ICONS[p];
                return <button key={p} type="button" className="chip" aria-pressed={sched.platform === p} onClick={() => changeSchedPlatform(p)}><Icon size={14} /> {PLATFORM_LABELS[p]}</button>;
              })}
            </div>
            <label htmlFor="when">When <span className="muted">(suggested peak time)</span></label>
            <input id="when" className="field" type="datetime-local" required value={sched.time} onChange={(e) => setSched({ ...sched, time: e.target.value })} />
            <label htmlFor="cap">Caption</label>
            <textarea id="cap" className="field" rows={6} value={sched.caption} onChange={(e) => setSched({ ...sched, caption: e.target.value })} style={{ fontFamily: "var(--sans)" }} />
            <div className="modal-actions">
              <button type="button" className="btn ghost" onClick={() => dialogRef.current?.close()}>Cancel</button>
              <button type="submit" className="btn primary">Add to schedule</button>
            </div>
          </form>
        )}
      </dialog>

      <div className={`toast${toast ? " show" : ""}`} role="status">{toast}</div>
    </>
  );
}
