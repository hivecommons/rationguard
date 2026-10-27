# Runbook: learned excuses or sightings disappeared

Use this when `rationguard sightings` or `rationguard list` suddenly shows far
fewer entries than before, or excuses you added no longer match. The store is
read leniently: an unreadable, truncated or wrong-shape file is treated as
empty with no error, so the loss is silent.

Related runbooks: `watch-session-degraded.md`, `postmortem-template.md`.

## Impact

Learned patterns stop matching and sighting counts restart from zero. Built-in
excuses are unaffected. The next recorded sighting rewrites the file from the
empty state, which makes the loss permanent unless a copy was kept.

## Detect

- `rationguard sightings --json` prints `[]` although sightings were recorded.
- `rationguard list` no longer includes entries you added.
- The files are `~/.rationguard/sightings.json` and
  `~/.rationguard/custom-excuses.json`. When no absolute home directory can be
  resolved, rationguard refuses to persist anything instead of falling back to
  the working directory, so `add` records nothing.
- Sighting counts stop growing although `check`/`watch` keep reporting
  detections. Auto-learning is best-effort: when the process cannot write to
  `~/.rationguard/` (permission denied, read-only filesystem, or the path is a
  file rather than a directory) `check` and `watch` skip recording the
  sighting silently and continue. Only `add` reports a write error.

## Diagnose

1. Stop long-running watchers for the affected user first. A running
   `watch`/`attach` can rewrite the file from its empty view.
2. Check the file exists and is valid JSON:

   ```sh
   ls -l ~/.rationguard/
   node -e 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"))' ~/.rationguard/sightings.json
   ```

3. Confirm the shape: a top-level object with a `sightings` array. Entries
   missing a required field, or with an unknown category, are dropped on load.
4. Confirm `HOME` is the expected absolute path in the process that runs
   rationguard (a different `HOME` in cron, a service unit or a container means
   a different, empty store).
5. Look for leftover `.<name>.<pid>.<timestamp>.tmp` files in the directory;
   they indicate a process was killed during a write. A
   `<name>.corrupt-<timestamp>.json` file is a store that could not be parsed
   and was moved aside.
6. If detections are reported but sightings stop accumulating, confirm the
   store is a directory the running user can write to:

   ```sh
   ls -ld ~/.rationguard
   test -d ~/.rationguard && test -w ~/.rationguard && echo writable || echo NOT writable
   ```

   A read-only HOME (e.g. a sandboxed hook or container), an `EACCES` from
   wrong ownership, or a plain file named `.rationguard` all make `check` and
   `watch` skip recording without any message.

## Recover

1. Restore the file from backup or snapshot if one exists, then restart the
   watchers.
2. If the file was invalid JSON or had the wrong shape, it is preserved
   automatically as `<name>.corrupt-<timestamp>.json` next to the store (a
   line on stderr names the path) and detection continues with an empty store.
   Repair or merge from that copy.
3. If no copy exists, re-add the important excuses with `rationguard add`.
   Sighting counts cannot be reconstructed.
4. If `HOME` was the cause, correct the environment of the service and restart.
5. If the store was not writable, fix ownership/permissions (or replace the
   stray file with a directory: `rm ~/.rationguard && mkdir ~/.rationguard`)
   and restart the watchers. Sightings skipped in the meantime are not
   recoverable.

## Clean up residue from the empty-key merge bug

Before #327 (commit `ecb2016`, 2026-10-22) the dedup key stripped every
character outside `a-z0-9` and whitespace, so any non-Latin or
punctuation-only excuse normalized to an empty key. Every such text therefore
matched the *first* entry of that kind ever recorded and bumped its counter
instead of getting its own entry. A store written by an earlier build may
still carry that one merged entry.

**Recognise the residue:**

- In `~/.rationguard/sightings.json`, the residue is a *single* entry whose
  `text` is non-Latin or punctuation-only (e.g. `'明天再做'` or `'!!!'`) with
  an implausibly high `count` for its `firstSeen`/`lastSeen` window and a
  `firstSeen` that predates the upgrade. Other non-Latin entries are
  legitimate: since the fix, each distinct excuse is stored under its own raw
  `text`, so they are expected to appear and must be kept.
- Detections have been count-only since #162 (`3d7cd7f`): they never set
  `promoted: true` or write to `custom-excuses.json`; only `rationguard add`
  promotes. The merged entry can be `promoted: true` only if the store
  predates #162, or if `rationguard add` was run three times
  (`AUTO_ADD_THRESHOLD`) with distinct empty-key texts. Otherwise skip the
  `custom-excuses.json` step below.

**Clean it up:**

1. Stop long-running watchers (same as "Diagnose" step 1) and back up
   `~/.rationguard/`.
2. Open `~/.rationguard/sightings.json` and delete only the one merged entry
   identified above. Do not delete other non-Latin or punctuation-only
   entries.
3. If that entry had `promoted: true`, open
   `~/.rationguard/custom-excuses.json` and delete the entry whose `pattern`
   matches its lowercased `text`. Leave every other entry in place.
4. Restart the watchers. Stored entries are never rewritten; from now on the
   lookup matches each excuse to its own entry, so new sightings accumulate
   correctly.

## Prevent

Back up `~/.rationguard/` with the rest of the user's configuration. If the
cause was a code defect rather than an environment problem, file an issue with
the steps and use `postmortem-template.md` if users were affected.
