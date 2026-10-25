import { accessDenied } from "@/lib/access";
import { geminiKey, transcribeYouTubeWithGemini } from "@/lib/geminiVideo";
import { fetchYouTubeTranscript, TranscriptError, youtubeId } from "@/lib/youtube";

// Gemini watching a long video can take a few minutes.
export const maxDuration = 300;

export async function POST(req: Request) {
  const denied = accessDenied(req);
  if (denied) return denied;
  let body: { url?: string; lang?: string };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Send JSON with a url." }, { status: 400 });
  }
  if (!body.url || body.url.length > 500) return Response.json({ error: "Paste a YouTube link." }, { status: 400 });
  const videoId = youtubeId(body.url);
  if (!videoId) return Response.json({ error: "That isn't a YouTube video link.", code: "bad_link" }, { status: 400 });

  let captionError: unknown;
  try {
    return Response.json(await fetchYouTubeTranscript(body.url, body.lang));
  } catch (err) {
    captionError = err;
  }

  // YouTube often refuses cloud servers. Gemini can read the public video directly instead.
  if (geminiKey()) {
    try {
      const t = await transcribeYouTubeWithGemini(videoId, req.signal);
      const last = t.sentences[t.sentences.length - 1];
      return Response.json({
        videoId, title: t.title, author: "", duration: last.end, language: "auto", sentences: t.sentences, source: "gemini",
      });
    } catch (err) {
      console.error("gemini transcript failed", err);
      return Response.json({ error: (err as Error).message, code: "gemini_failed" }, { status: 422 });
    }
  }

  if (captionError instanceof TranscriptError) {
    const hint = captionError.code === "blocked" ? " Add a GEMINI_API_KEY on the server to read YouTube links anyway." : "";
    return Response.json({ error: captionError.message + hint, code: captionError.code }, { status: 422 });
  }
  console.error("transcript failed", captionError);
  return Response.json({ error: "Couldn't reach YouTube. Try again in a minute.", code: "unavailable" }, { status: 502 });
}
