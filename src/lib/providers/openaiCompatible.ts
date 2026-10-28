import { recordTokenUsage, recordProviderAttempt } from "./tokenStats";

/**
 * Groq and NVIDIA NIM both expose an OpenAI-compatible
 * /chat/completions endpoint, so they share this streaming parser and
 * non-streaming helper.
 *
 * Both functions take a `timeoutMs` and enforce it with an AbortController
 * — this is what makes the circuit breaker actually useful. Without a hard
 * timeout, a hanging provider (not erroring, just never responding) would
 * never trip the breaker and would block every request behind it forever.
 *
 * For streaming, the timeout only covers "time to first token" — once
 * tokens start arriving we know the provider is alive, so a long legitimate
 * reply isn't punished. For the non-streaming `complete` path (used for
 * memory summarization, not user-facing chat), the timeout covers the
 * whole request.
 */

type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

// ---------------------------------------------------------------------------
// Reasoning-model "thinking" tag stripping
// ---------------------------------------------------------------------------
// Reasoning-capable models (Qwen 3.x, DeepSeek-R1-style, etc.) can emit their
// internal chain-of-thought inline in the content stream, wrapped in
// <think>...</think>. The primary defense is asking the provider not to send
// it at all (Groq's reasoning_format: "hidden" — see groq.ts), but that's a
// provider-specific opt-in and has been reported to occasionally leak
// anyway, so this is a second, generic layer: it strips any <think>...
// </think> span out of the text before it ever reaches onToken() or gets
// saved to the DB, regardless of which provider or model produced it.
//
// Tags can arrive split across multiple stream chunks (e.g. one chunk ends
// with "<th" and the next starts with "ink>"), so this can't just be a
// per-chunk regex — it's a small state machine that holds back only the
// minimum ambiguous suffix between chunks.
function longestTagPrefixSuffix(text: string, tag: string): number {
  const max = Math.min(text.length, tag.length - 1);
  for (let len = max; len > 0; len--) {
    if (text.endsWith(tag.slice(0, len))) return len;
  }
  return 0;
}

const THINK_OPEN = "<think>";
const THINK_CLOSE = "</think>";

function createThinkTagFilter() {
  let pending = "";
  let inThink = false;

  function feed(chunk: string): string {
    pending += chunk;
    let out = "";
    // eslint-disable-next-line no-constant-condition
    while (true) {
      if (!inThink) {
        const idx = pending.indexOf(THINK_OPEN);
        if (idx === -1) {
          const holdBack = longestTagPrefixSuffix(pending, THINK_OPEN);
          out += pending.slice(0, pending.length - holdBack);
          pending = pending.slice(pending.length - holdBack);
          break;
        }
        out += pending.slice(0, idx);
        pending = pending.slice(idx + THINK_OPEN.length);
        inThink = true;
      } else {
        const idx = pending.indexOf(THINK_CLOSE);
        if (idx === -1) {
          const holdBack = longestTagPrefixSuffix(pending, THINK_CLOSE);
          // Everything except a possible partial closing tag is discarded —
          // it's inside the thinking block.
          pending = pending.slice(pending.length - holdBack);
          break;
        }
        pending = pending.slice(idx + THINK_CLOSE.length);
        inThink = false;
      }
    }
    return out;
  }

  // Anything still buffered when the stream ends is either plain trailing
  // text (safe to emit) or an unterminated <think> block (safe to drop —
  // it was never meant to be visible anyway).
  function flush(): string {
    const leftover = inThink ? "" : pending;
    pending = "";
    return leftover;
  }

  return { feed, flush };
}

/** Non-streaming variant: the full text is already in hand, so a simple global strip is enough. */
function stripThinkTags(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/gi, "");
}

function providerKeyFor(baseUrl: string, model: string): string {
  let host = baseUrl;
  try {
    host = new URL(baseUrl).hostname;
  } catch {
    /* keep raw baseUrl if it's not a parseable URL for some reason */
  }
  return `${host}/${model}`;
}

async function readErrorBody(res: Response): Promise<string> {
  // Fold the response body into the thrown error so ProviderBreaker.trip()
  // can parse a provider's own "retry in Xs" hint out of it, instead of
  // always falling back to the generic default cooldown.
  const text = await res.text().catch(() => "");
  return text.slice(0, 500);
}

/**
 * Thrown when a provider returns HTTP 200 with no usable content instead of
 * erroring outright. The most common cause here: a reasoning model (e.g.
 * Qwen on Groq) burns its entire max_tokens budget on hidden <think>...
 * </think> chain-of-thought and the stream ends before any real reply is
 * emitted, so thinkFilter discards everything and fullText is "".
 *
 * Before this existed, attemptStream() logged "answered" for these (the
 * HTTP call itself didn't throw) and streamChatWithFallback() silently
 * moved on to the next candidate with zero indication of why — making it
 * look like the provider was randomly flaky instead of predictably running
 * out of reasoning budget. Throwing this turns that into a visible,
 * loggable, stats-trackable failure.
 */
export class EmptyResponseError extends Error {
  readonly finishReason: string | null;
  constructor(baseUrl: string, finishReason: string | null) {
    const hint =
      finishReason === "length"
        ? " (hit max_tokens — likely reasoning consumed the whole budget before any reply content)"
        : "";
    super(`Request to ${baseUrl} returned an empty completion${hint}.`);
    this.name = "EmptyResponseError";
    this.finishReason = finishReason;
  }
}

export async function streamOpenAICompatibleChat(
  baseUrl: string,
  apiKey: string,
  model: string,
  messages: ChatMessage[],
  onToken: (chunk: string) => void,
  timeoutMs: number,
  clientSignal?: AbortSignal,
  extraBody?: Record<string, unknown>,
  maxTokens: number = 1024,
  onFinish?: (reason: string) => void
): Promise<string> {
  const controller = new AbortController();
  let firstTokenReceived = false;
  // Distinguishes a client-initiated stop (the user hit "Stop", the reply so
  // far should still be kept) from a genuine provider timeout/error (which
  // should surface as a failure so the fallback chain can move on).
  let clientAborted = clientSignal?.aborted ?? false;
  const onClientAbort = () => {
    clientAborted = true;
    controller.abort();
  };
  if (clientSignal) {
    if (clientSignal.aborted) controller.abort();
    else clientSignal.addEventListener("abort", onClientAbort);
  }
  const timer = setTimeout(() => {
    if (!firstTokenReceived) controller.abort();
  }, timeoutMs);

  const thinkFilter = createThinkTagFilter();

  try {
    let res: Response;
    try {
      recordProviderAttempt();
      res = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages,
          stream: true,
          stream_options: { include_usage: true },
          max_tokens: maxTokens,
          ...extraBody,
        }),
        signal: controller.signal,
      });
    } catch (err) {
      if (clientAborted) return "";
      if (err instanceof Error && err.name === "AbortError") {
        throw new Error(`Request to ${baseUrl} timed out after ${timeoutMs}ms waiting for a first response.`);
      }
      throw err;
    }

    if (!res.ok || !res.body) {
      const body = await readErrorBody(res);
      throw new Error(`Request to ${baseUrl} failed (${res.status}): ${body || "no response body"}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let fullText = "";
    let finishReason: string | null = null;
    let usage: { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } } | null = null;
    let chunkTimer: ReturnType<typeof setTimeout> | null = null;
    // Deliberately NOT the same budget as the time-to-first-token timer
    // above. `timeoutMs` is tuned to fail over to the next provider fast
    // when one is dead or not responding at all — for NVIDIA that's been
    // cut as low as 6s specifically for that purpose. But once a provider
    // has started streaming, a multi-second gap between chunks (batching,
    // a brief pause mid-generation on a large model, network jitter) is
    // normal and does NOT mean the provider died — it just means this
    // particular reply is longer. Reusing timeoutMs here meant every long
    // reply had many chances to hit one such gap and get killed mid-stream
    // (the frontend then wipes the partial text), while short replies
    // rarely lived long enough to hit one. Give the stall watchdog its own,
    // more generous floor so a live stream isn't punished for being long.
    const STREAM_STALL_FLOOR_MS = 20000;
    const stallTimeoutMs = Math.max(timeoutMs, STREAM_STALL_FLOOR_MS);
    const resetChunkTimer = () => {
      if (chunkTimer) clearTimeout(chunkTimer);
      chunkTimer = setTimeout(() => {
        if (!clientAborted) controller.abort();
      }, stallTimeoutMs);
    };
    resetChunkTimer();

    try {
      while (true) {
        let chunk: ReadableStreamReadResult<Uint8Array>;
        try {
          chunk = await reader.read();
        } catch (err) {
          if (clientAborted) return fullText;
          if (err instanceof Error && err.name === "AbortError") {
            throw new Error(firstTokenReceived
              ? `Request to ${baseUrl} stream stalled for ${stallTimeoutMs}ms mid-response.`
              : `Request to ${baseUrl} timed out after ${timeoutMs}ms waiting for a first response.`);
          }
          throw err;
        }
        const { done, value } = chunk;
        if (done && !buffer) break;
        if (!done) resetChunkTimer();
        buffer += done ? decoder.decode() + "\n" : decoder.decode(value, { stream: true });

        let newlineIndex;
        while ((newlineIndex = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, newlineIndex).trim();
          buffer = buffer.slice(newlineIndex + 1);
          if (!line.startsWith("data:")) continue;

          const payload = line.slice(5).trim();
          if (payload === "[DONE]") continue;

          let parsed: any;
          try {
            parsed = JSON.parse(payload);
          } catch {
            continue;
          }
          const token: string | undefined = parsed?.choices?.[0]?.delta?.content;
          if (token) {
            if (!firstTokenReceived) {
              firstTokenReceived = true;
              clearTimeout(timer);
            }
            const visible = thinkFilter.feed(token);
            if (visible) {
              fullText += visible;
              onToken(visible);
            }
          }
          const reason: string | undefined = parsed?.choices?.[0]?.finish_reason;
          if (reason) finishReason = reason;
          if (parsed?.usage) usage = parsed.usage;
        }
        if (clientAborted) return fullText;
        if (done) break;
      }

      const remainder = thinkFilter.flush();
      if (remainder) {
        fullText += remainder;
        onToken(remainder);
      }

      if (fullText.trim().length === 0) {
        throw new EmptyResponseError(baseUrl, finishReason);
      }


      onFinish?.(finishReason ?? "unknown");
      return fullText;
    } finally {
      if (typeof usage?.prompt_tokens === "number" && typeof usage?.completion_tokens === "number") {
        recordTokenUsage(
          providerKeyFor(baseUrl, model),
          usage.prompt_tokens ?? 0,
          usage.completion_tokens ?? 0,
          usage.prompt_tokens_details?.cached_tokens ?? 0
        );
      }
      if (chunkTimer) clearTimeout(chunkTimer);
    }
  } finally {
    clearTimeout(timer);
    if (clientSignal) clientSignal.removeEventListener("abort", onClientAbort);
  }
}

export async function completeOpenAICompatibleChat(
  baseUrl: string,
  apiKey: string,
  model: string,
  messages: ChatMessage[],
  timeoutMs: number,
  extraBody?: Record<string, unknown>,
  maxTokens: number = 1024,
  requireComplete = false
): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    let res: Response;
    try {
      recordProviderAttempt();
      res = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({ model, messages, stream: false, max_tokens: maxTokens, ...extraBody }),
        signal: controller.signal,
      });
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        throw new Error(`Request to ${baseUrl} timed out after ${timeoutMs}ms.`);
      }
      throw err;
    }

    if (!res.ok) {
      const body = await readErrorBody(res);
      throw new Error(`Request to ${baseUrl} failed (${res.status}): ${body || "no response body"}`);
    }

    const data = await res.json();
    const finishReason: string | null = data?.choices?.[0]?.finish_reason ?? null;
    const text: string = stripThinkTags(data?.choices?.[0]?.message?.content ?? "");
    if (typeof data?.usage?.prompt_tokens === "number" && typeof data?.usage?.completion_tokens === "number") {
      recordTokenUsage(
        providerKeyFor(baseUrl, model),
        data.usage.prompt_tokens ?? 0,
        data.usage.completion_tokens ?? 0,
        data.usage.prompt_tokens_details?.cached_tokens ?? 0
      );
    }
    if (text.trim().length === 0) {
      throw new EmptyResponseError(baseUrl, finishReason);
    }
    if (requireComplete && finishReason !== "stop") throw new Error("Memory completion did not finish normally.");
    return text;
  } finally {
    clearTimeout(timer);
  }
}
