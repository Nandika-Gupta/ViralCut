import { MODEL } from "@/lib/planner";

export const dynamic = "force-dynamic";

export function GET() {
  return Response.json({
    ai: Boolean(process.env.ANTHROPIC_API_KEY),
    model: MODEL,
    accessCode: Boolean(process.env.VIRALCUT_ACCESS_CODE),
  });
}
