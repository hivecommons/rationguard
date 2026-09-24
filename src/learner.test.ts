import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { recordSighting, loadCustomExcuses, listSightings } from './learner.js';
import type { Excuse } from './types.js';

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

  it('sorts sightings by count descending', () => {
    recordSighting('seen once', undefined, undefined, dir);
    recordSighting('seen twice', undefined, undefined, dir);
    recordSighting('seen twice', undefined, undefined, dir);
    const sightings = listSightings(dir);
    assert.strictEqual(sightings[0].text, 'seen twice');
    assert.strictEqual(sightings[0].count, 2);
    assert.strictEqual(sightings[1].text, 'seen once');
  });
});
