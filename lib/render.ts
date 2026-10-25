/**
 * Browser-only renderer: plays the source video through a canvas, reframes it to 9:16 around the
 * speaker's face, draws word-by-word captions and the hook title, and records the result with
 * MediaRecorder (MP4 where the browser supports it, otherwise WebM). Rendering runs in real time.
 */
import type { Word } from "./types.ts";

export type Layout = "auto" | "track" | "fit" | "center";
export type CaptionStyle = "bold" | "karaoke" | "neon" | "minimal" | "none";

export type RenderJob = {
  start: number;
  end: number;
  words: Word[];
  hook: string;
  layout: Layout;
  captionStyle: CaptionStyle;
  showHook: boolean;
  width: number;
  height: number;
};

const STYLES: Record<Exclude<CaptionStyle, "none">, { fill: string; active: string; stroke: number; upper: boolean; size: number; glow?: string }> = {
  bold: { fill: "#ffffff", active: "#ffe51a", stroke: 0.16, upper: true, size: 0.06 },
  karaoke: { fill: "#ffffff", active: "#39f05a", stroke: 0.14, upper: true, size: 0.056 },
  neon: { fill: "#e9f6ff", active: "#ff4fd8", stroke: 0.1, upper: false, size: 0.054, glow: "#ff4fd8" },
  minimal: { fill: "#ffffff", active: "#ffffff", stroke: 0.08, upper: false, size: 0.045 },
};

const FONT_STACK = '"Anton", "Arial Black", "Impact", system-ui, sans-serif';

/* ---------------- face tracking ---------------- */

type Detector = { detectForVideo(frame: HTMLVideoElement, ts: number): { detections: { boundingBox?: { originX: number; width: number; height: number } }[] } };
let detectorPromise: Promise<Detector | null> | null = null;

const MP_VERSION = "1.0.1";

/** MediaPipe BlazeFace, loaded on first use. Resolves null if it can't load (renders fall back to center). */
export function loadFaceDetector(): Promise<Detector | null> {
  detectorPromise ??= (async () => {
    try {
      const vision = await import("@mediapipe/tasks-vision");
      const fileset = await vision.FilesetResolver.forVisionTasks(`https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MP_VERSION}/wasm`);
      return (await vision.FaceDetector.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: "/models/blaze_face_short_range.tflite", delegate: "GPU" },
        runningMode: "VIDEO",
        minDetectionConfidence: 0.5,
      })) as unknown as Detector;
    } catch (err) {
      console.warn("Face detection unavailable, using center framing", err);
      return null;
    }
  })();
  return detectorPromise;
}

class Camera {
  cam: number;
  target: number;
  locked = false;
  pending: number[] = [];
  srcW: number;
  cropW: number;
  constructor(srcW: number, cropW: number) {
    this.srcW = srcW;
    this.cropW = cropW;
    this.cam = this.target = srcW / 2;
  }
  observe(cx: number | null) {
    if (cx === null) return;
    if (!this.locked) {
      this.cam = this.target = cx;
      this.locked = true;
    } else if (Math.abs(cx - this.target) > this.cropW * 0.5) {
      this.pending.push(cx); // a big jump: new shot or new speaker; cut once two detections agree
      const n = this.pending.length;
      if (n >= 2 && Math.abs(this.pending[n - 1] - this.pending[n - 2]) < this.cropW * 0.3) {
        this.cam = this.target = cx;
        this.pending = [];
      }
    } else {
      this.pending = [];
      this.target = cx;
    }
  }
  x(): number {
    const d = this.target - this.cam;
    if (Math.abs(d) > this.cropW * 0.04) this.cam += d * 0.09;
    return Math.max(0, Math.min(this.srcW - this.cropW, this.cam - this.cropW / 2));
  }
}

/* ---------------- captions ---------------- */

export function chunkWords(words: Word[], maxWords = 3, maxChars = 18, maxGap = 0.6): Word[][] {
  const chunks: Word[][] = [];
  let cur: Word[] = [];
  for (const w of words) {
    const len = cur.reduce((n, x) => n + x.text.length + 1, 0);
    if (cur.length && (cur.length >= maxWords || len + w.text.length > maxChars || w.start - cur[cur.length - 1].end > maxGap || /[.!?,]$/.test(cur[cur.length - 1].text))) {
      chunks.push(cur);
      cur = [];
    }
    cur.push(w);
  }
  if (cur.length) chunks.push(cur);
  return chunks;
}

function drawCaptions(ctx: CanvasRenderingContext2D, chunks: Word[][], t: number, style: CaptionStyle, W: number, H: number) {
  if (style === "none") return;
  const s = STYLES[style];
  const idx = chunks.findIndex((c, i) => t >= c[0].start && t < (chunks[i + 1]?.[0].start ?? c[c.length - 1].end + 0.25) && t < c[c.length - 1].end + 0.6);
  if (idx < 0) return;
  const chunk = chunks[idx];
  const fs = Math.round(H * s.size);
  ctx.font = `${style === "minimal" ? 700 : 400} ${fs}px ${FONT_STACK}`;
  ctx.textBaseline = "middle";
  ctx.lineJoin = "round";
  const texts = chunk.map((w) => (s.upper ? w.text.toUpperCase() : w.text));
  const space = fs * 0.28;
  const widths = texts.map((x) => ctx.measureText(x).width);
  const maxW = W * 0.86;
  // wrap into lines that fit
  const lines: number[][] = [[]];
  let lineW = 0;
  texts.forEach((_, i) => {
    const add = widths[i] + (lines[lines.length - 1].length ? space : 0);
    if (lineW + add > maxW && lines[lines.length - 1].length) {
      lines.push([]);
      lineW = 0;
    }
    lines[lines.length - 1].push(i);
    lineW += widths[i] + (lines[lines.length - 1].length > 1 ? space : 0);
  });
  const lineH = fs * 1.18;
  const baseY = H * 0.7 - ((lines.length - 1) * lineH) / 2;
  lines.forEach((line, li) => {
    const total = line.reduce((n, i, k) => n + widths[i] + (k ? space : 0), 0);
    let x = (W - total) / 2;
    const y = baseY + li * lineH;
    for (const i of line) {
      const w = chunk[i];
      const active = style !== "minimal" && t >= w.start && (i + 1 >= chunk.length || t < chunk[i + 1].start);
      const age = t - w.start;
      const scale = active ? 1 + Math.max(0, 0.16 * (1 - age / 0.12)) : 1;
      ctx.save();
      ctx.translate(x + widths[i] / 2, y);
      ctx.scale(scale, scale);
      ctx.lineWidth = fs * s.stroke;
      ctx.strokeStyle = "#000";
      if (s.glow && active) {
        ctx.shadowColor = s.glow;
        ctx.shadowBlur = fs * 0.5;
      }
      ctx.textAlign = "center";
      ctx.strokeText(texts[i], 0, 0);
      ctx.fillStyle = active ? s.active : s.fill;
      ctx.fillText(texts[i], 0, 0);
      ctx.restore();
      x += widths[i] + space;
    }
  });
}

function drawHook(ctx: CanvasRenderingContext2D, hook: string, t: number, W: number, H: number) {
  if (!hook || t > 3.5) return;
  const alpha = Math.min(1, t / 0.15, (3.5 - t) / 0.25);
  const fs = Math.round(H * 0.036);
  ctx.save();
  ctx.globalAlpha = Math.max(0, alpha);
  ctx.font = `700 ${fs}px "Inter", "Arial Black", system-ui, sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  const words = hook.toUpperCase().split(/\s+/);
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    const test = cur ? cur + " " + w : w;
    if (ctx.measureText(test).width > W * 0.76 && cur) {
      lines.push(cur);
      cur = w;
    } else cur = test;
  }
  if (cur) lines.push(cur);
  const lineH = fs * 1.25;
  const padX = fs * 0.6;
  const padY = fs * 0.4;
  const boxW = Math.max(...lines.map((l) => ctx.measureText(l).width)) + padX * 2;
  const boxH = lines.length * lineH + padY * 2;
  const x = (W - boxW) / 2;
  const y = H * 0.12;
  ctx.fillStyle = "#ffffff";
  ctx.beginPath();
  ctx.roundRect(x, y, boxW, boxH, fs * 0.3);
  ctx.fill();
  ctx.fillStyle = "#0b0b0f";
  lines.forEach((l, i) => ctx.fillText(l, W / 2, y + padY + lineH * (i + 0.5)));
  ctx.restore();
}

/* ---------------- recording ---------------- */

export function pickMime(): { mime: string; ext: "mp4" | "webm" } {
  const options: [string, "mp4" | "webm"][] = [
    ["video/mp4;codecs=avc1.42E01F,mp4a.40.2", "mp4"],
    ["video/mp4", "mp4"],
    ["video/webm;codecs=vp9,opus", "webm"],
    ["video/webm;codecs=vp8,opus", "webm"],
    ["video/webm", "webm"],
  ];
  for (const [mime, ext] of options) if (typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(mime)) return { mime, ext };
  throw new Error("This browser can't record video. Use Chrome, Edge or Safari on a computer.");
}

type AudioRoute = { ctx: AudioContext; dest: MediaStreamAudioDestinationNode };
const audioRoutes = new WeakMap<HTMLVideoElement, AudioRoute>();

/** Route the video's sound into the recording only (not the speakers). Each element can be routed once. */
function routeAudio(video: HTMLVideoElement): AudioRoute {
  let route = audioRoutes.get(video);
  if (!route) {
    const ctx = new AudioContext();
    const src = ctx.createMediaElementSource(video);
    const dest = ctx.createMediaStreamDestination();
    src.connect(dest);
    route = { ctx, dest };
    audioRoutes.set(video, route);
  }
  return route;
}

const once = (el: HTMLMediaElement, ev: string) => new Promise<void>((res) => el.addEventListener(ev, () => res(), { once: true }));

export async function renderClip(
  video: HTMLVideoElement,
  job: RenderJob,
  onProgress: (fraction: number) => void,
  signal?: AbortSignal,
): Promise<{ blob: Blob; ext: string; thumbnail: string }> {
  const { mime, ext } = pickMime();
  const W = job.width;
  const H = job.height;
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d")!;
  const srcW = video.videoWidth;
  const srcH = video.videoHeight;
  const portrait = srcW / srcH <= W / H + 0.02;
  const layout: Layout = job.layout === "auto" ? (portrait ? "center" : "track") : job.layout;
  const detector = layout === "track" ? await loadFaceDetector() : null;
  const cropW = Math.min(srcW, (srcH * W) / H);
  const camera = new Camera(srcW, cropW);
  const chunks = chunkWords(job.words.map((w) => ({ ...w, start: w.start - job.start, end: w.end - job.start })));
  if ("fonts" in document) await document.fonts.load(`400 40px Anton`).catch(() => undefined);

  const route = routeAudio(video);
  await route.ctx.resume();
  const stream = canvas.captureStream(30);
  route.dest.stream.getAudioTracks().forEach((t) => stream.addTrack(t));
  const recorder = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: W >= 1080 ? 9_000_000 : 5_000_000 });
  const parts: Blob[] = [];
  recorder.ondataavailable = (e) => e.data.size && parts.push(e.data);
  const stopped = new Promise<void>((res) => (recorder.onstop = () => res()));

  video.pause();
  video.currentTime = job.start;
  await once(video, "seeked");

  let thumbnail = "";
  let lastDetect = -1;
  const duration = job.end - job.start;

  const draw = () => {
    const t = video.currentTime - job.start;
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, W, H);
    if (layout === "fit") {
      const cover = Math.max(W / srcW, H / srcH);
      ctx.filter = "blur(28px) brightness(0.6)";
      ctx.drawImage(video, (W - srcW * cover) / 2, (H - srcH * cover) / 2, srcW * cover, srcH * cover);
      ctx.filter = "none";
      const fit = Math.min(W / srcW, H / srcH);
      ctx.drawImage(video, (W - srcW * fit) / 2, (H - srcH * fit) / 2, srcW * fit, srcH * fit);
    } else {
      if (detector && video.currentTime - lastDetect > 0.15) {
        lastDetect = video.currentTime;
        try {
          const res = detector.detectForVideo(video, performance.now());
          const faces = res.detections.filter((d) => d.boundingBox).map((d) => d.boundingBox!);
          const biggest = faces.sort((a, b) => b.width * b.height - a.width * a.height)[0];
          camera.observe(biggest ? biggest.originX + biggest.width / 2 : null);
        } catch {
          /* a dropped detection just keeps the camera where it is */
        }
      }
      const sx = layout === "track" ? camera.x() : (srcW - cropW) / 2;
      ctx.drawImage(video, sx, 0, cropW, srcH, 0, 0, W, H);
    }
    drawCaptions(ctx, chunks, t, job.captionStyle, W, H);
    if (job.showHook) drawHook(ctx, job.hook, t, W, H);
    if (!thumbnail && t > 0.8) thumbnail = canvas.toDataURL("image/jpeg", 0.75);
    onProgress(Math.min(1, Math.max(0, t / duration)));
  };

  const useRvfc = "requestVideoFrameCallback" in video;
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    video.pause();
    if (recorder.state !== "inactive") recorder.stop();
  };
  const loop = () => {
    if (done) return;
    if (signal?.aborted || video.currentTime >= job.end || video.ended) return finish();
    draw();
    if (useRvfc) video.requestVideoFrameCallback(loop);
    else requestAnimationFrame(loop);
  };
  draw();
  recorder.start(1000);
  video.muted = false;
  video.volume = 1;
  await video.play();
  if (useRvfc) video.requestVideoFrameCallback(loop);
  else requestAnimationFrame(loop);
  // safety net for frames the callback doesn't deliver (e.g. a static picture)
  const timer = window.setInterval(() => {
    if (done) return window.clearInterval(timer);
    if (signal?.aborted || video.currentTime >= job.end || video.ended) finish();
  }, 100);
  await stopped;
  window.clearInterval(timer);
  stream.getVideoTracks().forEach((t) => t.stop());
  if (signal?.aborted) throw new DOMException("Cancelled", "AbortError");
  if (!thumbnail) thumbnail = canvas.toDataURL("image/jpeg", 0.75);
  onProgress(1);
  return { blob: new Blob(parts, { type: mime.split(";")[0] }), ext, thumbnail };
}
