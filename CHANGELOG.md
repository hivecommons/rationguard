# Changelog

All notable changes to this project are documented in this file.

## Unreleased

### Added

- `runbooks/learned-excuses-store.md`: recovery steps for a silently emptied sightings/custom-excuses store

### Fixed

- `learner`: create `~/.rationguard/` and the sightings/custom-excuses files owner-only (0700/0600) instead of umask-default, so the trusted store is not readable or writable by other local accounts
- `check`/`watch`: apply the same word-boundary matching to exact excuse patterns, so a short pattern such as `later` no longer matches inside `belated` at 100% confidence (#207)
- `check`/`watch`: detect inflected deferral keywords (`deferred`, `deferring`, `postponed`, `postponing`) that the word-boundary matching from #199 stopped matching (#203)
- `check`/`list`/`sightings`/`sessions`/`watch --json`: escape DEL and C1 control code points (U+007F–U+009F, including the 8-bit CSI/OSC introducers) as `\uXXXX` in JSON output, which `JSON.stringify` otherwise emits raw; the output stays valid JSON and parses to the same value (#201)
- `check`/`watch`: match builtin keywords on word boundaries instead of raw substrings (e.g. `later` no longer hits `belated`), and drop the bare `awaiting` keyword whose reduced form `await` flagged JS/TS `await` in code (#199)
- `learner`: treat a wrong-shape sightings.json (`{}`, `[]`, `null`) as empty instead of crashing check/sightings/add/watch (#195)
- `watch --rebuttal=send`: no longer auto-sends rebuttals for matches below the 0.7 confidence threshold (e.g. single-keyword hits); they are still reported and counted as suppressed (#190)
- `check`/`watch`: fold curly apostrophes (U+2018/U+2019/U+02BC) and curly double quotes into ASCII before matching; the previous normalization was a no-op (#185)
- `watch`: run pattern matching on ANSI-stripped text so inline SGR codes no longer split phrases and hide detections (#186)
- `check`: read piped stdin to EOF instead of rejecting input that arrives more than 100 ms after start (#183)
- `watch`/`attach`: reject unknown `--mode` and `--rebuttal` values with exit 1 instead of silently running watch mode or never sending rebuttals (#176)
- `sightings --json` now prints `[]` instead of ANSI-colored prose when no sightings are recorded (#175)
- `check`/`watch`: single-keyword matches (45%) now render in the dim tier instead of yellow, making the previously unreachable dim branch of the confidence colouring live; the checker's `matched` flag is now a constant `true` for scored matches (#165)
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
