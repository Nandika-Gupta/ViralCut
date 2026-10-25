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

/**
 * Every service with a key, in the order they're tried: VIRALCUT_PROVIDER first if set, then Gemini, Groq, Anthropic.
 * If one is busy or over its free limit, the next one takes over.
 */
export function availableProviders(): Provider[] {
  const forced = process.env.VIRALCUT_PROVIDER?.toLowerCase() as ProviderName | undefined;
  const base: ProviderName[] = ["gemini", "groq", "anthropic"];
  const order = forced && forced in KEYS ? [forced, ...base.filter((n) => n !== forced)] : base;
  const out: Provider[] = [];
  for (const name of order) {
    const key = process.env[KEYS[name]] || (name === "gemini" ? process.env.GOOGLE_API_KEY : undefined);
    // VIRALCUT_MODEL applies to the first (preferred) service only; backups use their defaults.
    if (key) out.push({ name, label: LABELS[name], model: (!out.length && process.env.VIRALCUT_MODEL) || DEFAULT_MODELS[name], key });
  }
  return out;
}

export function activeProvider(): Provider | null {
  return availableProviders()[0] ?? null;
}
