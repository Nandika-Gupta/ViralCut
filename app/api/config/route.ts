import { activeProvider } from "@/lib/providers";

export const dynamic = "force-dynamic";

export function GET() {
  const p = activeProvider();
  return Response.json({
    ai: Boolean(p),
    model: p ? `${p.label} · ${p.model}` : "",
    accessCode: Boolean(process.env.VIRALCUT_ACCESS_CODE),
  });
}
