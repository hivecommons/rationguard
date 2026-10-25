/**
 * Opt-in, local-only health diagnostics for `rationguard watch`, mirroring
 * @hivecommons/pluk's `--diagnostics` (#102). Writes one JSON line per
 * period to stderr — never stdout, which may carry `--json` detections —
 * with the bounded counters the watcher accumulates (flush/match/rebuttal
 * outcomes), so an operator running a long-lived watch session can tell a
 * quiet session from one that is repeatedly failing to send rebuttals.
 * The line names only fixed counter categories; no session name, raw
 * output, or other user-provided value is included, and nothing is sent
 * anywhere.
 */
const DIAGNOSTICS_INTERVAL_MS = 60_000;
// Node's setInterval caps timer delays at 2^31 - 1 ms (~24.8 days); larger
// values or Infinity are silently clamped to 1 ms, causing diagnostics spam.
export const MAX_TIMER_DELAY_MS = 2_147_483_647;
// Delays below 1 ms are clamped to 1 ms too, and anything this fast floods stderr.
export const MIN_DIAGNOSTICS_INTERVAL_MS = 1000;

export function isValidDiagnosticsSeconds(seconds: number): boolean {
  const ms = seconds * 1000;
  return Number.isFinite(ms) && ms >= MIN_DIAGNOSTICS_INTERVAL_MS && ms <= MAX_TIMER_DELAY_MS;
}

export function startDiagnostics(
  command: 'watch',
  snapshot: () => Record<string, number>,
  flag: string | undefined,
  write: (line: string) => void = line => process.stderr.write(line + '\n'),
): () => void {
  if (!flag) return () => {};
  const seconds = flag === 'true' ? NaN : Number(flag);
  const intervalMs = isValidDiagnosticsSeconds(seconds) ? seconds * 1000 : DIAGNOSTICS_INTERVAL_MS;
  const startedAt = Date.now();
  const report = (final: boolean): void => {
    try {
      write(JSON.stringify({
        rationguard_diagnostics: 1,
        command,
        uptime_s: Math.round((Date.now() - startedAt) / 1000),
        final,
        ...snapshot(),
      }));
    } catch {
      // Diagnostics must never take the watcher down with them.
    }
  };
  const timer = setInterval(() => report(false), intervalMs);
  timer.unref();
  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    report(true);
  };
}
