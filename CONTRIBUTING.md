# Contributing to rationguard

Thanks for helping improve rationguard. This project follows the Hive Commons contribution conventions used across the organization.

## Local setup

Prerequisites:

- Node.js 20 or newer
- npm

Install dependencies and build from source:

```bash
npm ci
npm run build
```

Run the standard checks before opening a PR:

```bash
npm run lint
npm run build
npm test
```

CI also enforces a coverage gate (99% lines / 95% branches / 100% functions)
on top of `npm test`. Check it locally before pushing:

```bash
npm run test:coverage
```

An advisory mutation-testing report (Stryker, configured in
`stryker.config.json`) shows which mutants the tests do not catch, which line
coverage alone cannot. It is report-only and never blocks CI. Run it locally with:

```bash
npm run test:mutation
npm run test:mutation:summary   # Markdown score + surviving mutants per file
```

The summary script (`.github/scripts/mutation-summary.cjs`) renders
`reports/mutation/mutation.json` as the job summary / sticky PR comment used by
the advisory mutation workflow, and always exits 0.

CI additionally runs a workflow regression suite (`.github/tests/*.test.cjs`)
that executes the real `run:` scripts from the release, publish, changelog-guard
and tarball-guard workflows against fixture repositories, and checks that every
workflow pins `uses:` to a commented commit SHA, declares a top-level
`permissions:` block and bounds runner jobs with `timeout-minutes`. It also
pins the issue forms under `.github/ISSUE_TEMPLATE/` to the CLI surface: the
subcommand and `--cli` dropdowns are checked against `src/cli.ts`, the excuse
category dropdown against `ExcuseCategory` in `src/types.ts`, and the linked
README headings against `README.md`. Every `rationguard <command> --flag`
shown in code in `README.md`, `CONTRIBUTING.md`, `SECURITY.md` and
`runbooks/*.md` is likewise checked against the subcommands `main()`
dispatches and the flags `src/cli.ts` reads, and the help text must list the
same flags. Run it whenever you touch anything under
`.github/`, the `files` field in `package.json`, the subcommands, flags or
`--cli` values in `src/cli.ts`, `ExcuseCategory` in `src/types.ts`, a README
heading, or a CLI invocation in the docs or runbooks:

```bash
npm run test:workflows
```

The package ships compiled files from `dist/`, but `dist/` is generated and intentionally not committed. `npm publish` runs `npm run build` through `prepublishOnly`.

## Releases

Prepare a release PR against `main` that bumps the version in both `package.json`
and `package-lock.json` (for example, `npm version 0.12.0 --no-git-tag-version`)
and moves the `## Unreleased` entries into a nonempty `## 0.12.0 - YYYY-MM-DD`
section in `CHANGELOG.md`, leaving an empty `## Unreleased` section for future changes.

On merge, Auto Release creates the missing `v<version>` tag at that commit and
explicitly dispatches Publish on the tag. An existing tag or a missing/empty
changelog section is a no-op. Publish checks the version, main ancestry and
changelog, then runs lint, build and tests before publishing to npm with provenance.
Manual `v*` tag pushes remain supported.

If tagging succeeds but dispatch fails, do not delete or move the tag: a maintainer
can retry with `gh workflow run publish.yml --ref refs/tags/v0.12.0`. Auto Release
skips existing tags, so rerunning it will not retry publishing. Before retrying a
failed Publish run, check whether npm already published that version; if so,
retry only the failed GitHub release job rather than republishing.

Publishing authenticates with [npm Trusted Publishing](https://docs.npmjs.com/trusted-publishers)
(OIDC) instead of a stored token: the `publish` job runs in the `npm` GitHub Environment with
`id-token: write`, upgrades npm to ≥ 11.5.1, and runs `npm publish --provenance --access public`
with no `NODE_AUTH_TOKEN`. The package on npmjs.com must have a Trusted Publisher configured for
GitHub Actions with organization `hivecommons`, repository `rationguard`, workflow `publish.yml`
and environment `npm` (equivalently: `npm trust github @hivecommons/rationguard --repo hivecommons/rationguard --file publish.yml --env npm --allow-publish`).
Do not add an `NPM_TOKEN`/`NODE_AUTH_TOKEN` to the publish job — npm rejects OIDC publishes when a
token is also present.

## Development notes

- Source lives under `src/` and is TypeScript ESM.
- Add or update tests for behavior changes. Tests compile to `dist/` and are discovered with `node --test dist/*.test.js`.
- Keep changes focused: security fixes, behavior changes, docs, and refactors should be separate PRs when practical.
- Do not commit secrets, local credentials, generated `dist/` output, or machine-specific files.

## Commits and DCO

All commits must be signed off for the Developer Certificate of Origin (DCO):

```bash
git commit -s
```

This adds a `Signed-off-by:` trailer confirming you have the right to contribute the work.

## Pull requests

Before submitting:

1. Rebase on the latest `main`.
2. Run `npm run lint`, `npm run build`, and `npm test` (and the coverage-gate
   command from "Local setup" if you touched code paths).
3. Use a clear PR title, preferably with the repository convention: ✨ feature, 🐛 bug fix, 📖 docs, 🌱 infra/tests, or ⚠️ breaking.
4. Link related issues with `Fixes #123` when the PR fully resolves them.

PRs that change shipped code (`src/**/*.ts` other than tests, or `dependencies` in `package.json`) must add a line under `## Unreleased` in `CHANGELOG.md`; CI fails otherwise. Maintainers can apply the `skip-changelog` label to opt a PR out.

Maintainers review PRs for correctness, tests, security impact, and compatibility with the CLI behavior documented in `README.md`.
