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

## Recover

1. Restore the file from backup or snapshot if one exists, then restart the
   watchers.
2. If the file is invalid JSON, fix it by hand and keep a copy before the next
   `add`, `check` or `watch` run records a sighting.
3. If no copy exists, re-add the important excuses with `rationguard add`.
   Sighting counts cannot be reconstructed.
4. If `HOME` was the cause, correct the environment of the service and restart.

## Prevent

Back up `~/.rationguard/` with the rest of the user's configuration. If the
cause was a code defect rather than an environment problem, file an issue with
the steps and use `postmortem-template.md` if users were affected.
