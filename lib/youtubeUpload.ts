/**
 * Browser-only: sign in with Google (Google Identity Services) and upload a rendered short to the viewer's
 * YouTube channel with the YouTube Data API's resumable upload. Needs GOOGLE_CLIENT_ID on the server.
 */

type TokenResponse = { access_token?: string; expires_in?: number; error?: string; error_description?: string };
type TokenClient = { requestAccessToken: (opts?: { prompt?: string }) => void; callback: (r: TokenResponse) => void };
declare global {
  interface Window {
    google?: { accounts: { oauth2: { initTokenClient: (cfg: { client_id: string; scope: string; callback: (r: TokenResponse) => void; error_callback?: (e: { type: string; message?: string }) => void }) => TokenClient } } };
  }
}

const SCOPE = "https://www.googleapis.com/auth/youtube.upload";
let gisLoaded: Promise<void> | null = null;
let token: { value: string; expires: number } | null = null;

function loadGis(): Promise<void> {
  gisLoaded ??= new Promise((resolve, reject) => {
    if (window.google?.accounts?.oauth2) return resolve();
    const s = document.createElement("script");
    s.src = "https://accounts.google.com/gsi/client";
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => {
      gisLoaded = null;
      reject(new Error("Couldn't load Google sign-in. Check your connection or ad blocker."));
    };
    document.head.appendChild(s);
  });
  return gisLoaded;
}

/** Opens Google's sign-in popup the first time; reuses the token for about an hour. Call from a click. */
export async function getYouTubeToken(clientId: string): Promise<string> {
  if (token && token.expires > Date.now() + 60_000) return token.value;
  await loadGis();
  return new Promise((resolve, reject) => {
    const client = window.google!.accounts.oauth2.initTokenClient({
      client_id: clientId,
      scope: SCOPE,
      callback: (r) => {
        if (r.error || !r.access_token) return reject(new Error(r.error_description || r.error || "Google sign-in failed."));
        token = { value: r.access_token, expires: Date.now() + (r.expires_in ?? 3600) * 1000 };
        resolve(r.access_token);
      },
      error_callback: (e) => reject(new Error(e.type === "popup_closed" ? "Sign-in window was closed." : e.message || "Google sign-in failed.")),
    });
    client.requestAccessToken();
  });
}

export type YouTubeMeta = {
  title: string;
  description: string;
  tags: string[];
  privacy: "public" | "unlisted" | "private";
  publishAt?: string; // ISO time; YouTube requires privacy "private" until then
};

export function shortsTitle(title: string): string {
  const clean = title.replace(/[<>]/g, "").replace(/\s+/g, " ").trim();
  const withTag = /#shorts/i.test(clean) ? clean : `${clean} #Shorts`;
  return withTag.length <= 100 ? withTag : clean.slice(0, 100);
}

function apiError(status: number, body: string): Error {
  let reason = "";
  let message = body.slice(0, 200);
  try {
    const e = JSON.parse(body).error;
    reason = e?.errors?.[0]?.reason ?? "";
    message = e?.message ?? message;
  } catch {
    /* not JSON */
  }
  if (status === 401) {
    token = null;
    return new Error("Google sign-in expired. Click Post to YouTube again.");
  }
  if (reason === "youtubeSignupRequired") return new Error("This Google account has no YouTube channel yet. Create one at youtube.com, then try again.");
  if (reason === "quotaExceeded" || reason === "uploadLimitExceeded") return new Error("YouTube's daily upload limit for this app was reached. Try again tomorrow.");
  if (status === 403) return new Error(`YouTube refused the upload: ${message}`);
  return new Error(`YouTube upload failed (${status}): ${message}`);
}

/** Resumable upload with progress. Resolves with the new video's id. */
export async function uploadToYouTube(
  accessToken: string, video: Blob, meta: YouTubeMeta, onProgress: (fraction: number) => void,
): Promise<string> {
  const status: Record<string, unknown> = { privacyStatus: meta.publishAt ? "private" : meta.privacy, selfDeclaredMadeForKids: false };
  if (meta.publishAt) status.publishAt = meta.publishAt;
  const init = await fetch("https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json; charset=UTF-8",
      "X-Upload-Content-Type": video.type || "video/mp4",
      "X-Upload-Content-Length": String(video.size),
    },
    body: JSON.stringify({
      snippet: {
        title: shortsTitle(meta.title),
        description: meta.description.slice(0, 4900),
        tags: meta.tags.map((t) => t.replace(/^#/, "")).filter(Boolean).slice(0, 30),
        categoryId: "22",
      },
      status,
    }),
  });
  if (!init.ok) throw apiError(init.status, await init.text());
  const uploadUrl = init.headers.get("Location");
  if (!uploadUrl) throw new Error("YouTube didn't return an upload address. Try again.");

  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", uploadUrl);
    xhr.setRequestHeader("Authorization", `Bearer ${accessToken}`);
    xhr.setRequestHeader("Content-Type", video.type || "video/mp4");
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          resolve(JSON.parse(xhr.responseText).id);
        } catch {
          reject(new Error("Uploaded, but YouTube's reply was unreadable. Check YouTube Studio."));
        }
      } else reject(apiError(xhr.status, xhr.responseText));
    };
    xhr.onerror = () => reject(new Error("The upload was interrupted. Check your connection and try again."));
    xhr.send(video);
  });
}
