# Runbook: `rationguard watch` is quiet or rebuttals are not arriving

Use this when a long-running `rationguard watch`/`attach` session appears to
detect nothing, or the agent keeps "standing by" without receiving a rebuttal.
The failure is silent by design (the agent session itself keeps running), so
confirm with counters before assuming the agent is clean.

Related runbooks: `release-rollback.md`, `postmortem-template.md`.

## Impact

Excuses go undetected or uncorrected for that session only. Nothing is lost
permanently, but the guard is not doing its job until the cause is fixed.

## Detect

Restart (or start a second) watcher with diagnostics enabled; the JSON summary
goes to stderr, never stdout:

```sh
rationguard watch <session> --diagnostics=30 --verbose
```

Read the counters in each `rationguard_diagnostics` line:

| Counter | Meaning if it looks wrong |
|---|---|
| `flushCount` stays 0 | No output is reaching the watcher — pluk is not capturing, or `--run-dir`/`PLUK_RUN_DIR` points at the wrong directory. |
| `flushCount` grows, `cleanCount` equals it | Output is arriving but nothing matches. Expected for a clean agent; suspect the matcher only if excuses are visibly present. |
| `matchCount` grows, `rebuttalSent` is 0, `rebuttalSuppressed` grows | Cooldown (30s per pattern) or the 60s post-rebuttal quiet period is suppressing sends. Normal under bursts. |
| `rebuttalFailed` grows | Detection works but `pluk-send` delivery fails. See "Delivery failing". |
| `bufferFlushedFull` grows quickly | Output volume is overflowing the buffer; matches may be split. Check for a runaway log loop in the agent. |

## Diagnose

1. `rationguard sessions` — confirm the session is listed and its state and
   tmux column are healthy. If it is missing, check the run directory
   (`--run-dir` takes precedence over `PLUK_RUN_DIR`; default
   `/var/run/pluk`).
2. Confirm the rebuttal mode: `--rebuttal=log` only prints; delivery requires
   `--rebuttal=send`.
3. Project-local excuses are detection-only and never trigger a rebuttal, so
   a match from an untrusted working directory with `rebuttalSent` at 0 is
   expected.
4. `--verbose` logs `sendRebuttal: pluk-send failed: <error>` with the
   underlying reason.

## Delivery failing

- `tmux has-session -t <session>` — the tmux session must still exist.
- Confirm `pluk-send` resolves: rationguard prefers the copy bundled with its
  `@hivecommons/pluk` dependency, then falls back to `pluk-send` on `PATH`.
  `npm ls @hivecommons/pluk -g` shows which version is installed.
- If a recent upgrade coincides with the onset, treat it as a bad release and
  follow `release-rollback.md` (pin the last known-good version).

## Recover

1. Fix the cause above, then restart the watcher; counters reset on start.
2. Re-run with `--diagnostics` for a few minutes and confirm
   `rebuttalFailed` stays flat while `flushCount` grows.
3. If a code defect is found, file an issue with the final diagnostics line
   (it contains only counters, no session name or output) and use
   `postmortem-template.md` if users were affected.
