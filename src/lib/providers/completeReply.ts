import type { GenParams } from "./index";
import { dropRepeatedSentences } from "./replyRepeat";

type Message = { role: "system" | "user" | "assistant"; content: string };
type Stream = (messages: Message[], onToken: (text: string) => void, signal?: AbortSignal, params?: GenParams) => Promise<string>;

/**
 * Models often ignore "do not restart" and re-send the opening of the reply
 * (sometimes with a new tail). Anything the reply already says is discarded so
 * a continuation can only add NEW text; if nothing new is left, no suffix.
 */
function withoutRepeats(previous: string, suffix: string): string {
  if (!suffix.trim()) return "";
  const novel = dropRepeatedSentences(suffix, [previous], { trim: false, allowEmpty: true });
  if (!novel.trim()) return "";
  return /^\s/.test(novel) || /\s$/.test(previous) || /^[,.;:!?]/.test(novel) ? novel : ` ${novel}`;
}

/**
 * Streams a reply exactly as the provider produces it. Nothing is trimmed,
 * capped or padded: reply length is decided by the model from the prompt
 * guidance. The only recovery is finishing a sentence the provider cut off
 * at the token ceiling, on the SAME provider, at most twice.
 */
export async function streamCompleteReply(stream: Stream, messages: Message[], onToken: (text: string) => void, signal?: AbortSignal, params?: GenParams) {
  let reason = "unknown";
  const capture = (value: string) => { reason = value; };

  let text = await stream(messages, onToken, signal, { ...params, onFinish: capture });
  let continuations = 0;

  while (reason === "length" && text.trim() && !signal?.aborted && continuations < 2) {
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
      const suffix = withoutRepeats(text, continuationSuffix(text, next, anchor));
      if (!suffix) {
        if (reason === "stop" || reason === "length") reason = "length";
        break;
      }
      text += suffix;
      onToken(suffix);
    } catch {
      // Keep already-visible content; do not replace it with another provider.
      reason = "length";
      break;
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
