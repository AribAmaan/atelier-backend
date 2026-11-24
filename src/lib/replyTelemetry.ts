import { createHash } from "node:crypto";
import { measureReply } from "./providers/replyMetrics";
import type { Arms } from "./roleplayFlags";

/**
 * One structured log line per generated reply, for evaluating the roleplay
 * experiments (roleplayFlags.ts) and watching for persona drift.
 *
 * What it records: which experiment arms the user was in, which director
 * steers fired, the conversation turn number, and form-only measurements of
 * the reply (word count, action beats, whether it ended on a question, how
 * many assistant-style phrases and stock reactions it contained).
 *
 * What it never records: message text, character text, names, or raw ids.
 * User and character ids are salted one-way hashes, stable enough to follow
 * one pseudonymous user over time (needed for retention) and useless for
 * identifying anyone. Set ROLEPLAY_TELEMETRY=off to disable it entirely, and
 * change ROLEPLAY_TELEMETRY_SALT to unlink all earlier records.
 */

export const TELEMETRY_TAG = "[roleplay-telemetry]";
const DEFAULT_SALT = "atelier-roleplay";

export function telemetryEnabled(): boolean {
  return (process.env.ROLEPLAY_TELEMETRY ?? "").trim().toLowerCase() !== "off";
}

export function pseudonym(id: string, length = 12): string {
  const salt = process.env.ROLEPLAY_TELEMETRY_SALT || DEFAULT_SALT;
  return createHash("sha256").update(`${salt}:${id}`).digest("hex").slice(0, length);
}

export type TelemetryInput = {
  userId: string;
  characterId: string;
  engineId: string;
  intelligence: number;
  arms: Arms;
  beat: string;
  steerIds: string[];
  /** Messages in the conversation before this reply (folded + recent). */
  turn: number;
  reply: string;
};

export type ReplyTelemetry = {
  v: 1;
  ts: string;
  uh: string;
  ch: string;
  engine: string;
  tier: number;
  arms: Arms;
  beat: string;
  steers: string[];
  turn: number;
  words: number;
  actions: number;
  endsQuestion: boolean;
  assistantisms: number;
  tics: number;
};

export function buildReplyTelemetry(input: TelemetryInput, now: Date = new Date()): ReplyTelemetry {
  const m = measureReply(typeof input.reply === "string" ? input.reply : "");
  const whole = (n: unknown) => (typeof n === "number" && Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0);
  return {
    v: 1,
    ts: now.toISOString(),
    uh: pseudonym(String(input.userId ?? "")),
    ch: pseudonym(String(input.characterId ?? ""), 8),
    engine: String(input.engineId ?? ""),
    tier: whole(input.intelligence),
    arms: { ...input.arms },
    beat: String(input.beat ?? ""),
    steers: Array.isArray(input.steerIds) ? input.steerIds.map(String) : [],
    turn: whole(input.turn),
    words: m.words,
    actions: m.actions,
    endsQuestion: m.endsQuestion,
    assistantisms: m.assistantisms,
    tics: m.tics,
  };
}

/** Never throws: telemetry must not be able to fail a reply. */
export function logReplyTelemetry(input: TelemetryInput): void {
  if (!telemetryEnabled()) return;
  try {
    console.log(`${TELEMETRY_TAG} ${JSON.stringify(buildReplyTelemetry(input))}`);
  } catch {
    /* ignore */
  }
}
