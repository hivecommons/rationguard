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
   they indicate a process was killed during a write.
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
2. If the file is invalid JSON, fix it by hand and keep a copy before the next
   `add`, `check` or `watch` run records a sighting.
3. If no copy exists, re-add the important excuses with `rationguard add`.
   Sighting counts cannot be reconstructed.
4. If `HOME` was the cause, correct the environment of the service and restart.
5. If the store was not writable, fix ownership/permissions (or replace the
   stray file with a directory: `rm ~/.rationguard && mkdir ~/.rationguard`)
   and restart the watchers. Sightings skipped in the meantime are not
   recoverable.

## Clean up residue from the empty-key merge bug

If a store was affected by the bug fixed in PR #327 (before October 2024) where
non-Latin excuse text normalized to an empty dedup key, it retains merged
sighting counters and possibly a wrongly promoted excuse.

**Recognise the residue:**

- In `~/.rationguard/sightings.json`, look for entries whose `text` is
  non-Latin characters (e.g. `'明天再做'`, `'已经完成了'`) or punctuation-only
  (e.g. `'!!!'`). These should not normally appear after the fix.
- Such entries have `"promoted": true` if their `count` reached 3 (AUTO_ADD_THRESHOLD) before
  the fix landed.
- In `~/.rationguard/custom-excuses.json`, find entries promoted by these merged
  counters; they have low-quality `pattern` fields derived from the first
  sighting text rather than user intent.

**Clean it up:**

1. Stop long-running watchers (same as "Diagnose" step 1).
2. Remove the merged sighting entries by opening `~/.rationguard/sightings.json`
   and deleting entries with non-Latin or punctuation-only `text`.
3. Check `~/.rationguard/custom-excuses.json`: if it contains entries with
   low-quality patterns (e.g. `"pattern": "!!!"` or non-Latin text), delete
   them. You can safely remove any entry you do not recognize or explicitly
   added.
4. Restart the watchers. `recordSighting` re-keys all sightings correctly on
   the next detection, so new non-Latin excuses will accumulate under the
   correct entry.

## Prevent

Back up `~/.rationguard/` with the rest of the user's configuration. If the
cause was a code defect rather than an environment problem, file an issue with
the steps and use `postmortem-template.md` if users were affected.
