import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { recordSighting, recordSightingIfEligible, loadCustomExcuses, listSightings, withStoreLock, reclaimStaleLock, AUTO_LEARN_CONFIDENCE_THRESHOLD } from './learner.js';
import { check } from './checker.js';
import type { Excuse, MatchResult } from './types.js';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rationguard-learner-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('recordSighting', () => {
  it('records a new sighting with count 1', () => {
    const res = recordSighting('I will handle this later', undefined, undefined, dir);
    assert.strictEqual(res.isNew, true);
    assert.strictEqual(res.count, 1);
    assert.strictEqual(res.autoPromoted, false);
    assert.strictEqual(res.excuse, null);
  });

  it('persists sightings to <projectDir>/.rationguard/sightings.json', () => {
    recordSighting('waiting for approval', undefined, undefined, dir);
    const raw = fs.readFileSync(path.join(dir, '.rationguard', 'sightings.json'), 'utf-8');
    const store = JSON.parse(raw);
    assert.strictEqual(store.sightings.length, 1);
    assert.strictEqual(store.sightings[0].text, 'waiting for approval');
  });

  it('deduplicates by normalized text (case, punctuation, whitespace)', () => {
    recordSighting('Standing by, for now!', undefined, undefined, dir);
    const res = recordSighting('standing   by for now', undefined, undefined, dir);
    assert.strictEqual(res.isNew, false);
    assert.strictEqual(res.count, 2);
    assert.strictEqual(listSightings(dir).length, 1);
  });

  it('treats different text as a separate sighting', () => {
    recordSighting('too complex to fix', undefined, undefined, dir);
    const res = recordSighting('deferring to next sprint', undefined, undefined, dir);
    assert.strictEqual(res.isNew, true);
    assert.strictEqual(listSightings(dir).length, 2);
  });

  it('updates category and rebuttal on repeat sightings when provided', () => {
    recordSighting('some phrase here', 'deferral', undefined, dir);
    recordSighting('some phrase here', 'lane-confusion', 'custom rebuttal', dir);
    const [s] = listSightings(dir);
    assert.strictEqual(s.suggestedCategory, 'lane-confusion');
    assert.strictEqual(s.suggestedRebuttal, 'custom rebuttal');
  });

  it('auto-promotes to a custom excuse on the third sighting', () => {
    recordSighting('circling back on this soon', undefined, undefined, dir);
    recordSighting('circling back on this soon', undefined, undefined, dir);
    const res = recordSighting('circling back on this soon', undefined, undefined, dir);
    assert.strictEqual(res.count, 3);
    assert.strictEqual(res.autoPromoted, true);
    assert.ok(res.excuse);
    assert.strictEqual(res.excuse.pattern, 'circling back on this soon');

    const custom = loadCustomExcuses(dir);
    assert.strictEqual(custom.length, 1);
    assert.strictEqual(custom[0].pattern, 'circling back on this soon');
  });

  it('promote: false counts the sighting but never writes custom-excuses.json', () => {
    let res = { count: 0, autoPromoted: false, excuse: null as unknown };
    for (let i = 0; i < 4; i++) {
      res = recordSighting('will', 'deferral', undefined, dir, { promote: false });
    }
    assert.strictEqual(res.count, 4);
    assert.strictEqual(res.autoPromoted, false);
    assert.strictEqual(res.excuse, null);
    assert.strictEqual(loadCustomExcuses(dir).length, 0);
    assert.ok(!fs.existsSync(path.join(dir, '.rationguard', 'custom-excuses.json')));
    const [s] = listSightings(dir);
    assert.strictEqual(s.count, 4);
    assert.strictEqual(s.promoted, false);
  });

  it('an explicit (promote: true) sighting still promotes once the threshold is reached', () => {
    for (let i = 0; i < 3; i++) recordSighting('will', 'deferral', undefined, dir, { promote: false });
    const res = recordSighting('will', 'deferral', undefined, dir);
    assert.strictEqual(res.autoPromoted, true);
    assert.strictEqual(loadCustomExcuses(dir).length, 1);
  });

  it('does not promote the same sighting twice', () => {
    for (let i = 0; i < 3; i++) recordSighting('promoted once only', undefined, undefined, dir);
    const res = recordSighting('promoted once only', undefined, undefined, dir);
    assert.strictEqual(res.count, 4);
    assert.strictEqual(res.autoPromoted, false);
    assert.strictEqual(loadCustomExcuses(dir).length, 1);
  });

  it('promoted excuse keywords are lowercase words longer than 3 chars, max 5', () => {
    for (let i = 0; i < 3; i++) {
      recordSighting('The Extremely Complicated Refactoring Cannot Proceed Without Further Explicit Approval', undefined, undefined, dir);
    }
    const [excuse] = loadCustomExcuses(dir) as Excuse[];
    assert.strictEqual(excuse.keywords.length, 5);
    for (const kw of excuse.keywords) {
      assert.ok(kw.length > 3, `keyword too short: ${kw}`);
      assert.strictEqual(kw, kw.toLowerCase());
    }
  });

  it('promoted excuse keywords exclude stopwords and trailing punctuation', () => {
    for (let i = 0; i < 3; i++) {
      recordSighting('I think that this works with what they have, honestly.', undefined, undefined, dir);
    }
    const [excuse] = loadCustomExcuses(dir) as Excuse[];
    assert.deepStrictEqual(excuse.keywords, ['think', 'works', 'honestly']);
  });

  it('promoted excuse keywords exclude contractions', () => {
    for (let i = 0; i < 3; i++) {
      recordSighting("I don't think that's something we can't handle later", undefined, undefined, dir);
    }
    const [excuse] = loadCustomExcuses(dir) as Excuse[];
    assert.deepStrictEqual(excuse.keywords, ['think', 'something', 'handle', 'later']);
    const result = check("I don't know yet, that's fine, we can't ship until the fix lands.", { excuses: [excuse] });
    assert.ok(result.matches.every(m => m.confidence < AUTO_LEARN_CONFIDENCE_THRESHOLD));
  });

  it('promoted excuse keywords strip curly-apostrophe contraction tails too', () => {
    for (let i = 0; i < 3; i++) {
      recordSighting('We\u2019ll circle back because it\u2019s blocked and they\u2019re busy', undefined, undefined, dir);
    }
    const [excuse] = loadCustomExcuses(dir) as Excuse[];
    assert.deepStrictEqual(excuse.keywords, ['circle', 'back', 'blocked', 'busy']);
  });

  it('a promoted stopword-heavy excuse does not flag benign text', () => {
    for (let i = 0; i < 3; i++) {
      recordSighting('I think that this works with what they have', undefined, undefined, dir);
    }
    const result = check('Note that this file ships with the release.', { excuses: loadCustomExcuses(dir) });
    assert.ok(result.matches.every(m => m.confidence < AUTO_LEARN_CONFIDENCE_THRESHOLD));
  });

  it('a promoted all-stopword excuse has no keywords and matches only its exact pattern', () => {
    for (let i = 0; i < 3; i++) {
      recordSighting('That is what this was', undefined, undefined, dir);
    }
    const excuses = loadCustomExcuses(dir) as Excuse[];
    assert.strictEqual(excuses.length, 1);
    assert.deepStrictEqual(excuses[0].keywords, []);

    const unrelated = check('Unrelated status text with none of those words.', { excuses });
    assert.strictEqual(unrelated.matches.length, 0);

    const exact = check('Well, that is what this was.', { excuses });
    assert.strictEqual(exact.matches.length, 1);
    assert.strictEqual(exact.matches[0].confidence, 1);
    assert.strictEqual(exact.matches[0].matchedText, 'that is what this was');
  });

  it('guesses a category from signal words when none is given', () => {
    recordSighting('this is too complex and difficult, cannot proceed', undefined, undefined, dir);
    const [s] = listSightings(dir);
    assert.strictEqual(s.suggestedCategory, 'complexity-dodge');
  });

  it('defaults the guessed category to deferral when no signals match', () => {
    recordSighting('zzz qqq xyzzy', undefined, undefined, dir);
    const [s] = listSightings(dir);
    assert.strictEqual(s.suggestedCategory, 'deferral');
  });

  it('generates a rebuttal matching the guessed category', () => {
    recordSighting('not my job, another agent owns it', undefined, undefined, dir);
    const [s] = listSightings(dir);
    assert.strictEqual(s.suggestedCategory, 'lane-confusion');
    assert.ok(s.suggestedRebuttal.length > 0);
  });

  it('respects an explicit rebuttal on a new sighting', () => {
    recordSighting('bespoke excuse', 'deferral', 'my rebuttal', dir);
    const [s] = listSightings(dir);
    assert.strictEqual(s.suggestedRebuttal, 'my rebuttal');
  });
});

describe('atomic store writes', () => {
  it('leaves no leftover temp files after writing sightings.json', () => {
    recordSighting('leftover tmp check', undefined, undefined, dir);
    const base = path.join(dir, '.rationguard');
    const entries = fs.readdirSync(base);
    assert.deepStrictEqual(entries, ['sightings.json']);
  });

  it('leaves no leftover temp files after writing custom-excuses.json', () => {
    for (let i = 0; i < 3; i++) recordSighting('promote me please now', undefined, undefined, dir);
    const base = path.join(dir, '.rationguard');
    const entries = fs.readdirSync(base).sort();
    assert.deepStrictEqual(entries, ['custom-excuses.json', 'sightings.json']);
  });

  it('creates the store directory 0700 and files 0600 regardless of umask', { skip: process.platform === 'win32' }, () => {
    const prevUmask = process.umask(0o000);
    try {
      for (let i = 0; i < 3; i++) recordSighting('umask check promote now', undefined, undefined, dir);
    } finally {
      process.umask(prevUmask);
    }
    const base = path.join(dir, '.rationguard');
    assert.strictEqual(fs.statSync(base).mode & 0o777, 0o700);
    assert.strictEqual(fs.statSync(path.join(base, 'sightings.json')).mode & 0o777, 0o600);
    assert.strictEqual(fs.statSync(path.join(base, 'custom-excuses.json')).mode & 0o777, 0o600);
  });
});

describe('store lock', () => {
  const LEARNER_URL = new URL('./learner.js', import.meta.url).href;
  const storeDir = () => path.join(dir, '.rationguard');
  const lockPath = () => path.join(storeDir(), '.sightings.lock');

  it('holds the lock (owned by this pid) while fn runs and releases it afterwards', () => {
    const res = withStoreLock(storeDir(), () => {
      assert.strictEqual(fs.readFileSync(lockPath(), 'utf-8'), String(process.pid));
      return 42;
    });
    assert.strictEqual(res, 42);
    assert.ok(!fs.existsSync(lockPath()));
  });

  it('is re-entrant within a process and keeps the outer lock until the outer call ends', () => {
    const res = withStoreLock(storeDir(), () => {
      const inner = withStoreLock(storeDir(), () => 'inner', { maxWaitMs: 0 });
      assert.ok(fs.existsSync(lockPath()), 'nested release must not drop the outer lock');
      return inner;
    });
    assert.strictEqual(res, 'inner');
    assert.ok(!fs.existsSync(lockPath()));
  });

  it('releases the lock and propagates the error when fn throws', () => {
    assert.throws(() => withStoreLock(storeDir(), () => { throw new Error('boom'); }), /boom/);
    assert.ok(!fs.existsSync(lockPath()));
    assert.strictEqual(withStoreLock(storeDir(), () => 'again'), 'again');
  });

  it('waits for a lock held by another process and acquires it once released', async () => {
    fs.mkdirSync(storeDir(), { recursive: true });
    fs.writeFileSync(lockPath(), '999999');
    const holder = spawn(process.execPath, ['-e', 'setTimeout(() => require("fs").rmSync(process.argv[1]), 150)', lockPath()], { stdio: 'ignore' });
    const exited = once(holder, 'exit');
    const owner = withStoreLock(storeDir(), () => fs.readFileSync(lockPath(), 'utf-8'), { maxWaitMs: 10_000 });
    assert.strictEqual(owner, String(process.pid));
    assert.ok(!fs.existsSync(lockPath()));
    await exited;
  });

  it('runs fn unlocked after maxWaitMs without removing a live lock it does not own', () => {
    fs.mkdirSync(storeDir(), { recursive: true });
    fs.writeFileSync(lockPath(), 'other');
    assert.strictEqual(withStoreLock(storeDir(), () => 'ran', { maxWaitMs: 30 }), 'ran');
    assert.strictEqual(fs.readFileSync(lockPath(), 'utf-8'), 'other');
  });

  it('reclaims a stale lock left by a crashed process', () => {
    fs.mkdirSync(storeDir(), { recursive: true });
    fs.writeFileSync(lockPath(), '999999');
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(lockPath(), old, old);
    const res = recordSighting('stale lock sighting', undefined, undefined, dir);
    assert.strictEqual(res.count, 1);
    assert.ok(!fs.existsSync(lockPath()));
    assert.deepStrictEqual(fs.readdirSync(storeDir()), ['sightings.json']);
  });

  it('is re-entrant per store dir: a nested call for a different dir takes its own lock', () => {
    const otherDir = path.join(dir, 'other');
    const otherLock = path.join(otherDir, '.sightings.lock');
    withStoreLock(storeDir(), () => {
      withStoreLock(otherDir, () => {
        assert.strictEqual(fs.readFileSync(otherLock, 'utf-8'), String(process.pid));
        assert.strictEqual(fs.readFileSync(lockPath(), 'utf-8'), String(process.pid));
      });
      assert.ok(!fs.existsSync(otherLock), 'inner lock for the other dir must be released');
      assert.ok(fs.existsSync(lockPath()), 'outer lock must survive the inner release');
    });
    assert.ok(!fs.existsSync(lockPath()));
  });

  it('reclaimStaleLock: leaves a fresh lock alone and removes a stale one exactly once', () => {
    fs.mkdirSync(storeDir(), { recursive: true });
    fs.writeFileSync(lockPath(), 'fresh');
    assert.strictEqual(reclaimStaleLock(lockPath(), 10_000), false);
    assert.strictEqual(fs.readFileSync(lockPath(), 'utf-8'), 'fresh');
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(lockPath(), old, old);
    assert.strictEqual(reclaimStaleLock(lockPath(), 10_000), true);
    assert.ok(!fs.existsSync(lockPath()));
    assert.strictEqual(reclaimStaleLock(lockPath(), 10_000), false, 'nothing left to reclaim');
    assert.deepStrictEqual(fs.readdirSync(storeDir()), [], 'no reclaim temp file left behind');
  });

  it('reclaimStaleLock: restores a live lock that replaced the stale one after the stat', () => {
    fs.mkdirSync(storeDir(), { recursive: true });
    fs.writeFileSync(lockPath(), 'stale');
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(lockPath(), old, old);
    // Between our stat and rename another waiter reclaims the stale lock and creates its own.
    const realStat = fs.statSync;
    let swapped = false;
    const statSpy = ((p: fs.PathLike, o?: unknown) => {
      const st = realStat(p, o as never);
      if (!swapped && p === lockPath()) {
        swapped = true;
        fs.rmSync(lockPath());
        fs.writeFileSync(lockPath(), 'live', { flag: 'wx' });
      }
      return st;
    }) as typeof fs.statSync;
    (fs as { statSync: typeof fs.statSync }).statSync = statSpy;
    try {
      assert.strictEqual(reclaimStaleLock(lockPath(), 10_000), false);
    } finally {
      (fs as { statSync: typeof fs.statSync }).statSync = realStat;
    }
    assert.strictEqual(fs.readFileSync(lockPath(), 'utf-8'), 'live', 'the live lock must be put back');
    assert.deepStrictEqual(fs.readdirSync(storeDir()), ['.sightings.lock']);
  });

  it('reclaimStaleLock: returns false without throwing when the stale lock vanishes between stat and rename', () => {
    fs.mkdirSync(storeDir(), { recursive: true });
    fs.writeFileSync(lockPath(), 'stale');
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(lockPath(), old, old);
    // Another waiter reclaims (or the holder releases) the lock right after our stat.
    const realStat = fs.statSync;
    let removed = false;
    const statSpy = ((p: fs.PathLike, o?: unknown) => {
      const st = realStat(p, o as never);
      if (!removed && p === lockPath()) {
        removed = true;
        fs.rmSync(lockPath());
      }
      return st;
    }) as typeof fs.statSync;
    (fs as { statSync: typeof fs.statSync }).statSync = statSpy;
    try {
      assert.strictEqual(reclaimStaleLock(lockPath(), 10_000), false);
    } finally {
      (fs as { statSync: typeof fs.statSync }).statSync = realStat;
    }
    assert.ok(removed, 'the lock must have been stat-ed before the rename');
    assert.deepStrictEqual(fs.readdirSync(storeDir()), [], 'no reclaim temp file left behind');
  });

  it('reclaimStaleLock: drops its reclaim file instead of orphaning it when a live lock cannot be put back', () => {
    fs.mkdirSync(storeDir(), { recursive: true });
    fs.writeFileSync(lockPath(), 'stale');
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(lockPath(), old, old);
    const realStat = fs.statSync;
    const realRename = fs.renameSync;
    let swapped = false;
    let renames = 0;
    const statSpy = ((p: fs.PathLike, o?: unknown) => {
      const st = realStat(p, o as never);
      if (!swapped && p === lockPath()) {
        swapped = true;
        fs.rmSync(lockPath());
        fs.writeFileSync(lockPath(), 'live', { flag: 'wx' });
      }
      return st;
    }) as typeof fs.statSync;
    // The first rename (move aside) succeeds; the restore rename fails as if the
    // store directory became unwritable in between.
    const renameSpy = ((from: fs.PathLike, to: fs.PathLike) => {
      renames += 1;
      if (renames === 2) throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
      return realRename(from, to);
    }) as typeof fs.renameSync;
    (fs as { statSync: typeof fs.statSync }).statSync = statSpy;
    (fs as { renameSync: typeof fs.renameSync }).renameSync = renameSpy;
    try {
      assert.strictEqual(reclaimStaleLock(lockPath(), 10_000), false);
    } finally {
      (fs as { statSync: typeof fs.statSync }).statSync = realStat;
      (fs as { renameSync: typeof fs.renameSync }).renameSync = realRename;
    }
    assert.strictEqual(renames, 2, 'the restore rename must have been attempted');
    assert.ok(
      !fs.readdirSync(storeDir()).some((f) => f.includes('.reclaim.')),
      'a per-pid reclaim file must never be left behind to block later reclaims',
    );
  });

  it('reclaimStaleLock: only one of several concurrent waiters removes a stale lock', async () => {
    fs.mkdirSync(storeDir(), { recursive: true });
    fs.writeFileSync(lockPath(), '999999');
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(lockPath(), old, old);
    const script = `const { reclaimStaleLock } = await import(${JSON.stringify(LEARNER_URL)});
process.exit(reclaimStaleLock(process.argv[1], 10_000) ? 10 : 0);`;
    const children = Array.from({ length: 6 }, () => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', script, lockPath()], { stdio: ['ignore', 'ignore', 'inherit'] });
      return once(child, 'exit').then(([code]) => code);
    });
    const codes = await Promise.all(children);
    assert.strictEqual(codes.filter((c) => c === 10).length, 1, `exactly one reclaimer, got ${codes}`);
    assert.ok(codes.every((c) => c === 10 || c === 0));
    assert.deepStrictEqual(fs.readdirSync(storeDir()), []);
  });

  it('runs fn unlocked when the lock cannot be created (unwritable store path)', () => {
    fs.writeFileSync(storeDir(), 'not a directory');
    assert.strictEqual(withStoreLock(storeDir(), () => 'unlocked'), 'unlocked');
    assert.throws(() => recordSighting('unwritable store', undefined, undefined, dir));
  });

  it('serializes concurrent processes: no lost sightings and exactly one promotion', async () => {
    const procs = 6;
    const perProc = 5;
    const script = `const { recordSighting } = await import(${JSON.stringify(LEARNER_URL)});
for (let i = 0; i < ${perProc}; i++) recordSighting('race excuse', 'deferral', 'act now', process.argv[1]);`;
    const children = Array.from({ length: procs }, () => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', script, dir], { stdio: ['ignore', 'ignore', 'inherit'] });
      return once(child, 'exit').then(([code]) => code);
    });
    assert.deepStrictEqual(await Promise.all(children), Array(procs).fill(0));
    const [s] = listSightings(dir);
    assert.strictEqual(s.count, procs * perProc);
    assert.strictEqual(s.promoted, true);
    const custom = loadCustomExcuses(dir);
    assert.strictEqual(custom.length, 1);
    assert.strictEqual(custom[0].pattern, 'race excuse');
    assert.ok(!fs.existsSync(lockPath()));
  });
});

describe('loadCustomExcuses', () => {
  it('returns an empty array when the file does not exist', () => {
    assert.deepStrictEqual(loadCustomExcuses(dir), []);
  });

  it('returns an empty array when the file is corrupt JSON', () => {
    const base = path.join(dir, '.rationguard');
    fs.mkdirSync(base, { recursive: true });
    fs.writeFileSync(path.join(base, 'custom-excuses.json'), '{not json');
    assert.deepStrictEqual(loadCustomExcuses(dir), []);
  });

  it('returns an empty array when the JSON is not an array', () => {
    const base = path.join(dir, '.rationguard');
    fs.mkdirSync(base, { recursive: true });
    fs.writeFileSync(path.join(base, 'custom-excuses.json'), '{"not":"array"}');
    assert.deepStrictEqual(loadCustomExcuses(dir), []);
  });

  it('drops entries with the wrong shape and keeps valid ones', () => {
    const base = path.join(dir, '.rationguard');
    fs.mkdirSync(base, { recursive: true });
    const valid: Excuse = {
      pattern: 'i will get to it later',
      rebuttal: 'Act now.',
      category: 'deferral',
      keywords: ['later'],
    };
    const entries = [
      valid,
      { pattern: 42 },
      { pattern: 'x', rebuttal: 'y', category: 'not-a-category', keywords: [] },
      { pattern: 'x', rebuttal: 'y', category: 'deferral', keywords: ['a', 7] },
      { pattern: '   ', rebuttal: 'y', category: 'deferral', keywords: [] },
      null,
      'just a string',
      ['nested'],
    ];
    fs.writeFileSync(path.join(base, 'custom-excuses.json'), JSON.stringify(entries));
    assert.deepStrictEqual(loadCustomExcuses(dir), [valid]);
  });

  it('drops entries with prototype keys as category (toString, __proto__) and keeps valid ones', () => {
    const base = path.join(dir, '.rationguard');
    fs.mkdirSync(base, { recursive: true });
    const valid: Excuse = {
      pattern: 'this is valid',
      rebuttal: 'Do better.',
      category: 'deferral',
      keywords: ['valid'],
    };
    const entries = [
      valid,
      { pattern: 'x', rebuttal: 'y', category: 'toString', keywords: [] },
      { pattern: 'z', rebuttal: 'a', category: '__proto__', keywords: [] },
      { pattern: 'c', rebuttal: 'd', category: 'constructor', keywords: [] },
    ];
    fs.writeFileSync(path.join(base, 'custom-excuses.json'), JSON.stringify(entries));
    assert.deepStrictEqual(loadCustomExcuses(dir), [valid]);
  });
});

describe('trusted store home resolution', () => {
  const originalHome = process.env['HOME'];

  afterEach(() => {
    if (originalHome === undefined) delete process.env['HOME'];
    else process.env['HOME'] = originalHome;
  });

  it('uses HOME for the trusted store when it is an absolute path', () => {
    process.env['HOME'] = dir;
    const res = recordSighting('home store sighting');
    assert.strictEqual(res.isNew, true);
    assert.strictEqual(res.count, 1);
    assert.ok(fs.existsSync(path.join(dir, '.rationguard', 'sightings.json')));
  });

  it('does not fall back to the cwd when HOME is a relative path', () => {
    process.env['HOME'] = '.';
    const res = recordSighting('must not land in cwd');
    assert.strictEqual(res.count, 0);
    assert.strictEqual(res.autoPromoted, false);
    assert.ok(!fs.existsSync(path.join(process.cwd(), '.rationguard')));
    assert.deepStrictEqual(listSightings(), []);
  });

  it('never loads the project store as trusted when HOME is relative', () => {
    process.env['HOME'] = '.';
    // Attacker-style project-local excuse in a directory posing as cwd/home.
    assert.deepStrictEqual(loadCustomExcuses(), []);
  });

  it('falls back to os.homedir() when HOME is empty and refuses a non-absolute result', () => {
    // On POSIX an empty HOME makes os.homedir() return '' — not absolute, so
    // the trusted store must resolve to null and the sighting must be dropped
    // without touching the cwd.
    process.env['HOME'] = '';
    const res = recordSighting('empty home sighting');
    assert.strictEqual(res.count, 0);
    assert.strictEqual(res.isNew, false);
    assert.strictEqual(res.autoPromoted, false);
    assert.ok(!fs.existsSync(path.join(process.cwd(), '.rationguard')));
  });

  it('resolves the trusted store via os.homedir() when HOME is unset', () => {
    // With HOME deleted, getTrustedBase must consult os.homedir(). Only make
    // read-only calls here: the fallback resolves the real home directory.
    delete process.env['HOME'];
    assert.ok(Array.isArray(listSightings()));
    assert.ok(Array.isArray(loadCustomExcuses()));
  });
});

describe('recordSightingIfEligible', () => {
  // recordSightingIfEligible always targets the trusted ~/.rationguard store,
  // so point HOME at the per-test temp dir and inspect that.
  const originalHome = process.env['HOME'];
  const sightingsPath = () => path.join(dir, '.rationguard', 'sightings.json');
  const customExcusesPath = () => path.join(dir, '.rationguard', 'custom-excuses.json');

  function makeMatch(overrides: Partial<MatchResult> = {}, excuse: Partial<Excuse> | null = {}): MatchResult {
    const base: Excuse = {
      pattern: 'out of scope',
      rebuttal: 'Scope is what the task says it is.',
      category: 'deferral',
      keywords: ['out', 'scope'],
      source: 'user',
    };
    return {
      matched: true,
      excuse: excuse === null ? null : { ...base, ...excuse },
      confidence: AUTO_LEARN_CONFIDENCE_THRESHOLD,
      matchedText: "that's out of scope for this PR",
      ...overrides,
    };
  }

  beforeEach(() => {
    process.env['HOME'] = dir;
  });

  afterEach(() => {
    if (originalHome === undefined) delete process.env['HOME'];
    else process.env['HOME'] = originalHome;
  });

  it('ignores a result with no excuse without touching the store', () => {
    recordSightingIfEligible(makeMatch({ matched: false, confidence: 0, matchedText: '' }, null));
    assert.ok(!fs.existsSync(path.join(dir, '.rationguard')));
    assert.deepStrictEqual(listSightings(), []);
  });

  it('never records a project-local (untrusted) excuse, even at full confidence', () => {
    recordSightingIfEligible(makeMatch({ confidence: 1 }, { source: 'project' }));
    assert.ok(!fs.existsSync(path.join(dir, '.rationguard')));
    assert.deepStrictEqual(listSightings(), []);
  });

  it('drops matches below AUTO_LEARN_CONFIDENCE_THRESHOLD', () => {
    recordSightingIfEligible(makeMatch({ confidence: AUTO_LEARN_CONFIDENCE_THRESHOLD - 0.01 }));
    assert.ok(!fs.existsSync(sightingsPath()));
    assert.deepStrictEqual(listSightings(), []);
  });

  it('does not throw when the trusted store is not writable', () => {
    fs.writeFileSync(path.join(dir, '.rationguard'), 'not a directory');
    assert.doesNotThrow(() => recordSightingIfEligible(makeMatch({ confidence: 1 })));
  });

  it('records a user excuse at exactly the threshold under its category', () => {
    recordSightingIfEligible(makeMatch());
    const sightings = listSightings();
    assert.strictEqual(sightings.length, 1);
    assert.strictEqual(sightings[0].text, "that's out of scope for this PR");
    assert.strictEqual(sightings[0].count, 1);
    assert.strictEqual(sightings[0].suggestedCategory, 'deferral');
    assert.ok(fs.existsSync(sightingsPath()));
  });

  it('records builtin excuses (source undefined) like user excuses', () => {
    recordSightingIfEligible(makeMatch({ confidence: 0.9 }, { source: undefined }));
    recordSightingIfEligible(makeMatch({ confidence: 0.9 }, { source: 'builtin' }));
    const sightings = listSightings();
    assert.strictEqual(sightings.length, 1);
    assert.strictEqual(sightings[0].count, 2);
  });

  it('counts repeat sightings but never promotes them into custom-excuses.json', () => {
    for (let i = 0; i < 5; i++) recordSightingIfEligible(makeMatch({ confidence: 1 }));
    const sightings = listSightings();
    assert.strictEqual(sightings.length, 1);
    assert.strictEqual(sightings[0].count, 5);
    assert.ok(!sightings[0].promoted, 'detection sightings must stay count-only');
    assert.ok(!fs.existsSync(customExcusesPath()), 'auto-learn must not write the trusted excuse store');
    assert.deepStrictEqual(loadCustomExcuses(), []);
  });

  it('leaves an explicit `rationguard add` promotion free to proceed afterwards', () => {
    for (let i = 0; i < 3; i++) recordSightingIfEligible(makeMatch({ confidence: 1 }));
    // Same text through the explicit path (promote defaults to true) crosses
    // AUTO_ADD_THRESHOLD and promotes exactly once.
    const res = recordSighting("that's out of scope for this PR", 'deferral');
    assert.strictEqual(res.autoPromoted, true);
    const custom = loadCustomExcuses();
    assert.strictEqual(custom.length, 1);
    assert.strictEqual(custom[0].category, 'deferral');
  });

  it('is a no-op when no trusted home directory can be resolved', () => {
    process.env['HOME'] = '.';
    recordSightingIfEligible(makeMatch({ confidence: 1 }));
    assert.ok(!fs.existsSync(path.join(process.cwd(), '.rationguard')));
    assert.deepStrictEqual(listSightings(), []);
  });
});

describe('listSightings', () => {
  it('returns an empty array for a fresh store', () => {
    assert.deepStrictEqual(listSightings(dir), []);
  });

  it('returns an empty array when sightings.json is corrupt', () => {
    const base = path.join(dir, '.rationguard');
    fs.mkdirSync(base, { recursive: true });
    fs.writeFileSync(path.join(base, 'sightings.json'), 'garbage');
    assert.deepStrictEqual(listSightings(dir), []);
  });

  for (const content of ['{}', '[]', 'null', '{"sightings": null}']) {
    it(`treats wrong-shape sightings.json (${content}) as empty`, () => {
      const base = path.join(dir, '.rationguard');
      const file = path.join(base, 'sightings.json');
      fs.mkdirSync(base, { recursive: true });
      fs.writeFileSync(file, content);
      assert.deepStrictEqual(listSightings(dir), []);
      const result = recordSighting('fresh excuse', undefined, undefined, dir);
      assert.strictEqual(result.isNew, true);
      assert.strictEqual(result.count, 1);
      const rewritten = JSON.parse(fs.readFileSync(file, 'utf-8'));
      assert.ok(Array.isArray(rewritten.sightings));
      assert.strictEqual(rewritten.sightings.length, 1);
    });
  }

  it('drops invalid sighting entries and keeps valid ones', () => {
    const base = path.join(dir, '.rationguard');
    fs.mkdirSync(base, { recursive: true });
    const valid = {
      text: 'good',
      count: 2,
      firstSeen: '2026-01-01T00:00:00.000Z',
      lastSeen: '2026-01-02T00:00:00.000Z',
      suggestedCategory: 'deferral',
      suggestedRebuttal: 'do it',
      promoted: false,
    };
    fs.writeFileSync(
      path.join(base, 'sightings.json'),
      JSON.stringify({
        sightings: [valid, null, 'str', [], { ...valid, count: '2' }, { ...valid, suggestedCategory: 'nope' }],
      }),
    );
    assert.deepStrictEqual(listSightings(dir), [valid]);
  });

  it('sorts sightings by count descending', () => {
    recordSighting('seen once', undefined, undefined, dir);
    recordSighting('seen twice', undefined, undefined, dir);
    recordSighting('seen twice', undefined, undefined, dir);
    const sightings = listSightings(dir);
    assert.strictEqual(sightings[0].text, 'seen twice');
    assert.strictEqual(sightings[0].count, 2);
    assert.strictEqual(sightings[1].text, 'seen once');
  });

  it('drops sightings with prototype keys as suggestedCategory', () => {
    const base = path.join(dir, '.rationguard');
    fs.mkdirSync(base, { recursive: true });
    const valid = {
      text: 'this is valid',
      count: 1,
      firstSeen: new Date().toISOString(),
      lastSeen: new Date().toISOString(),
      suggestedCategory: 'deferral' as const,
      suggestedRebuttal: 'Act now.',
      promoted: false,
    };
    const store = {
      sightings: [
        valid,
        {
          text: 'prototype toString',
          count: 1,
          firstSeen: new Date().toISOString(),
          lastSeen: new Date().toISOString(),
          suggestedCategory: 'toString',
          suggestedRebuttal: 'x',
          promoted: false,
        },
        {
          text: 'prototype constructor',
          count: 1,
          firstSeen: new Date().toISOString(),
          lastSeen: new Date().toISOString(),
          suggestedCategory: 'constructor',
          suggestedRebuttal: 'y',
          promoted: false,
        },
      ],
    };
    fs.writeFileSync(path.join(base, 'sightings.json'), JSON.stringify(store));
    assert.deepStrictEqual(listSightings(dir), [valid]);
  });
});
