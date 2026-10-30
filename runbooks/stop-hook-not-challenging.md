# Runbook: the `Stop` / `AfterAgent` hook never challenges a response

Use this when the hook from the README ("As a Claude Code `Stop` hook", "As a
Codex `Stop` or Gemini CLI `AfterAgent` hook") is installed but the agent is
never sent a rebuttal, even after an obvious excuse such as "too complex to fix
right now". For `rationguard watch` or `attach`, use
`watch-session-degraded.md` or `attach-startup-failing.md` instead.

Related runbooks: `learned-excuses-store.md`, `release-rollback.md`,
`postmortem-template.md`.

## Impact

The agent runs unchallenged. The script is written to fail open, so every
failure below exits 0 without output: nothing is blocked and nothing tells you
the guard is off. No data is lost.

## Detect

Feed the hook the payload by hand, from the project directory, and check the
exit code (2 means it would continue the agent):

```sh
echo '{"last_assistant_message":"This is too complex to fix right now"}' \
  | .claude/hooks/rationguard-stop.sh; echo "exit=$?"
```

Expect the rebuttal on stderr and `exit=2`. For Gemini use
`prompt_response` instead of `last_assistant_message`.

## Diagnose

Work down the list; the first failing step is the cause.

1. `command -v jq` — the script needs `jq`. Without it every `jq` call fails,
   `message` stays empty and the script exits 0.
2. `command -v rationguard` — the hook runs with the agent's `PATH`, not your
   interactive shell's. If the command is missing, `|| exit 0` swallows the
   error. Install it (`npm install -g @hivecommons/rationguard`) or call it by
   absolute path in the script.
3. `printf 'This is too complex to fix right now' | rationguard check --json`
   — must print matches. An error here (unknown flag, old version) is
   swallowed by the hook; compare `rationguard --help` with the flags in use.
4. Only matches with `confidence >= 0.7` and a `source` other than `project`
   are forwarded. A match that is low confidence, or comes from
   `./.rationguard/` in the checkout, is detected but deliberately not sent.
5. `stop_hook_active` is `true` on a turn the hook already continued, and the
   script skips it. Each response is challenged at most once.
6. The script is executable (`ls -l`), the registered path resolves, and for
   Codex the hook was reviewed and trusted with `/hooks` — an untrusted or
   changed hook is skipped.

## Recover

1. Fix the failing step above, then repeat the Detect command until it
   returns `exit=2`.
2. To make a failure visible instead of silent, change the `check` line to
   report on stderr and keep exiting 0 (never exit 2 on a tooling error, which
   would trap the agent in a loop):

   ```sh
   result=$(printf '%s' "$message" | rationguard check --json) || { echo "rationguard: check failed, response not challenged" >&2; exit 0; }
   ```

3. For a CI or pipeline gate rather than an agent hook, use
   `rationguard check --fail-on-match` (exit 2 on a match, 1 on a usage error)
   so a broken invocation is not mistaken for a clean result.
4. If the onset coincides with an upgrade, follow `release-rollback.md`.
