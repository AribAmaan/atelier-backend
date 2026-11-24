import { TELEMETRY_TAG, type ReplyTelemetry } from "./replyTelemetry";
import { FLAG_NAMES, type FlagName } from "./roleplayFlags";

/**
 * Turns [roleplay-telemetry] log lines into answers about the experiments.
 *
 * Arms are assigned by a stable hash of (flag, user), independently per flag,
 * so comparing "on" with "off" for one flag averages over the other flags and
 * is a randomized comparison, not a correlation. It is still only as good as
 * its sample size, which is why every comparison carries a z statistic and a
 * p value, and why small groups are flagged instead of reported as findings.
 *
 * Retention definitions (cohort = users first SEEN in the supplied logs, so a
 * long-time user's first line in the window counts as day 0; this biases both
 * arms equally):
 *  - returnNextDay   active on the UTC day after the first day seen
 *  - returnWithin7d  active on any of the 7 UTC days after the first day seen
 * A user is counted only when that whole window has elapsed before the last
 * (possibly partial) day in the logs.
 */

const DAY_MS = 86_400_000;
const MIN_USERS_PER_ARM = 100;
const TURN_BUCKETS: [number, number, string][] = [[0, 20, "0-19"], [20, 50, "20-49"], [50, 100, "50-99"], [100, Infinity, "100+"]];

export function parseTelemetryLines(text: string): ReplyTelemetry[] {
  const out: ReplyTelemetry[] = [];
  for (const line of text.split(/\r?\n/)) {
    const at = line.indexOf(TELEMETRY_TAG);
    if (at < 0) continue;
    const brace = line.indexOf("{", at + TELEMETRY_TAG.length);
    if (brace < 0) continue;
    try {
      const e = JSON.parse(line.slice(brace)) as ReplyTelemetry;
      if (e && e.v === 1 && typeof e.uh === "string" && e.uh && Number.isFinite(Date.parse(e.ts)) && e.arms && typeof e.arms === "object"
        && Number.isFinite(e.words) && Number.isFinite(e.turn) && Array.isArray(e.steers)) out.push(e);
    } catch {
      /* skip lines that are not valid telemetry */
    }
  }
  return out;
}

/** Abramowitz & Stegun 7.1.26, absolute error < 1.5e-7. */
function erf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * ax);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-ax * ax);
  return sign * y;
}

export const normalCdf = (z: number) => 0.5 * (1 + erf(z / Math.SQRT2));

export type Compare = { onRate: number; offRate: number; onN: number; offN: number; diff: number; z: number; p: number };

/** Pooled two-proportion z test (two-sided). null when it is undefined (an empty arm, or no variation). */
export function twoProportionTest(onSuccess: number, onN: number, offSuccess: number, offN: number): Compare | null {
  if (onN <= 0 || offN <= 0) return null;
  const p1 = onSuccess / onN, p2 = offSuccess / offN;
  const pooled = (onSuccess + offSuccess) / (onN + offN);
  const se = Math.sqrt(pooled * (1 - pooled) * (1 / onN + 1 / offN));
  if (!(se > 0)) return null;
  const z = (p1 - p2) / se;
  return { onRate: p1, offRate: p2, onN, offN, diff: p1 - p2, z, p: 2 * (1 - normalCdf(Math.abs(z))) };
}

export type ArmStats = {
  users: number;
  replies: number;
  repliesPerUser: number;
  meanWords: number;
  actionRate: number;
  questionEndRate: number;
  assistantismRate: number;
  ticRate: number;
  steerRates: Record<string, number>;
};

export type TurnBucketStats = { bucket: string; replies: number; assistantismRate: number; ticRate: number; meanWords: number };

export type FlagReport = {
  flag: FlagName;
  on: ArmStats;
  off: ArmStats;
  returnNextDay: Compare | null;
  returnWithin7d: Compare | null;
  byTurn: { on: TurnBucketStats[]; off: TurnBucketStats[] };
  warnings: string[];
};

const share = (n: number, d: number) => (d ? n / d : 0);

function armStats(events: ReplyTelemetry[]): ArmStats {
  const users = new Set(events.map(e => e.uh));
  const steerCounts: Record<string, number> = {};
  for (const e of events) for (const id of new Set(e.steers)) steerCounts[id] = (steerCounts[id] ?? 0) + 1;
  const steerRates: Record<string, number> = {};
  for (const [id, n] of Object.entries(steerCounts)) steerRates[id] = share(n, events.length);
  return {
    users: users.size,
    replies: events.length,
    repliesPerUser: share(events.length, users.size),
    meanWords: share(events.reduce((a, e) => a + e.words, 0), events.length),
    actionRate: share(events.filter(e => e.actions > 0).length, events.length),
    questionEndRate: share(events.filter(e => e.endsQuestion).length, events.length),
    assistantismRate: share(events.filter(e => e.assistantisms > 0).length, events.length),
    ticRate: share(events.filter(e => e.tics > 0).length, events.length),
    steerRates,
  };
}

function byTurn(events: ReplyTelemetry[]): TurnBucketStats[] {
  return TURN_BUCKETS.map(([lo, hi, bucket]) => {
    const inBucket = events.filter(e => e.turn >= lo && e.turn < hi);
    return {
      bucket,
      replies: inBucket.length,
      assistantismRate: share(inBucket.filter(e => e.assistantisms > 0).length, inBucket.length),
      ticRate: share(inBucket.filter(e => e.tics > 0).length, inBucket.length),
      meanWords: share(inBucket.reduce((a, e) => a + e.words, 0), inBucket.length),
    };
  });
}

type UserTrack = { firstDay: number; days: Set<number>; firstArms: ReplyTelemetry["arms"] };

export function analyzeTelemetry(events: ReplyTelemetry[]): FlagReport[] {
  const dayOf = (e: ReplyTelemetry) => Math.floor(Date.parse(e.ts) / DAY_MS);
  const sorted = [...events].sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
  const lastDay = sorted.length ? dayOf(sorted[sorted.length - 1]) : 0;
  const tracks = new Map<string, UserTrack>();
  for (const e of sorted) {
    const d = dayOf(e);
    const t = tracks.get(e.uh);
    if (!t) tracks.set(e.uh, { firstDay: d, days: new Set([d]), firstArms: e.arms });
    else t.days.add(d);
  }

  return FLAG_NAMES.map(flag => {
    // A user belongs to the arm they were first seen in, even if the env later changed.
    const armOfUser = (uh: string) => Boolean(tracks.get(uh)?.firstArms?.[flag]);
    const onEvents = sorted.filter(e => armOfUser(e.uh));
    const offEvents = sorted.filter(e => !armOfUser(e.uh));

    const retention = (windowDays: number, test: (t: UserTrack) => boolean) => {
      // Whole window must have elapsed before the last, possibly partial, day.
      const eligible = [...tracks.entries()].filter(([, t]) => t.firstDay + windowDays <= lastDay - 1);
      const on = eligible.filter(([uh]) => armOfUser(uh));
      const off = eligible.filter(([uh]) => !armOfUser(uh));
      return twoProportionTest(on.filter(([, t]) => test(t)).length, on.length, off.filter(([, t]) => test(t)).length, off.length);
    };
    const returnNextDay = retention(1, t => t.days.has(t.firstDay + 1));
    const returnWithin7d = retention(7, t => { for (let k = 1; k <= 7; k++) if (t.days.has(t.firstDay + k)) return true; return false; });

    const on = armStats(onEvents), off = armStats(offEvents);
    const warnings: string[] = [];
    if (!on.users || !off.users) warnings.push("Only one arm has data: this flag is not split, so nothing can be compared.");
    else if (on.users < MIN_USERS_PER_ARM || off.users < MIN_USERS_PER_ARM) {
      warnings.push(`Fewer than ${MIN_USERS_PER_ARM} users in an arm (on ${on.users}, off ${off.users}): treat any difference as noise.`);
    }
    if (on.users && off.users && !returnNextDay) warnings.push("No user has been observed long enough for a retention comparison yet.");
    return { flag, on, off, returnNextDay, returnWithin7d, byTurn: { on: byTurn(onEvents), off: byTurn(offEvents) }, warnings };
  });
}

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
const cmp = (c: Compare | null) => c
  ? `on ${pct(c.onRate)} (n=${c.onN}) vs off ${pct(c.offRate)} (n=${c.offN}), diff ${c.diff >= 0 ? "+" : ""}${(c.diff * 100).toFixed(1)} pts, z=${c.z.toFixed(2)}, p=${c.p.toFixed(3)}`
  : "not enough data";

export function renderReport(reports: FlagReport[], totalEvents: number): string {
  const lines: string[] = [`Roleplay experiment report (${totalEvents} replies)`, ""];
  for (const r of reports) {
    lines.push(`== ${r.flag} ==`);
    lines.push(`  users            on ${r.on.users} / off ${r.off.users}`);
    lines.push(`  replies per user on ${r.on.repliesPerUser.toFixed(1)} / off ${r.off.repliesPerUser.toFixed(1)}`);
    lines.push(`  mean words       on ${r.on.meanWords.toFixed(1)} / off ${r.off.meanWords.toFixed(1)}`);
    lines.push(`  non-verbal beat  on ${pct(r.on.actionRate)} / off ${pct(r.off.actionRate)}`);
    lines.push(`  ends on question on ${pct(r.on.questionEndRate)} / off ${pct(r.off.questionEndRate)}`);
    lines.push(`  assistant-isms   on ${pct(r.on.assistantismRate)} / off ${pct(r.off.assistantismRate)}`);
    lines.push(`  stock tics       on ${pct(r.on.ticRate)} / off ${pct(r.off.ticRate)}`);
    lines.push(`  return next day  ${cmp(r.returnNextDay)}`);
    lines.push(`  return within 7d ${cmp(r.returnWithin7d)}`);
    if (r.flag === "personaAnchor") {
      lines.push("  assistant-isms by conversation turn (drift check):");
      r.byTurn.on.forEach((b, i) => lines.push(`    turn ${b.bucket.padEnd(6)} on ${pct(b.assistantismRate)} (n=${b.replies}) / off ${pct(r.byTurn.off[i].assistantismRate)} (n=${r.byTurn.off[i].replies})`));
    }
    for (const w of r.warnings) lines.push(`  ! ${w}`);
    lines.push("");
  }
  lines.push("Four flags and two retention outcomes are compared at once: a p value near 0.05 in one of them is expected by chance. Prefer differences that are large, consistent across outcomes, and still there with more data.");
  return lines.join("\n");
}
