// Speech recognition in the browser with Whisper (transformers.js). Runs in a module Web Worker.
import { pipeline, env } from "https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.0/dist/transformers.web.min.js";

env.allowLocalModels = false;
const WINDOW = 30; // seconds of audio per pass
const RATE = 16000;
let asr = null;
let device = "wasm";

async function load(model) {
  if (asr) return asr;
  try {
    if (navigator.gpu && (await navigator.gpu.requestAdapter())) device = "webgpu";
  } catch {
    device = "wasm";
  }
  const files = new Map();
  asr = await pipeline("automatic-speech-recognition", model, {
    device,
    dtype: device === "webgpu" ? { encoder_model: "fp32", decoder_model_merged: "q4" } : "q8",
    progress_callback: (p) => {
      if (p.status === "progress" && p.total) {
        files.set(p.file, [p.loaded, p.total]);
        let loaded = 0, total = 0;
        for (const [l, t] of files.values()) { loaded += l; total += t; }
        postMessage({ type: "download", loaded, total });
      }
    },
  });
  return asr;
}

self.onmessage = async (e) => {
  const { audio, model, language } = e.data;
  try {
    const transcriber = await load(model || "Xenova/whisper-base");
    postMessage({ type: "ready", device });
    const total = Math.ceil(audio.length / (RATE * WINDOW));
    const segments = [];
    for (let i = 0; i < total; i++) {
      const offset = i * WINDOW;
      const slice = audio.subarray(offset * RATE, Math.min(audio.length, (offset + WINDOW) * RATE));
      const out = await transcriber(slice, {
        return_timestamps: true,
        task: "transcribe",
        ...(language ? { language } : {}),
      });
      for (const c of out.chunks || []) {
        const text = (c.text || "").trim();
        if (!text) continue;
        const [s, en] = c.timestamp || [0, null];
        segments.push({ text, start: offset + (s ?? 0), end: offset + (en ?? Math.min(WINDOW, slice.length / RATE)) });
      }
      postMessage({ type: "progress", done: i + 1, total, segments });
    }
    postMessage({ type: "done", segments });
  } catch (err) {
    postMessage({ type: "error", error: String((err && err.message) || err) });
  }
};
