# Runbook: rolling back a bad rationguard release

Merging a version bump to `main` makes `auto-release.yml` create the `v<version>`
tag and dispatch `publish.yml` on it (a manual `v*` tag push also triggers
`publish.yml`). Publish verifies the tag matches `package.json`, is on `main`,
and has a nonempty `CHANGELOG.md` section, then runs lint, build and tests
before publishing to npm. Tests reduce risk but cannot catch every regression
(for example, a pattern-matching false positive/negative that only shows up
against real agent transcripts, a `pluk-send`/tmux interaction that only
breaks in a live session, or an environment-specific failure). This runbook
covers what to do once a bad version has already reached the npm registry.

## Who is affected

`rationguard` is consumed by:

- Anyone running `npm install -g @hivecommons/rationguard` directly.
- `rationguard attach`/`watch` sessions already running in hive hub/spoke
  agent pods — a broken release can stop rebuttals from being detected or
  sent without the running session visibly crashing.
- Anything scripting `rationguard watch --json` for automated excuse
  detection.

A broken publish can silently stop rationalization detection or rebuttal
delivery (agents keep "standing by" with no correction), so treat a bad
release as user-impacting, not just a packaging nit.

## Detect

- `npm view @hivecommons/rationguard versions --json` to confirm what
  shipped.
- `rationguard watch <session> --verbose` surfaces detection/flush activity
  in its debug log; an unexpectedly quiet log on a known-excuse-heavy session
  is a signal the matcher or sender regressed.
- Compare the published `dist/` behavior against the tagged source if the
  regression is not obvious from the changelog/diff.
- Check open issues/PRs for reports referencing the new version number.

## Contain

1. **Deprecate the bad version** so new installs warn instead of silently
   picking it up:
   ```sh
   npm deprecate @hivecommons/rationguard@<bad-version> "Known issue: <short description>, use <good-version> instead"
   ```
2. **Move `latest` back to the last known-good version.** `publish.yml` runs a
   plain `npm publish`, so the bad version is `latest` and a plain
   `npm install` still resolves to it until the tag moves (deprecation only
   adds a warning). Requires publish rights on the package:
   ```sh
   npm dist-tag add @hivecommons/rationguard@<last-good-version> latest
   ```
   Once the fix ships, the next publish moves `latest` forward again.
3. **Do not `npm unpublish`** unless the version is less than 72 hours old and
   npm's unpublish policy allows it — unpublishing an older version can break
   other projects that already resolved to it. Prefer deprecate + forward fix.
4. If the bad version broke detection or rebuttal delivery for active hive
   sessions, tell operators to pin the last known-good version until a fix
   ships:
   ```sh
   npm install -g @hivecommons/rationguard@<last-good-version>
   ```

## Fix forward

1. Branch from `main`, fix the regression, and add a regression test per
   `CONTRIBUTING.md`.
2. Bump the version in `package.json` and `package-lock.json`
   (`npm version <X.Y.Z> --no-git-tag-version`), and move the fix entry from
   `## Unreleased` into a nonempty `## X.Y.Z - YYYY-MM-DD` section of
   `CHANGELOG.md` (with a `### Fixed` entry describing the regression and the
   fix), in the same PR.
3. Merge through the normal PR process. `auto-release.yml` tags `vX.Y.Z` and
   dispatches `publish.yml`; do not tag by hand. An existing tag or an empty
   changelog section makes Auto Release a no-op, so the release would silently
   not happen.
4. If the tag was created but Publish did not run, do not delete or move the
   tag. Check `npm view @hivecommons/rationguard versions --json` first, then
   retry with `gh workflow run publish.yml --ref refs/tags/vX.Y.Z`.

## After

- Confirm `npm view @hivecommons/rationguard@latest version` matches the new
  patched release (or the last known-good version while a fix is pending).
- Confirm the deprecation notice on the bad version is still visible
  (`npm view @hivecommons/rationguard@<bad-version>` shows the `deprecated`
  field).
- Note the incident in the PR/issue that tracked the fix so future readers can
  find the rollback steps that were actually used.
