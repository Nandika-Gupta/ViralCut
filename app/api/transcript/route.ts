import { accessDenied } from "@/lib/access";
import { fetchYouTubeTranscript, TranscriptError } from "@/lib/youtube";

export const maxDuration = 60;

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
  try {
    const t = await fetchYouTubeTranscript(body.url, body.lang);
    return Response.json(t);
  } catch (err) {
    if (err instanceof TranscriptError) {
      return Response.json({ error: err.message, code: err.code }, { status: err.code === "bad_link" ? 400 : 422 });
    }
    console.error("transcript failed", err);
    return Response.json({ error: "Couldn't reach YouTube. Try again in a minute.", code: "unavailable" }, { status: 502 });
  }
}
