/**
 * Health checks can fail every few seconds during a database outage. Logging the whole Prisma stack each time
 * buries everything else in the log, so log one short line, repeat it at most once per interval with a count,
 * and say when the database comes back.
 */
export function summarizeDbError(err: unknown): string {
  const e = err as { code?: unknown; message?: unknown } | null | undefined;
  const code = typeof e?.code === "string" ? e.code : "";
  const lines = String(e?.message ?? err ?? "unknown error").split("\n").map(l => l.trim()).filter(Boolean);
  // Prisma prefixes the real reason with "Invalid `prisma.x()` invocation:".
  const reason = lines.find(l => !/^Invalid `/.test(l)) ?? lines[0] ?? "unknown error";
  return `${code ? `${code}: ` : ""}${reason}`.slice(0, 300);
}

export function createDbFailureLogger(opts: { log?: (line: string) => void; now?: () => number; intervalMs?: number } = {}) {
  const log = opts.log ?? ((line: string) => console.error(line));
  const now = opts.now ?? Date.now;
  const intervalMs = opts.intervalMs ?? 60_000;
  let down = false;
  let lastLoggedAt = 0;
  let suppressed = 0;
  return {
    failed(err: unknown) {
      const t = now();
      if (!down || t - lastLoggedAt >= intervalMs) {
        const extra = suppressed > 0 ? ` (${suppressed} more failed checks since the last line)` : "";
        log(`[health] database check failed: ${summarizeDbError(err)}${extra}`);
        lastLoggedAt = t; suppressed = 0;
      } else suppressed++;
      down = true;
    },
    ok() {
      if (down) log(`[health] database reachable again${suppressed ? ` (${suppressed} failed checks were not logged)` : ""}`);
      down = false; suppressed = 0; lastLoggedAt = 0;
    },
  };
}
