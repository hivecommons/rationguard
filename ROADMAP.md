# rationguard Roadmap

rationguard is pre-1.0 (see [CHANGELOG.md](CHANGELOG.md) for the current version). This page states what a 1.0 would require, which AI CLIs are supported at which level, and how detection patterns are contributed. It sets no dates; the criteria below are a proposed bar, not a commitment.

---

## 1.0 exit criteria

Proposed, in verifiable terms. Items marked *enforced today* are already CI gates.

- **Tests and types**: `npm run lint`, `npm run build` and `npm test` pass on every PR (*enforced today*).
- **Coverage gate**: `npm run test:coverage` holds at 99% lines / 95% branches / 100% functions (*enforced today*).
- **Workflow and docs regression suite**: `npm run test:workflows` passes, which pins the README, runbooks and issue forms to the CLI surface in `src/cli.ts` (*enforced today*).
- **Mutation score**: the Stryker run (`npm run test:mutation`, `stryker.config.json`) is advisory today (`thresholds.break` is `null`). Proposed: agree a score floor, turn it into a gate, and hold it across several consecutive releases before 1.0.
- **CLI coverage**: every CLI listed as first-class in the matrix below has an end-to-end test or fixture in CI, not only a mention in the help text.
- **Stable surface**: the subcommands, flags and `--cli` values in `src/cli.ts`, the exports of the package entry (`src/index.ts`) and the on-disk store formats under `~/.rationguard` are documented and only change in a breaking way with a major version bump.
- **Release hygiene**: every release goes through the Auto Release / Publish workflows with a nonempty `CHANGELOG.md` section and npm provenance.
- **Open correctness issues**: no open issue labelled as a detection false-negative or data-loss bug in the trusted store.

---

## Supported-CLI matrix

The five values accepted by `--cli` are `claude`, `copilot`, `gemini`, `goose` and `codex`. Support levels are derived from what the repository tests or documents today:

| CLI | Level | Evidence |
|-----|-------|----------|
| `claude` | First-class | Default for `--cli`; `--dangerous` maps to `--dangerously-skip-permissions`; the README documents a Claude Code `Stop` hook for post-response detection |
| `codex` | Best-effort | `--dangerous` maps to `--full-auto`; no CLI-specific test or fixture |
| `goose` | Best-effort | `--dangerous` maps to `--non-interactive`; one `src/cli.test.ts` case uses `goose` only as a label in a pluk event fixture |
| `copilot` | Best-effort | Accepted by `--cli`; `--dangerous` is a no-op (pass the CLI's own option via `--cli-args`); only test asserts `--cli=copilot` is accepted without an "--cli is ignored" warning in the default subscribe mode |
| `gemini` | Best-effort | Accepted by `--cli`; `--dangerous` is a no-op; no CLI-specific test or fixture |

Levels meaning:

- **First-class**: documented end to end, and regressions are expected to be caught by CI.
- **Best-effort**: listed and passed through to pluk's CLI patterns, but not independently verified here. Bug reports are welcome; fixes are reviewed like any other PR.

Promoting a CLI to first-class means adding CI-run tests or fixtures for it (attach, `--dangerous` behaviour, watch-mode detection) and updating this table in the same PR.

---

## Detection-pattern contribution policy

Excuse detection is driven by the default excuses in `src/defaults.ts` (pattern, category, keywords, rebuttal), assembled with user and project-local excuses in `src/excuses.ts`. Per-CLI terminal patterns used by `watch` come from [pluk](https://www.npmjs.com/package/@hivecommons/pluk) and can be overridden with `--patterns-dir`; changes to those belong upstream.

To propose a new default excuse:

1. Open an [excuse pattern report](https://github.com/hivecommons/rationguard/issues/new?template=excuse_pattern.yml) with real observed text, so every pattern is empirical.
2. Pick one of the existing `ExcuseCategory` values in `src/types.ts`; a new category is a breaking surface change and needs maintainer agreement first.
3. Add the entry to `src/defaults.ts` and tests in `src/checker.test.ts` covering both a text that must match and a near-miss that must not.
4. Run `npm run lint`, `npm run build`, `npm test` and `npm run test:coverage`.
5. Run `npm run test:workflows` if you touched docs, the CLI surface or anything under `.github/`.
6. Optionally run `npm run test:mutation` and `npm run test:mutation:summary` and look at surviving mutants in the files you changed. This is advisory until the mutation score becomes a gate.
7. Add a line under `## Unreleased` in `CHANGELOG.md`, and sign off your commits (`git commit -s`).

Project-local excuses (`./.rationguard/custom-excuses.json`) are untrusted: they may be detected, but their rebuttals are never auto-sent. Contributions must not weaken that.

---

## Non-goals

- Replacing an AI CLI's own permission or sandbox model; `--dangerous` only forwards a CLI's existing flag.
- Judging code quality or correctness of an agent's work; rationguard detects rationalizing language only.
- Acting as a security boundary against a malicious agent or repository.
- Supporting CLIs beyond the five above through built-in code; other CLIs can use `--command` wrappers.
- Machine-learned or remote-service detection; patterns stay local, inspectable keyword and pattern rules.
