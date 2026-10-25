# ⚡ ViralCut

**Turn one long video into viral shorts automatically.** Paste a YouTube link or upload a video. ViralCut finds the best
moments, adds captions, reframes them to 9:16 around the speaker's face, and writes ready-to-post captions and hashtags
for TikTok, Reels, Shorts, X, LinkedIn and Facebook. You can also plan when each one goes out.

## Features

| | |
|---|---|
| **Paste a link** | YouTube links are read from their captions on the server. Dropbox and direct `.mp4` links are downloaded in the browser. |
| **Upload a video** | Whisper transcribes it right in your browser (WebGPU when available). The video never leaves your computer. |
| **AI clip detection** | Gemini, Groq or Claude reads the transcript and picks the moments most likely to go viral, each with a virality score, hook, title and the reason it works. Without an API key, built-in scoring runs instead. |
| **Face-tracking reframe** | MediaPipe face detection keeps the speaker centred in a 9:16 frame. Blurred-background and center-crop modes are also available. |
| **Animated captions** | Word-by-word captions (bold pop, karaoke, neon, minimal) plus a hook title for the first 3 seconds, rendered to MP4/WebM in the browser. |
| **Posts & hashtags** | Platform-native posts and hashtags for every clip, an X thread, LinkedIn and Instagram posts for the full video, and a hashtag bank. |
| **Scheduling** | Plan each short at the platform's peak time and export the schedule to your calendar (`.ics`). |

## Deploy on Vercel

1. Import this repository at [vercel.com/new](https://vercel.com/new). The framework is detected as **Next.js**, so no settings are needed.
2. Under **Environment Variables**, add **one** AI key:
   - `GEMINI_API_KEY`: **free** from [aistudio.google.com/apikey](https://aistudio.google.com/apikey). Recommended, because it handles long videos.
   - or `GROQ_API_KEY`: **free** from [console.groq.com/keys](https://console.groq.com/keys). Very fast, but its free tier only fits transcripts of about 30 minutes.
   - or `ANTHROPIC_API_KEY`: paid, from [console.anthropic.com](https://console.anthropic.com).

   Also add `VIRALCUT_ACCESS_CODE` *(recommended)*: a code visitors must enter, so strangers can't use up your API quota.
3. Click **Deploy**.

`/api/clips` streams the AI's answer and may run for up to 300 seconds (`maxDuration`). That's within Vercel's limits with Fluid compute, which is on by default.

## Run locally

```bash
npm install
cp .env.example .env.local   # add your GEMINI_API_KEY (free)
npm run dev                  # http://localhost:3000
npm test                     # unit tests
```

## How it works

```
YouTube link ──► /api/transcript (captions) ─┐
                                              ├─► /api/clips (Gemini/Groq/Claude: clips, posts, hashtags) ─► results
Upload / .mp4 ─► Whisper in browser ─────────┘                                                 │
                                                                     canvas + MediaRecorder ◄──┘
                                                       (face tracking, captions, hook) ─► 9:16 MP4
```

- `app/api/transcript`: reads YouTube captions without an API key. YouTube sometimes refuses requests from cloud servers. When that happens, the site asks for the transcript (YouTube: **…more → Show transcript**) or the video file.
- `app/api/clips` + `lib/llm.ts`: asks the AI service you configured for a JSON plan and streams it to the browser. The service is picked from whichever key is set (Gemini, then Groq, then Anthropic), or with `VIRALCUT_PROVIDER`. Default models: `gemini-flash-latest`, `llama-3.3-70b-versatile`, `claude-opus-5-5` (override with `VIRALCUT_MODEL`).
- `lib/render.ts`: the in-browser renderer. Clips render in real time, so keep the tab open. Chrome/Edge/Safari export MP4; Firefox exports WebM.
- `public/workers/whisper.js`: speech recognition (transformers.js + `Xenova/whisper-base`, downloaded once by the browser, about 150 MB).

## Limits

- Websites can't download YouTube, Twitch, Kick, Google Drive or Loom videos. For YouTube links you get the clips as timestamped previews plus all the posts. Add the video file to export MP4s.
- Long uploads are transcribed in the browser. A 1-hour video can take 10–30 minutes, depending on the computer.

## Windows desktop app

`desktop/` contains the full Python version (FFmpeg + Whisper + OpenCV) packaged as a Windows installer.
GitHub Actions builds and self-tests it on every change to `desktop/` and publishes `ViralCut-Setup-x.y.z.exe` under **Releases**.
See [`desktop/viralcut/README.md`](desktop/viralcut/README.md).

---

Only clip videos you own or have permission to repurpose.
