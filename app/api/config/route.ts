import { availableProviders } from "@/lib/providers";

export const dynamic = "force-dynamic";

export function GET() {
  const all = availableProviders();
  const p = all[0];
  return Response.json({
    ai: Boolean(p),
    model: p ? `${all.map((x) => x.label).join(" + ")} · ${p.model}` : "",
    accessCode: Boolean(process.env.VIRALCUT_ACCESS_CODE),
    // OAuth client IDs are public by design (they identify the site to Google); no secret is exposed.
    googleClientId: process.env.GOOGLE_CLIENT_ID || "",
  });
}
