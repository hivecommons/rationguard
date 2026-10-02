# Changelog

All notable changes to this project are documented in this file.

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
