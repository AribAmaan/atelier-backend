import { streamOpenAICompatibleChat, completeOpenAICompatibleChat } from "./openaiCompatible";

const BASE_URL = "https://integrate.api.nvidia.com/v1";
const MODEL = process.env.NVIDIA_MODEL || "meta/llama-3.1-70b-instruct";

export function isNvidiaConfigured() {
  return Boolean(process.env.NVIDIA_API_KEY);
}

/**
 * Same idea as getGroqKeys() — second slot is optional. See groq.ts.
 *
 * Returns each configured key tagged with its original 1-based slot number
 * (1 for NVIDIA_API_KEY, 2 for NVIDIA_API_KEY_2), not its position in this
 * filtered array — otherwise, if only NVIDIA_API_KEY_2 is set, that key
 * would end up at array index 0 and get labeled "NVIDIA #1" even though
 * it's really the second key.
 */
export function getNvidiaKeys(): { key: string; slot: number }[] {
  return [process.env.NVIDIA_API_KEY, process.env.NVIDIA_API_KEY_2]
    .map((key, i) => ({ key, slot: i + 1 }))
    .filter((entry): entry is { key: string; slot: number } => Boolean(entry.key));
}

export async function streamNvidiaChat(
  messages: { role: "system" | "user" | "assistant"; content: string }[],
  onToken: (chunk: string) => void,
  apiKey: string,
  timeoutMs: number,
  clientSignal?: AbortSignal
): Promise<string> {
  return streamOpenAICompatibleChat(BASE_URL, apiKey, MODEL, messages, onToken, timeoutMs, clientSignal);
}

export async function completeNvidiaChat(
  messages: { role: "system" | "user" | "assistant"; content: string }[],
  apiKey: string,
  timeoutMs: number
): Promise<string> {
  return completeOpenAICompatibleChat(BASE_URL, apiKey, MODEL, messages, timeoutMs);
}
