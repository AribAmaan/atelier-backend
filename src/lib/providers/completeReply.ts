import type { GenParams } from "./index";
import { clampReplyToWordCeiling, replySentenceEnds } from "./replyPolicy";

type Message = { role: "system" | "user" | "assistant"; content: string };
type Stream = (messages: Message[], onToken: (text: string) => void, signal?: AbortSignal, params?: GenParams) => Promise<string>;

function countWords(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

/**
 * Premium/locked tiers should not collapse to a one-liner just because a
 * provider ignored the prompt. This is intentionally a single bounded
 * same-provider continuation, not a regeneration: it preserves the reply
 * already streamed and asks only for the missing depth.
 */
function depthContinuationSuffix(previous: string, next: string): string {
  next = next.trimStart();
  if (!next) return "";
  if (next.startsWith(previous)) return next.slice(previous.length);

  // Strip a repeated tail if the model echoed a little context before
  // continuing. Requiring a meaningful overlap avoids guessing joins.
  for (let n = Math.min(previous.length, next.length); n >= 8; n--) {
    const overlap = next.slice(0, n);
    const wholeEnding = /[.!?。！？।॥]["'”’)*_\]]*$/.test(overlap) && countWords(overlap) >= 3;
    if ((n >= 24 || wholeEnding) && previous.endsWith(overlap)
      && (n === previous.length || /\s/.test(previous[previous.length - n - 1]))) return next.slice(n);
  }

  // Depth continuations are explicitly instructed to begin with NEW text, so
  // an un-repeated completion can be appended safely with natural spacing.
  const fresh = next.trimStart();
  if (!fresh) return "";
  return `${/\s$/.test(previous) || /^[,.;:!?]/.test(fresh) ? "" : " "}${fresh}`;
}

/** Same-provider recovery for token cutoffs plus one bounded tier-depth top-up after an abnormally short normal stop. */
export async function streamCompleteReply(stream: Stream, messages: Message[], onToken: (text: string) => void, signal?: AbortSignal, params?: GenParams) {
  let reason = "unknown";
  const capture = (value: string) => { reason = value; };
  const maxWords = params?.maxWords ?? 0;
  const minWords = params?.minWords ?? 0;

  // Publish complete sentences for every capped tier. Holding the unfinished
  // sentence prevents the final word ceiling from retracting visible text.
  // Sentence-sized buffering adds no provider call or token allowance.
  let streamedVisible = "";
  let providerVisible = "";
  const cappedOnToken = maxWords > 0 ? (chunk: string) => {
    if (!chunk) return;
    providerVisible = (providerVisible + chunk).trimStart();
    let safeEnd = 0;
    for (const end of replySentenceEnds(providerVisible)) {
      if (countWords(providerVisible.slice(0, end)) > maxWords) break;
      safeEnd = end;
    }
    if (safeEnd > streamedVisible.length) {
      const addition = providerVisible.slice(streamedVisible.length, safeEnd);
      streamedVisible = providerVisible.slice(0, safeEnd);
      onToken(addition);
    }
  } : onToken;

  const completed = await stream(messages, cappedOnToken, signal, { ...params, onFinish: capture });
  const rawText = maxWords > 0 ? completed.trimStart() : completed;
  let text = maxWords > 0 ? clampReplyToWordCeiling(rawText, maxWords, minWords) : rawText;
  if (maxWords > 0 && text.startsWith(streamedVisible)) {
    const deferred = text.slice(streamedVisible.length);
    if (deferred) onToken(deferred);
  }

  let continuations = 0;

  // If the model ignored the prompt and already ran past the tier ceiling,
  // the saved/final reply is capped locally. Do not ask for an additional
  // continuation merely because the provider itself stopped on max_tokens.
  if (reason === "length" && maxWords > 0 && countWords(rawText) > maxWords) reason = "stop";

  while (reason === "length" && text.trim() && !signal?.aborted && continuations < 2 && (!maxWords || countWords(text) < maxWords)) {
    continuations++;
    const anchor = text.slice(-160);
    const recovery: Message[] = [
      ...messages,
      { role: "assistant", content: text },
      { role: "system", content: `The previous output hit a token limit. Finish that same reply, without starting another scene or taking the user's turn. Begin by copying the exact tail below (including its spacing), then continue directly from its final character. Finish the pending thought and stop promptly. Do not explain the interruption.\n<reply_tail>${anchor}</reply_tail>` },
    ];
    reason = "unknown";
    try {
      // Buffer recovery so an echoed prefix never appears twice on screen.
      const next = await stream(recovery, () => {}, signal, {
        ...params, maxTokens: params?.continuationMaxTokens !== undefined
          ? Math.min(1024, Math.max(64, params.continuationMaxTokens))
          : Math.min(1024, Math.max(512, params?.maxTokens ?? 512)), onFinish: capture,
      });
      if (signal?.aborted) break;
      const suffix = continuationSuffix(text, next, anchor);
      if (!suffix) {
        if (reason === "stop" || reason === "length") reason = "length";
        break;
      }
      const combined = maxWords > 0 ? clampReplyToWordCeiling(text + suffix, maxWords, minWords) : text + suffix;
      const accepted = combined.startsWith(text) ? combined.slice(text.length) : "";
      if (!accepted) {
        if (reason === "stop" || reason === "length") reason = maxWords > 0 && countWords(text) >= maxWords ? "stop" : "length";
        break;
      }
      text = combined;
      onToken(accepted);
      if (reason === "length" && maxWords > 0 && countWords(text) >= maxWords) reason = "stop";
    } catch {
      // Keep already-visible content; do not replace it with another provider.
      reason = "length";
      break;
    }
  }

  // A normal provider stop can still be far below the server-owned tier
  // minimum. Recover that once on the SAME provider so a greeting or tiny
  // user message cannot collapse Chocolate/Hazelnut (or any other tier) into
  // a one-liner. Unknown/content-filter/cancelled endings are never extended.
  const minimumWords = params?.minWords ?? 0;
  if (reason === "stop" && continuations < 2 && minimumWords > 0 && countWords(text) < minimumWords && text.trim() && !signal?.aborted) {
    const targetWords = Math.max(minimumWords, params?.targetWords ?? minimumWords);
    const currentWords = countWords(text);
    const missingWords = Math.max(1, targetWords - currentWords);
    const recovery: Message[] = [
      ...messages,
      { role: "assistant", content: text },
      { role: "system", content: `The assistant reply above stopped too early for this engine's fixed tier envelope. Continue that SAME assistant turn only, adding roughly ${missingWords} words of natural character-specific dialogue, action, atmosphere, or subtext until the COMPLETE reply is near ${targetWords} words. Start directly with new continuation text; do not restart, summarize, repeat the existing opening, take the user's turn, or begin a new scene. Finish naturally.` },
    ];
    let extensionReason = "unknown";
    continuations++;
    try {
      const next = await stream(recovery, () => {}, signal, {
        ...params,
        // Scale the top-up budget to the amount actually missing. The old
        // fixed 320-token allowance could turn a 30-word top-up into another
        // full paragraph and push a 120-word tier close to 200 words.
        maxTokens: Math.min(
          params?.continuationMaxTokens ?? 160,
          Math.max(64, Math.ceil(missingWords * 1.8 + 24))
        ),
        onFinish: value => { extensionReason = value; },
      });
      if (!signal?.aborted) {
        const suffix = depthContinuationSuffix(text, next);
        if (suffix) {
          const combined = maxWords > 0 ? clampReplyToWordCeiling(text + suffix, maxWords, minimumWords) : text + suffix;
          const accepted = combined.startsWith(text) ? combined.slice(text.length) : "";
          if (accepted) {
            text = combined;
            onToken(accepted);
            // Reaching a word minimum does not finish a sentence. Preserve
            // length/unknown/filter metadata so the UI can report a cutoff.
            reason = extensionReason;
            if (reason === "length" && maxWords > 0 && countWords(text) >= maxWords) reason = "stop";
          }
        }
      }
    } catch {
      // A tier-depth top-up is best-effort. Keep the valid first completion
      // instead of turning an otherwise successful reply into a provider fail.
    }
  }

  const finishReason = signal?.aborted ? "cancelled" : reason;
  params?.onFinish?.(finishReason);
  return { text, finishReason, continuations };
}

export function continuationSuffix(previous: string, next: string, anchor = previous.slice(-160)): string {
  if (next.startsWith(previous)) return next.slice(previous.length);
  const start = next.indexOf(anchor);
  if (start >= 0 && next.slice(0, start).trim() === "") return next.slice(start + anchor.length);
  // Some models strip leading whitespace from the requested tail.
  const trimmed = anchor.trimStart();
  if (trimmed && next.trimStart().startsWith(trimmed)) return next.trimStart().slice(trimmed.length);
  // Accept a shorter exact overlap, but never guess how to join an unfinished
  // word. An unanchored continuation stays flagged as incomplete for the UI.
  for (let n = Math.min(previous.length, next.length); n >= 24; n--) {
    if (previous.endsWith(next.slice(0, n))) return next.slice(n);
  }
  return "";
}
