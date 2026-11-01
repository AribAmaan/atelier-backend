/**
 * Tracks real prompt/completion/cached token counts per provider+model,
 * logged every 60s alongside the existing request-count stats in index.ts
 * (see providerStats/logProviderStats there). This is its own module,
 * separate from index.ts, because openaiCompatible.ts is imported BY
 * index.ts's provider wrappers (groq.ts, nvidia.ts, sambanova.ts,
 * cloudflareChat.ts) — importing index.ts back into openaiCompatible.ts
 * to reuse its stats map would create a circular import.
 *
 * This replaces guesswork ("a Choco Hazelnut reply probably costs ~3.5-5K
 * tokens") with the actual numbers Groq/NVIDIA/SambaNova report back on
 * every request via the standard OpenAI-compatible `usage` field.
 */

import { AsyncLocalStorage } from "node:async_hooks";

interface TokenStats {
  requests: number;
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
}

const tokenStats = new Map<string, TokenStats>();

export type TurnUsage = {
  engine: string;
  kind: "reply" | "memory";
  attempts: number;
  reportedCalls: number;
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
  finishReason?: string;
  continuations?: number;
};
const usageContext = new AsyncLocalStorage<TurnUsage>();

/** Per-REPLY totals for the 60s window. The per-provider table above averages per CALL, so a reply that needed a
 * depth top-up (a second call that resends the whole prompt) looks half as expensive there as it really is. */
export type ReplyWindow = { replies: number; withContinuation: number; promptTokens: number; completionTokens: number; incomplete: number };
const emptyWindow = (): ReplyWindow => ({ replies: 0, withContinuation: 0, promptTokens: 0, completionTokens: 0, incomplete: 0 });
let replyWindow = emptyWindow();

export function noteReplyForWindow(usage: TurnUsage, usageComplete: boolean, window: ReplyWindow = replyWindow) {
  if (usage.kind !== "reply") return;
  window.replies++;
  if ((usage.continuations ?? 0) > 0) window.withContinuation++;
  window.promptTokens += usage.promptTokens;
  window.completionTokens += usage.completionTokens;
  if (!usageComplete) window.incomplete++;
}

export function formatReplyWindow(w: ReplyWindow): string | undefined {
  if (w.replies === 0) return undefined;
  const pct = Math.round((w.withContinuation / w.replies) * 100);
  return `[tokens] replies: ${w.replies} | with top-up/continuation: ${w.withContinuation} (${pct}%) | ` +
    `avg input per reply: ${Math.round(w.promptTokens / w.replies)} | avg output per reply: ${Math.round(w.completionTokens / w.replies)}` +
    (w.incomplete > 0 ? ` | ${w.incomplete} with unreported calls (timeouts/cancels), so these are lower bounds` : "");
}

export function recordProviderAttempt() {
  const usage = usageContext.getStore();
  if (usage) usage.attempts++;
}

/** Separate request-local totals from provider averages. Recovery and fallback
 * calls share a scope; memory calls have their own scope for amortized costing.
 * Missing provider usage is explicitly reported, never presented as zero cost.
 */
export async function withTokenAccounting<T>(
  engine: string, kind: TurnUsage["kind"], operation: () => Promise<T>,
  report: (usage: TurnUsage & { succeeded: boolean; usageComplete: boolean }) => void = usage => console.log(`[turn-usage] ${JSON.stringify(usage)}`)
): Promise<T> {
  const usage: TurnUsage = { engine, kind, attempts: 0, reportedCalls: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0 };
  return usageContext.run(usage, async () => {
    let succeeded = false;
    try {
      const result = await operation();
      if (result && typeof result === "object") {
        if ("finishReason" in result && typeof result.finishReason === "string") usage.finishReason = result.finishReason;
        if ("continuations" in result && typeof result.continuations === "number") usage.continuations = result.continuations;
      }
      succeeded = true;
      return result;
    }
    finally {
      const usageComplete = usage.attempts > 0 && usage.attempts === usage.reportedCalls;
      if (succeeded) noteReplyForWindow(usage, usageComplete);
      report({ ...usage, succeeded, usageComplete });
    }
  });
}

export function recordTokenUsage(
  providerKey: string,
  promptTokens: number,
  completionTokens: number,
  cachedTokens: number = 0
) {
  const usage = usageContext.getStore();
  if (usage) {
    usage.reportedCalls++;
    usage.promptTokens += Math.max(0, promptTokens);
    usage.completionTokens += Math.max(0, completionTokens);
    usage.cachedTokens += Math.max(0, cachedTokens);
  }
  if (promptTokens <= 0 && completionTokens <= 0) return;
  const stats = tokenStats.get(providerKey) || {
    requests: 0,
    promptTokens: 0,
    completionTokens: 0,
    cachedTokens: 0,
  };
  stats.requests++;
  stats.promptTokens += promptTokens;
  stats.completionTokens += completionTokens;
  stats.cachedTokens += cachedTokens;
  tokenStats.set(providerKey, stats);
}

function logTokenStats() {
  const entries = [...tokenStats.entries()];
  const replySummary = formatReplyWindow(replyWindow);
  replyWindow = emptyWindow();
  if (entries.length === 0 && !replySummary) return;
  console.log("\n[tokens] === Token usage (last 60s) ===");
  for (const [key, stats] of entries) {
    const avgPrompt = Math.round(stats.promptTokens / stats.requests);
    const avgCompletion = Math.round(stats.completionTokens / stats.requests);
    const cachePct =
      stats.promptTokens > 0 ? Math.round((stats.cachedTokens / stats.promptTokens) * 100) : 0;
    console.log(
      `[tokens] ${key.padEnd(24)} | req: ${String(stats.requests).padStart(4)} | ` +
        `avg prompt: ${String(avgPrompt).padStart(5)} | avg completion: ${String(avgCompletion).padStart(4)} | ` +
        `cached: ${String(cachePct).padStart(3)}% | total: ${stats.promptTokens + stats.completionTokens}`
    );
  }
  if (replySummary) console.log(replySummary);
  console.log("[tokens] ==========================================\n");
  for (const [key] of entries) {
    tokenStats.delete(key);
  }
}

setInterval(logTokenStats, 60_000).unref();
