import { streamOpenAICompatibleChat, completeOpenAICompatibleChat } from "./openaiCompatible";

/**
 * Cerebras (https://cloud.cerebras.ai) — free tier, no credit card, 1M
 * tokens/day, generous rate limit. Added as a hosted slot between NVIDIA
 * and Ollama: another shot at a fast hosted reply before dropping down to
 * the local-only fallback. Their free model catalog changes more often
 * than Groq's or NVIDIA's — if CEREBRAS_MODEL 404s, check
 * https://inference-docs.cerebras.ai for the current free list.
 */
const BASE_URL = "https://api.cerebras.ai/v1";
const MODEL = process.env.CEREBRAS_MODEL || "llama-3.3-70b";

export function isCerebrasConfigured() {
  return Boolean(process.env.CEREBRAS_API_KEY);
}

export async function streamCerebrasChat(
  messages: { role: "system" | "user" | "assistant"; content: string }[],
  onToken: (chunk: string) => void,
  apiKey: string,
  timeoutMs: number
): Promise<string> {
  return streamOpenAICompatibleChat(BASE_URL, apiKey, MODEL, messages, onToken, timeoutMs);
}

export async function completeCerebrasChat(
  messages: { role: "system" | "user" | "assistant"; content: string }[],
  apiKey: string,
  timeoutMs: number
): Promise<string> {
  return completeOpenAICompatibleChat(BASE_URL, apiKey, MODEL, messages, timeoutMs);
}
