import { streamOpenAICompatibleChat, completeOpenAICompatibleChat } from "./openaiCompatible";
import type { GenParams } from "./index";

const BASE_URL = "https://integrate.api.nvidia.com/v1";
// Current default: minimaxai/minimax-m3 — confirmed working on NVIDIA's
// Free Endpoint for this account. This is now the model that answers
// first for every chat request (SFW and NSFW alike), since the chain no
// longer reorders away from NVIDIA-first for premium or explicit chats — see buildChain in
// providers/index.ts.
//
// Everything tried and failed before landing here, so don't re-attempt
// any of these blind:
//   - meta/llama-4-scout-17b-16e-instruct: 404 "Not Found for account" —
//     NVIDIA's own forums confirm this is a known issue, other users hit
//     the identical error with the identical (correct) model string. This
//     is NVIDIA gating the model at the account level, not a naming bug —
//     nothing to fix on our side.
//   - meta/llama-4-maverick-17b-128e-instruct: 410 Gone — NVIDIA EOL'd it
//     2026-07-27. Both Llama 4 MoE options (Scout and Maverick) are dead
//     now: one gated, one retired.
//   - meta/llama-3.3-70b-instruct: technically works, but consistently
//     missed the 6s NVIDIA_TIMEOUT_MS window under free-tier load (18-45s
//     per-message delays, every request paying 1-3 full timeouts before
//     falling over to Groq). Also NVIDIA-scheduled for deprecation
//     2026-08-25 regardless.
//   - deepseek-ai/deepseek-v4-flash: worked briefly, then NVIDIA EOL'd it
//     2026-08-07 (410 Gone) — ~3.5 months after release.
//   - deepseek-ai/deepseek-v3_2: failed in production for this
//     account/region despite being NVIDIA's then-current listed flagship
//     on the Free Endpoint — root cause not fully isolated.
//   - deepseek-ai/deepseek-v3_1 / deepseek-v3.1-terminus: same story.
//   - meta/llama-3.1-8b-instruct: the one model that's actually held up —
//     kept as the documented fallback, not because it's the best, but
//     because it's the most verified.
//   - nvidia/llama-3.1-nemotron-nano-8b-v1: NVIDIA's RLHF alignment pass
//     reintroduces refusal behavior (a published "abliterated" fork of it
//     exists specifically to strip that back out) — only ruled out for
//     uncensored use cases, not for general capability.
//   - Net effect: this free tier's catalog listings don't reliably
//     reflect what's actually callable for a given account. Prefer
//     verified-working models over "current flagship" ones going
//     forward, and expect to re-verify after any swap.
//
// MODEL swaps happen via Render's env vars, not by re-deploying this
// file: set NVIDIA_MODEL in the Render dashboard (Environment tab) and
// redeploy — no zip re-upload needed. The string below is only the
// fallback used when NVIDIA_MODEL isn't set at all.
const MODEL = process.env.NVIDIA_MODEL || "minimaxai/minimax-m3";

// See MODEL comment above — Nemotron Nano's reasoning toggle is a literal
// token inside a system message, not a request-body field, and only
// applies to that model family. Gated on the MODEL string so switching
// NVIDIA_MODEL to something else (DeepSeek, Llama, ...) via Render env
// doesn't inject a meaningless "/no_think" into an unrelated model's
// system prompt.
function withReasoningToggle(
  messages: { role: "system" | "user" | "assistant"; content: string }[]
): { role: "system" | "user" | "assistant"; content: string }[] {
  if (!MODEL.startsWith("nvidia/nemotron-nano")) return messages;
  const marker = "/no_think";
  const [first, ...rest] = messages;
  if (first?.role === "system") {
    return [{ ...first, content: `${marker}\n${first.content}` }, ...rest];
  }
  return [{ role: "system", content: marker }, ...messages];
}

export function isNvidiaConfigured() {
  return Boolean(process.env.NVIDIA_API_KEY);
}

/**
 * Same idea as getSambanovaKeys()/getGroqKeys() — additional keys
 * (NVIDIA_API_KEY_2, NVIDIA_API_KEY_3) are optional, ideally from
 * separate accounts/signups since free-tier limits are enforced per
 * account, not per key. Leave any unset to just use the keys you have;
 * unused slots are then simply left out of the chain.
 *
 * Returns each configured key tagged with its original 1-based slot number
 * (1 for NVIDIA_API_KEY, 2 for NVIDIA_API_KEY_2, 3 for NVIDIA_API_KEY_3),
 * not its position in this filtered array — otherwise, if only
 * NVIDIA_API_KEY_3 is set, that key would end up at array index 0 and get
 * labeled "NVIDIA #1" even though it's really the third key.
 */
export function getNvidiaKeys(): { key: string; slot: number }[] {
  return [process.env.NVIDIA_API_KEY, process.env.NVIDIA_API_KEY_2, process.env.NVIDIA_API_KEY_3]
    .map((key, i) => ({ key, slot: i + 1 }))
    .filter((entry): entry is { key: string; slot: number } => Boolean(entry.key));
}

// The old nemotron-nano-12b-v2-vl used a literal "/no_think" system-message
// token (see withReasoningToggle above). The current Nemotron 3 generation
// (nano-30b-a3b, super-120b-a12b, ultra-550b-a55b, nemotron-3.5-lightning,
// nemotron-3-nano-omni, etc.) uses a different, request-body-level switch
// instead: chat_template_kwargs.enable_thinking. Without this explicitly
// set to false, these models run full hidden chain-of-thought on every
// request — normally invisible (stripped by the <think> filter in
// openaiCompatible.ts), but NOT free: on borderline/ambiguous input the
// model can spend several extra seconds deliberating before the visible
// reply even starts, which is enough to blow through NVIDIA_TIMEOUT_MS and
// look like a random/content-dependent failure even though the model
// would have answered fine given more time.
//
// Matches any nvidia/nemotron-3* or nvidia/nemotron-nano-3* model string,
// which covers every current Nemotron 3-generation chat model without
// having to hardcode each one by name as NVIDIA adds/retires them.
const IS_NEMOTRON_3_FAMILY = /^nvidia\/nemotron-(3|nano-3|3\.5)/.test(MODEL);
const IS_NEMOTRON_3_SUPER = /^nvidia\/nemotron-3-super(?:-|$)/.test(MODEL);

function genParamsExtraBody(params?: GenParams): Record<string, unknown> | undefined {
  const body: Record<string, unknown> = {};

  // Nemotron 3 Super is tuned around temperature=1.0 / top_p=0.95. Keep the
  // per-engine values for every other provider/model, but do not feed this
  // model off-spec sampling values merely because Vanilla/Strawberry use
  // lower temperatures elsewhere in the fallback chain.
  if (IS_NEMOTRON_3_SUPER) {
    body.temperature = 1.0;
    body.top_p = 0.95;
  } else {
    if (params?.temperature !== undefined) body.temperature = params.temperature;
    if (params?.topP !== undefined) body.top_p = params.topP;
  }

  // Roleplay replies do not benefit from hidden deliberation, and hidden
  // reasoning makes latency/token usage less predictable. NVIDIA documents
  // this switch for current Nemotron 3 chat models. Keep the payload minimal:
  // unsupported chat-template kwargs can themselves cause endpoint errors.
  if (IS_NEMOTRON_3_FAMILY) {
    body.chat_template_kwargs = { enable_thinking: false };
  }
  return Object.keys(body).length ? body : undefined;
}

function effectiveMaxTokens(params?: GenParams): number {
  // Reasoning is explicitly disabled above, so adding a blanket +512 token
  // "reasoning buffer" is counterproductive: it lets short tiers generate
  // far past their word envelope and forces the server to cut the visible
  // reply afterward. Use the tier's real generation budget and let the
  // bounded same-provider continuation recover an actual length finish.
  return params?.maxTokens ?? 1024;
}

export async function streamNvidiaChat(
  messages: { role: "system" | "user" | "assistant"; content: string }[],
  onToken: (chunk: string) => void,
  apiKey: string,
  timeoutMs: number,
  clientSignal?: AbortSignal,
  params?: GenParams
): Promise<string> {
  return streamOpenAICompatibleChat(BASE_URL, apiKey, MODEL, withReasoningToggle(messages), onToken, timeoutMs, clientSignal, genParamsExtraBody(params), effectiveMaxTokens(params), params?.onFinish);
}

export async function completeNvidiaChat(
  messages: { role: "system" | "user" | "assistant"; content: string }[],
  apiKey: string,
  timeoutMs: number,
  params?: GenParams
): Promise<string> {
  return completeOpenAICompatibleChat(BASE_URL, apiKey, MODEL, withReasoningToggle(messages), timeoutMs, genParamsExtraBody(params), effectiveMaxTokens(params), params?.requireComplete);
}
