import { streamOpenAICompatibleChat, completeOpenAICompatibleChat } from "./openaiCompatible";
import type { GenParams } from "./index";

/**
 * SambaNova Cloud (https://cloud.sambanova.ai) — free tier, no credit card,
 * persists indefinitely (not just a trial). Hosts Meta-Llama-3.3-70B-Instruct
 * (their most battle-tested model) on their own RDU hardware, OpenAI-
 * compatible endpoint. This is a raw Llama model with no extra safety
 * layer applied server-side, so it goes along with explicit-mode roleplay
 * much more readily than Groq's gpt-oss.
 */
const BASE_URL = "https://api.sambanova.ai/v1";
const MODEL = process.env.SAMBANOVA_MODEL || "Meta-Llama-3.3-70B-Instruct";

export function isSambanovaConfigured() {
  return Boolean(process.env.SAMBANOVA_API_KEY);
}

/**
 * Same idea as getNvidiaKeys()/getGroqKeys() — a second
 * key (SAMBANOVA_API_KEY_2) is optional, ideally from a separate
 * account/signup since free-tier limits are enforced per account, not per
 * key. Leave it unset to just use one key; that slot is then simply left
 * out of the chain.
 *
 * Returns each configured key tagged with its original 1-based slot number,
 * not its position in this filtered array — otherwise, if only
 * SAMBANOVA_API_KEY_2 is set, that key would end up at array index 0 and
 * get labeled "SambaNova #1" even though it's really the second key.
 */
export function getSambanovaKeys(): { key: string; slot: number }[] {
  return [process.env.SAMBANOVA_API_KEY, process.env.SAMBANOVA_API_KEY_2]
    .map((key, i) => ({ key, slot: i + 1 }))
    .filter((entry): entry is { key: string; slot: number } => Boolean(entry.key));
}

function genParamsExtraBody(params?: GenParams): Record<string, unknown> | undefined {
  const body: Record<string, unknown> = {};
  if (params?.temperature !== undefined) body.temperature = params.temperature;
  if (params?.topP !== undefined) body.top_p = params.topP;
  return Object.keys(body).length ? body : undefined;
}

export async function streamSambanovaChat(
  messages: { role: "system" | "user" | "assistant"; content: string }[],
  onToken: (chunk: string) => void,
  apiKey: string,
  timeoutMs: number,
  clientSignal?: AbortSignal,
  params?: GenParams
): Promise<string> {
  return streamOpenAICompatibleChat(BASE_URL, apiKey, MODEL, messages, onToken, timeoutMs, clientSignal, genParamsExtraBody(params), params?.maxTokens ?? 1024, params?.onFinish);
}

export async function completeSambanovaChat(
  messages: { role: "system" | "user" | "assistant"; content: string }[],
  apiKey: string,
  timeoutMs: number,
  params?: GenParams
): Promise<string> {
  return completeOpenAICompatibleChat(BASE_URL, apiKey, MODEL, messages, timeoutMs, genParamsExtraBody(params), params?.maxTokens ?? 1024, params?.requireComplete);
}
