# Changelog

All notable changes to this project are documented in this file.

## Unreleased

### Fixed

- `watch` now handles SIGTERM and SIGHUP like SIGINT, so the pending output buffer is flushed and the `--diagnostics` final snapshot is written when pluk, systemd or tmux stop the watcher (#349)
- `cli`: unknown `--flags` (e.g. a typo'd `--fail-on-mtach`) are now rejected with an `Error:` line and exit 1 instead of being silently ignored, and `--help=x` is validated like the other boolean flags (#337)
- `cli`: boolean flags (`--fail-on-match`, `--json`, `--verbose`, …) now reject values other than `true`/`false` instead of silently treating them as false, and a bare `--file=` is reported as an input error instead of printing help with exit 0 (#337)
- `learner`: sighting dedup now normalizes text with Unicode-aware letter/number classes, so non-Latin excuses no longer collapse to an empty key and merge unrelated sightings into one counter (#327)
- `check()` via the library API no longer matches every input when an excuse has an empty or whitespace-only pattern (#324)
- `attach` now rejects an invalid session name with the same one-line error as `watch` instead of a stack trace (#319)
- Sightings and custom-excuse stores are updated under an inter-process lock so concurrent `check`/`watch`/`add` processes no longer lose sightings or drop a promoted excuse (#320)
- `check`/`add`: `-h` after `--` is now treated as literal text instead of triggering help, respecting the POSIX `--` end-of-options marker (#315)
- `check`/`add`: `parseFlags` now supports the POSIX `--` end-of-options marker, allowing positional text that starts with `--` to be passed to commands (e.g., `rationguard check -- "--no tests needed"`) instead of being parsed as a flag (#311)
- `add`: an unwritable `~/.rationguard` store made `recordSighting` throw and `add` crashed with a raw stack trace; it now prints a concise error and exits 1 (#309)
- `check`/`watch`: an unwritable `~/.rationguard` store (read-only HOME) made auto-learning throw, so `check` crashed with a stack trace and no detection output and `watch` died before emitting the detection or sending the rebuttal; learning is now best-effort (#306)
- `--help`/`-h` now print usage from any position, including after a subcommand, instead of being ignored or checked as text (#301)
- Clarify that `add`/`sightings` use the trusted per-user `~/.rationguard/` store, distinguish sighting records from promoted excuses, and document project-local excuses as read-only and untrusted (#292)
- `watch`: a subscriber `error` event (e.g. the pluk log never appearing within 60s) was only printed and the process exited 0; it now sets exit code 1 once the loop drains, and the message is sanitized for terminal output (#290)

## 0.13.0 - 2026-10-19

### Added

- `check --fail-on-match` exits 2 when any pattern matches so pipelines and hooks can gate on detections (#244)
- `check --log-format=json` and a library `onEvent` hook on `check()`: opt-in bounded match events (`event`, `category`, `confidence`, `matched` count only) for metrics wiring (#229)

### Fixed

- `learner`: the custom-excuses.json and sightings.json validators checked category membership with `in`, which also accepted `Object.prototype` keys such as `toString`/`__proto__`; they now require an own property of the category table, so such entries are dropped like any other unknown category (#287)
- `attach`: no longer fails with "rationguard not found on PATH" unless globally installed (npx, `node dist/cli.js`, project-local installs); it now launches the running rationguard by default, and `--rationguard-bin=<cmd>` / `PLUK_RATIONGUARD_BIN` are honoured and documented (#284)
- `watch --mode=watch`: an unknown `--cli` (e.g. a typo like `cluade`) or a `--patterns-dir` that is missing or whose `<cli>.patterns` file is absent, unreadable or defines no patterns used to run silently with no patterns; both are now rejected (no silent fallback to the bundled set) with exit 1 (#282)
- `watch --diagnostics=SECS`: a non-numeric or non-positive value (`abc`, `0`, `-5`, `5min`) used to silently run at the 60s default; it is now rejected with exit 1 (#277)
- `prompt --format`: now validated against `markdown|yaml` (`markdown` is the explicit default spelling); `--format=json`, `--format=YAML` or a bare `--format` used to silently emit markdown with exit 0 (#275)
- `add --rebuttal`/`--excuse`, `attach --cli`/`--dir`/`--command`/`--cli-args`, `watch --cli`/`--patterns-dir`: a bare flag is parsed as `"true"`; it is now rejected with the `--flag=<value>` hint instead of storing rebuttal `"true"` in the trusted store (auto-sent after three sightings) or passing it to the agent CLI (#268)
- `check --file` and `--run-dir` (`sessions`, `watch`, `attach`): a space-separated value (`--file notes.txt`) is parsed as the bare flag `"true"`; it is now rejected with the `--flag=PATH` hint instead of a misleading "File not found: true" or reading/listing a path named `true` (#266)
- `check --file`: an empty file (or `--file=`) no longer silently falls back to reading piped stdin, and an unreadable path such as a directory now exits 1 with a concise error instead of a stack trace
- `check`: positional text that starts with a single `-` (such as a Markdown bullet `- Nothing left to do`) was silently dropped by flag parsing, yielding "No input" or a missed detection; it is now kept as input
- Implicit `check` fallback (when no command is given): dash-led text like `rationguard "- all done"` is now treated as input for checking instead of printing help
- `watch`: reject invalid session names at startup, before reporting that monitoring has begun, so `--rebuttal=send` cannot crash on the first detection and subscribe mode shows a concise CLI error (#256)
- `watch --rebuttal=send`: the tmux `send-keys` fallback now targets the session by exact name (`-t =<session>:`) instead of a bare `-t <session>`, which tmux resolves by prefix/fnmatch, so a rebuttal and its Enter can no longer be typed into another session that merely shares a name prefix; session names may no longer contain `.` (tmux reads `a.b` as window.pane). Bumped `@hivecommons/pluk` to `^0.10.0`, whose `pluk-send` makes the same exact-target fix on the primary delivery path
- `learner`: strip contraction tails (`n't`, `'s`, `'re`, `'ll`, `'ve`, `'d`, `'m`) before the keyword stopword/length filter so `don't` / `that's` / `can't` no longer survive as promoted-excuse keywords and clear the auto-send threshold on benign text; `prompt`: collapse line breaks in excuse patterns/rebuttals so each one stays on a single Markdown table row (#240)
- `learner`: drop stopwords and trailing punctuation from promoted excuse keywords so benign text no longer clears the auto-send threshold (#236)
- `check`: stem text and keywords symmetrically (silent-e, doubled consonants, `ss` endings, short stems) so `idled`, `addressed`, `need approval`, `circled back`, `moving on`, `tabled this` match their keywords again; add `making progress` / `coming back to` keywords (#205)

### Changed

- `publish.yml`: publish to npm with Trusted Publishing (OIDC) and `--provenance` instead of a long-lived `NPM_TOKEN` secret (#252)
- `package.json`: list the supported agent CLIs and repo topics in npm `keywords` so the package is discoverable on npmjs.com (#259)
- Docs: add a Claude Code Stop-hook recipe for `rationguard check` (excluding project-local excuses like `watch --rebuttal=send` does) and document `watch --patterns-dir` (#249, #271, #243)
- `runbooks/watch-session-degraded.md`: note the pluk-send → tmux fallback log lines (#232)

## 0.12.0 - 2026-10-10

### Added

- `watch --log-format=json`: opt-in JSON line per rebuttal delivery (`event`, `session`, `delivery`, `timestamp`) on stderr (#217)
- `runbooks/learned-excuses-store.md`: recovery steps for a silently emptied sightings/custom-excuses store

### Fixed

- `watch`: always log the pluk-send → tmux fallback (not only with `--verbose`) and sanitize/truncate the pluk-send error text (#217)
- `help`: document `attach --cli-args`/`--run-dir` and `watch --patterns-dir`, and list `codex` for `watch --cli` (#215)
- `check --json`: record eligible sightings like plain-text `check` does (#210)
- `getAllExcuses`: skip the project custom-excuses load when cwd is `$HOME` so excuses are not loaded twice (#211)
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
