/**
 * Per-provider circuit breaker.
 *
 * Ported from the same pattern used in the ATS Resume Checker backend's
 * ai_client.py (ProviderBreaker there). The problem it solves: without it,
 * every chat request re-tries the first provider even if it was rate-limited
 * two seconds ago — so a busy period means every single message pays that
 * provider's full timeout before falling through to the next one. That's
 * slow for users and wastes the fallback chain's whole point.
 *
 * With a breaker: the first 429 (or a couple of back-to-back timeouts)
 * "opens" that provider's breaker for a cooldown window. Requests that land
 * during the cooldown skip straight to the next provider in the chain —
 * zero latency paid on a provider we already know is down. The cooldown
 * clears itself automatically; no restart needed.
 *
 * Each provider (and each API-key slot, if you configure a second key) gets
 * its own independent breaker instance.
 */

const RETRY_HINT_RE = /retry in\s+([\d.]+)\s*s/i;

export type BreakerDefaults = {
  cooldownSeconds: number;
  timeoutTripThreshold: number;
  timeoutCooldownSeconds: number;
};

export class ProviderBreaker {
  readonly name: string;
  private readonly cooldownSeconds: number;
  private readonly timeoutTripThreshold: number;
  private readonly timeoutCooldownSeconds: number;

  private cooldownUntil = 0;
  private consecutiveTimeouts = 0;

  constructor(name: string, defaults: BreakerDefaults, envPrefix: string) {
    this.name = name;
    this.cooldownSeconds = envFloat(`${envPrefix}_COOLDOWN_SECONDS`, defaults.cooldownSeconds);
    this.timeoutTripThreshold = envInt(`${envPrefix}_TIMEOUT_TRIP_THRESHOLD`, defaults.timeoutTripThreshold);
    this.timeoutCooldownSeconds = envFloat(`${envPrefix}_TIMEOUT_COOLDOWN_SECONDS`, defaults.timeoutCooldownSeconds);
  }

  /** True if this provider is currently in its cooldown window and should be skipped. */
  isOpen(): boolean {
    return Date.now() < this.cooldownUntil;
  }

  /** Call after a successful response — clears the consecutive-timeout counter. */
  reset() {
    this.consecutiveTimeouts = 0;
  }

  /**
   * Call on a plain (non-429) timeout. Trips the breaker if several land in
   * a row with no successes between them — the same signal as an explicit
   * 429, just inferred rather than told to us, so it gets a shorter cooldown.
   */
  recordTimeout() {
    this.consecutiveTimeouts += 1;
    const shouldTrip =
      this.consecutiveTimeouts >= this.timeoutTripThreshold && Date.now() >= this.cooldownUntil;
    if (shouldTrip) {
      this.cooldownUntil = Date.now() + this.timeoutCooldownSeconds * 1000;
      this.consecutiveTimeouts = 0;
      console.warn(
        `[breaker] ${this.name}: ${this.timeoutTripThreshold} consecutive timeouts — opening for ${this.timeoutCooldownSeconds}s`
      );
    }
  }

  /**
   * Open the breaker after a quota/rate-limit error. Prefers the exact wait
   * time the provider reports ("Please try again in 14.86s") when parseable;
   * otherwise falls back to this breaker's configured cooldown.
   */
  trip(error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    let waitSeconds = this.cooldownSeconds;
    const match = RETRY_HINT_RE.exec(message);
    if (match) {
      const parsed = parseFloat(match[1]);
      if (!Number.isNaN(parsed)) waitSeconds = parsed + 2;
    }
    this.cooldownUntil = Date.now() + waitSeconds * 1000;
    this.consecutiveTimeouts = 0;
    console.warn(`[breaker] ${this.name}: rate-limited — opening for ${waitSeconds.toFixed(1)}s`);
  }
}

export function isRateLimitError(error: unknown): boolean {
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
  return (
    message.includes("429") ||
    message.includes("quota") ||
    message.includes("rate limit") ||
    message.includes("resource_exhausted") ||
    message.includes("too_many_requests") ||
    message.includes("permission-denied") ||
    message.includes("no credits") ||
    message.includes("no licenses")
  );
}

export function isTimeoutError(error: unknown): boolean {
  if (error instanceof Error && error.name === "AbortError") return true;
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
  return message.includes("timed out") || message.includes("timeout") || message.includes("aborted");
}

function envFloat(name: string, def: number): number {
  const raw = process.env[name];
  const parsed = raw ? parseFloat(raw) : NaN;
  return Number.isFinite(parsed) ? parsed : def;
}

function envInt(name: string, def: number): number {
  const raw = process.env[name];
  const parsed = raw ? parseInt(raw, 10) : NaN;
  return Number.isFinite(parsed) ? parsed : def;
}
