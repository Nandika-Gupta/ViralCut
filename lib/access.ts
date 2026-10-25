/** Optional access code so a public deployment can't be used by strangers to spend your Claude credits. */
export function accessDenied(req: Request): Response | null {
  const code = process.env.VIRALCUT_ACCESS_CODE;
  if (!code) return null;
  if (req.headers.get("x-access-code") === code) return null;
  return Response.json({ error: "Enter your access code to use ViralCut.", code: "access_code" }, { status: 401 });
}
