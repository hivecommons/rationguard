# Runbook: rolling back a bad rationguard release

`publish.yml` runs `npm test` against the tagged ref and then publishes to npm
on every `v*` tag push. Tests reduce risk but cannot catch every regression
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
2. **Do not `npm unpublish`** unless the version is less than 72 hours old and
   npm's unpublish policy allows it — unpublishing an older version can break
   other projects that already resolved to it. Prefer deprecate + forward fix.
3. If the bad version broke detection or rebuttal delivery for active hive
   sessions, tell operators to pin the last known-good version until a fix
   ships:
   ```sh
   npm install -g @hivecommons/rationguard@<last-good-version>
   ```

## Fix forward

1. Branch from `main`, fix the regression, and add a regression test per
   `CONTRIBUTING.md`.
2. Bump the version in `package.json` and land the fix through the normal PR
   process.
3. Tag `vX.Y.Z` on `main` once merged; `publish.yml` runs the test suite
   against that tag and publishes automatically.
4. Add a `changelog.d/fixed-<slug>.md` fragment describing the regression and
   the fix, following the existing entries in `changelog.d/`.

## After

- Confirm `npm view @hivecommons/rationguard@latest version` matches the new
  patched release.
- Confirm the deprecation notice on the bad version is still visible
  (`npm view @hivecommons/rationguard@<bad-version>` shows the `deprecated`
  field).
- Note the incident in the PR/issue that tracked the fix so future readers can
  find the rollback steps that were actually used.
