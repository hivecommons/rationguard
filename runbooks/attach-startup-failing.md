# Runbook: `rationguard attach` fails to start or does not monitor the agent

Use this when `rationguard attach <session>` exits immediately, no detections
appear in the terminal that ran it, or the agent starts but is not being
watched. For a watcher that starts but stays quiet, use
`watch-session-degraded.md` instead.

Related runbooks: `watch-session-degraded.md`, `release-rollback.md`,
`postmortem-template.md`.

## Impact

The agent session may run unmonitored: nothing is detected or corrected until
a watcher is attached. No data is lost; the guard is simply not active.

## Detect

Re-run with `--verbose` (add `--no-open` to skip the terminal window); every
step is logged to stderr:

```sh
rationguard attach <session> --cli=claude --no-open --verbose
```

Match the message you see:

| Message | Cause |
|---|---|
| `not found on PATH` (from pluk) | pluk cannot resolve a rationguard to launch. |
| `--rationguard-bin / PLUK_RATIONGUARD_BIN command not found or not executable` | The override points at a missing command. |
| `Failed to start rationguard (<cmd>): ...` | The resolved watcher command exists but could not be spawned; `attach` exits 1. |
| `Warning: pluk binary not found, skipping pipe-pane attachment` | Output capture is off, so the watcher receives no events. |
| `Warning: --dangerous`, `--command`, `--cli-args` or `--dir` `was set but session already exists` | The tmux session already existed; the running CLI was not restarted and the flag had no effect. |
| `invalid session name` | Session names allow only letters, numbers, underscore and dash. |

## Diagnose

1. `tmux -V` and `tmux has-session -t <session>` — tmux must be installed;
   an existing session is reused, not recreated.
2. `rationguard sessions` — confirm the session is listed with a live tmux
   marker. If not, check the run directory (`--run-dir` takes precedence over
   `PLUK_RUN_DIR`).
3. `npm ls -g @hivecommons/pluk @hivecommons/rationguard` — both must be
   installed, or `--rationguard-bin`/`PLUK_RATIONGUARD_BIN` must name a working
   command (default: the running executable).
4. A stale watcher from an earlier attach is killed automatically; a
   `could not kill stale ... watcher` warning is non-fatal.

## Recover

1. Install the missing piece (`npm install -g @hivecommons/pluk` or
   `@hivecommons/rationguard`) or fix the `--rationguard-bin` value, then
   re-run `attach`.
2. If the tmux session already existed with the wrong flags, restart the CLI
   with the command `attach` prints, or `tmux kill-session -t <session>` and
   attach again.
3. If the agent is already running unmonitored, start monitoring without
   restarting it: `rationguard watch <session>`.
4. Confirm with `rationguard sessions` that the session shows activity. If the
   onset coincides with an upgrade, follow `release-rollback.md`.
