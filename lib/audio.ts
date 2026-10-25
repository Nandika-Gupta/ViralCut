/** Browser-only: decode a video's audio to 16 kHz mono and measure loudness. */
export const LOUDNESS_HOP = 0.25; // seconds per loudness sample

export async function decodeAudio(file: Blob, onProgress?: (msg: string) => void): Promise<Float32Array> {
  onProgress?.("Reading the video's audio…");
  const buf = await file.arrayBuffer();
  const ctx = new AudioContext();
  let decoded: AudioBuffer;
  try {
    decoded = await ctx.decodeAudioData(buf);
  } catch {
    throw new Error("This browser can't read the audio in this file. Try an MP4 (H.264/AAC) export, or use Chrome.");
  } finally {
    void ctx.close();
  }
  const length = Math.ceil(decoded.duration * 16000);
  const offline = new OfflineAudioContext(1, length, 16000);
  const src = offline.createBufferSource();
  src.buffer = decoded;
  src.connect(offline.destination);
  src.start();
  onProgress?.("Preparing audio for speech recognition…");
  const rendered = await offline.startRendering();
  return rendered.getChannelData(0);
}

export function loudnessCurve(samples: Float32Array, rate = 16000): number[] {
  const hop = Math.floor(rate * LOUDNESS_HOP);
  const out: number[] = [];
  for (let i = 0; i + hop <= samples.length; i += hop) {
    let sum = 0;
    for (let j = i; j < i + hop; j++) sum += samples[j] * samples[j];
    out.push(20 * Math.log10(Math.sqrt(sum / hop) + 1e-5));
  }
  return out;
}
