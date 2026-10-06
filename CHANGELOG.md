# Changelog

All notable changes to this project are documented in this file.

## Unreleased

### Fixed

- Detection-derived sightings (`check`, `watch`) are now count-only: they no longer auto-promote a matched builtin keyword such as `will` into the trusted `~/.rationguard/custom-excuses.json` as a `source: user` excuse whose rebuttal `watch --rebuttal=send` would then type into the agent on every flush. Only an explicit `rationguard add` promotes (#161)
- `watch --verbose`: route excuse patterns, rebuttals, and pluk state fields through `sanitizeForTerminal` before they reach the stderr log, so a project-local pattern can no longer inject OSC/CSI escape sequences into the operator's terminal (#127)
- Bump `@hivecommons/pluk` to `^0.9.0`: the bundled 0.8.6 `Subscriber` read zero bytes forever after `pluk watch` rotated the session log in place, silently stopping detection (#129)
- Sanitize and bound the `sendRebuttal` failure log line so an unbounded or escape-laden error message cannot flood or corrupt the terminal (#147)

## 0.11.0 - 2026-10-02

### Added

- Cover cli branch gaps: attach --cli/--rebuttal defaults, sessions PLUK_RUN_DIR fallback and state/tmux rendering, promoted sightings display
- Test coverage for the CLI stdin-TTY guard and watch-mode error forwarding
- Test the watcher raw_output path when a pluk event carries no `line`, so the empty-string fallback is covered.

### Fixed

- Reject an unknown `--category` in `rationguard add` up front instead of crashing on the third sighting and persisting a rebuttal-less excuse that is then silently dropped
- Ignore excuse keywords that reduce to nothing but filler words (`will`, `just`, `should`, …) in the checker; such a keyword matched every input, so an auto-promoted "will address" sighting flagged all output as Deferral
- Exclude compiled test artifacts (`dist/*.test.js`, `.js.map`, `.d.ts`) from the published npm tarball via `files` negation globs in `package.json`, and add a CI guard that fails the build if a `.test.` file ever reappears in `npm pack --dry-run` output.
- Resolve the `pluk-send` binary from the pinned `@hivecommons/pluk` dependency instead of a bare PATH lookup, closing a version-skew gap between the imported library and the shelled-out binary
- Extract the auto-learning eligibility gate (confidence threshold + project-source exclusion) duplicated in `cli.ts` and `watcher.ts` into a single `recordSightingIfEligible` helper in `learner.ts`
- `watch --rebuttal=send`: the tmux `send-keys` fallback now passes `--` before the rebuttal text, so a rebuttal beginning with `-` is typed literally instead of being parsed as send-keys flags.
- Keep `watch --json` stdout parseable as JSON Lines by routing the startup banner and shutdown line to stderr
