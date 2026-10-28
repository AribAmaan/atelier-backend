import { streamOpenAICompatibleChat, completeOpenAICompatibleChat } from "./openaiCompatible";
import type { GenParams } from "./index";

// Cloudflare Workers AI — TEXT chat, via their OpenAI-compatible endpoint
// (https://api.cloudflare.com/client/v4/accounts/{account_id}/ai/v1). This
// is a separate account/token from the one in cloudflare.ts, which is only
// used for image generation (avatar.ts) — keep them on distinct env vars
// so swapping one doesn't touch the other.
//
// Model defaults to Llama 4 Scout: Cloudflare's own docs point new/migrating
// users at this one (see the 2026-05-08 deprecation notice, which retired a
// pile of older Llama 3.x / Mistral / Gemma models and recommended Llama 4
// or gpt-oss as the replacement). Going with Llama 4 over gpt-oss here on
// purpose — gpt-oss has refusals baked in deep (same reasoning documented
// in providers/index.ts for why Groq's GROQ_MODEL avoids it), while Llama 4
// is the same raw, lightly-tuned Llama family the rest of this fallback
// chain already relies on for explicit-mode permissiveness.
//
// THIS PROVIDER: confirmed working in production and responding to
// explicit-mode content without refusing (tested manually). Cloudflare's
// docs don't document a default-on moderation layer for raw /ai/run or
// /ai/v1 chat calls — that's an opt-in product (Guardrails/Firewall for
// AI) that has to be turned on in the dashboard — which matches what was
// observed.
const DEFAULT_MODEL = "@cf/meta/llama-4-scout-17b-16e-instruct";
const MODEL = process.env.CLOUDFLARE_CHAT_MODEL || DEFAULT_MODEL;

function baseUrl(): string {
  const accountId = process.env.CLOUDFLARE_CHAT_ACCOUNT_ID;
  if (!accountId) throw new Error("CLOUDFLARE_CHAT_ACCOUNT_ID not set");
  return `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/v1`;
}

export function isCloudflareChatConfigured(): boolean {
  return Boolean(process.env.CLOUDFLARE_CHAT_ACCOUNT_ID && process.env.CLOUDFLARE_CHAT_API_TOKEN);
}

function genParamsExtraBody(params?: GenParams): Record<string, unknown> | undefined {
  const body: Record<string, unknown> = {};
  if (params?.temperature !== undefined) body.temperature = params.temperature;
  if (params?.topP !== undefined) body.top_p = params.topP;
  return Object.keys(body).length ? body : undefined;
}

export async function streamCloudflareChat(
  messages: { role: "system" | "user" | "assistant"; content: string }[],
  onToken: (chunk: string) => void,
  apiKey: string,
  timeoutMs: number,
  clientSignal?: AbortSignal,
  params?: GenParams
): Promise<string> {
  return streamOpenAICompatibleChat(baseUrl(), apiKey, MODEL, messages, onToken, timeoutMs, clientSignal, genParamsExtraBody(params), params?.maxTokens ?? 1024, params?.onFinish);
}

export async function completeCloudflareChat(
  messages: { role: "system" | "user" | "assistant"; content: string }[],
  apiKey: string,
  timeoutMs: number,
  params?: GenParams
): Promise<string> {
  return completeOpenAICompatibleChat(baseUrl(), apiKey, MODEL, messages, timeoutMs, genParamsExtraBody(params), params?.maxTokens ?? 1024, params?.requireComplete);
}
