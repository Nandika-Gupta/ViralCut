/** Server-only: which AI service writes the clips and posts, based on the API keys you set. */
export type ProviderName = "gemini" | "groq" | "anthropic";

export type Provider = { name: ProviderName; label: string; model: string; key: string };

const DEFAULT_MODELS: Record<ProviderName, string> = {
  gemini: "gemini-flash-latest",
  groq: "llama-3.3-70b-versatile",
  anthropic: "claude-opus-5-5",
};
const LABELS: Record<ProviderName, string> = { gemini: "Gemini", groq: "Groq", anthropic: "Claude" };
const KEYS: Record<ProviderName, string> = { gemini: "GEMINI_API_KEY", groq: "GROQ_API_KEY", anthropic: "ANTHROPIC_API_KEY" };

/** VIRALCUT_PROVIDER picks one explicitly; otherwise the first key found (Gemini, then Groq, then Anthropic). */
export function activeProvider(): Provider | null {
  const forced = process.env.VIRALCUT_PROVIDER?.toLowerCase() as ProviderName | undefined;
  const order: ProviderName[] = forced && forced in KEYS ? [forced] : ["gemini", "groq", "anthropic"];
  for (const name of order) {
    const key = process.env[KEYS[name]] || (name === "gemini" ? process.env.GOOGLE_API_KEY : undefined);
    if (key) return { name, label: LABELS[name], model: process.env.VIRALCUT_MODEL || DEFAULT_MODELS[name], key };
  }
  return null;
}
