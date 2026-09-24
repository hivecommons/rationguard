import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Watcher, createWatcher, type WatcherDetection, type WatcherOptions } from './watcher.js';
import { DEFAULT_EXCUSES } from './defaults.js';
import type { Excuse } from './types.js';
import type { PlukEvent } from '@hivecommons/pluk';

// These tests are hermetic: HOME and the working directory are redirected to
// fresh temp dirs so getAllExcuses()/recordSighting() never touch real user
// state, and no test path ever reaches execFileSync (pluk-send/tmux).

let homeDir: string;
let projectDir: string;
let savedHome: string | undefined;
let savedCwd: string;

beforeEach(() => {
  homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rationguard-watch-home-'));
  projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rationguard-watch-proj-'));
  savedHome = process.env['HOME'];
  savedCwd = process.cwd();
  process.env['HOME'] = homeDir;
  process.chdir(projectDir);
});

afterEach(() => {
  process.chdir(savedCwd);
  if (savedHome === undefined) delete process.env['HOME'];
  else process.env['HOME'] = savedHome;
  fs.rmSync(homeDir, { recursive: true, force: true });
  fs.rmSync(projectDir, { recursive: true, force: true });
});

function writeCustomExcuses(baseDir: string, excuses: Excuse[]): void {
  const dir = path.join(baseDir, '.rationguard');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'custom-excuses.json'), JSON.stringify(excuses, null, 2) + '\n');
}

let seq = 0;
function mkEvent(type: 'raw_output' | 'state_change', data: Record<string, string>): PlukEvent {
  return {
    v: 1,
    ts: new Date().toISOString(),
    seq: seq++,
    pid: process.pid,
    session: 'rationguard-test-no-such-session',
    pane: '0',
    source: 'test',
    type,
    data,
  } as PlukEvent;
}

function newWatcher(overrides: Partial<WatcherOptions> = {}): Watcher {
  return new Watcher({
    session: 'rationguard-test-no-such-session',
    mode: 'subscribe',
    ...overrides,
  });
}

// Drive the (compile-time) private event pipeline directly so no pluk
// subscriber or child process is ever started.
function feed(w: Watcher, event: PlukEvent): void {
  (w as unknown as { handleEvent(e: PlukEvent): void }).handleEvent(event);
}

function flushViaIdle(w: Watcher): void {
  feed(w, mkEvent('state_change', { from: 'busy', to: 'idle' }));
}

describe('createWatcher / constructor', () => {
  it('createWatcher returns a Watcher instance', () => {
    assert.ok(createWatcher({ session: 's', mode: 'subscribe' }) instanceof Watcher);
  });

  it('loads at least the default excuses', () => {
    const w = newWatcher();
    const excuses = (w as unknown as { excuses: Excuse[] }).excuses;
    assert.ok(excuses.length >= DEFAULT_EXCUSES.length);
  });

  it('merges HOME (user) and project-local excuses with their sources marked', () => {
    writeCustomExcuses(homeDir, [{ pattern: 'zibblewick home', rebuttal: 'r', category: 'deferral', keywords: ['zibblewick'] }]);
    writeCustomExcuses(projectDir, [{ pattern: 'quorfle project', rebuttal: 'r', category: 'deferral', keywords: ['quorfle'] }]);
    const w = newWatcher();
    const excuses = (w as unknown as { excuses: Excuse[] }).excuses;
    const user = excuses.find(e => e.pattern === 'zibblewick home');
    const project = excuses.find(e => e.pattern === 'quorfle project');
    assert.strictEqual(user?.source, 'user');
    assert.strictEqual(project?.source, 'project');
  });
});

describe('event handling and flushing', () => {
  it('emits no detection for clean output', () => {
    const w = newWatcher();
    const detections: WatcherDetection[] = [];
    w.on('detection', d => detections.push(d));
    feed(w, mkEvent('raw_output', { line: 'hello world' }));
    flushViaIdle(w);
    assert.strictEqual(detections.length, 0);
  });

  it('emits a detection when buffered output matches a default excuse', () => {
    const w = newWatcher();
    const detections: WatcherDetection[] = [];
    w.on('detection', d => detections.push(d));
    feed(w, mkEvent('raw_output', { line: 'no work found in this repo' }));
    flushViaIdle(w);
    assert.strictEqual(detections.length, 1);
    assert.strictEqual(detections[0].result.clean, false);
    assert.ok(detections[0].matches.length >= 1);
    assert.match(String(detections[0].event.data['line']), /no work found/);
  });

  it('invokes the onDetection callback', () => {
    const seen: WatcherDetection[] = [];
    const w = newWatcher({ onDetection: d => seen.push(d) });
    feed(w, mkEvent('raw_output', { line: 'no work found' }));
    flushViaIdle(w);
    assert.strictEqual(seen.length, 1);
  });

  it('joins multiple buffered lines into a single checked text', () => {
    const w = newWatcher();
    const detections: WatcherDetection[] = [];
    w.on('detection', d => detections.push(d));
    feed(w, mkEvent('raw_output', { line: 'alpha' }));
    feed(w, mkEvent('raw_output', { line: 'no work found' }));
    feed(w, mkEvent('raw_output', { line: 'omega' }));
    flushViaIdle(w);
    assert.strictEqual(detections.length, 1);
    assert.strictEqual(detections[0].event.data['line'], 'alpha\nno work found\nomega');
  });

  it('auto-flushes once the raw-output buffer reaches 20 lines', () => {
    const w = newWatcher();
    const detections: WatcherDetection[] = [];
    w.on('detection', d => detections.push(d));
    feed(w, mkEvent('raw_output', { line: 'no work found' }));
    for (let i = 0; i < 19; i++) feed(w, mkEvent('raw_output', { line: `filler ${i}` }));
    assert.strictEqual(detections.length, 1);
    assert.strictEqual((w as unknown as { buffer: string[] }).buffer.length, 0);
  });

  it('a non-idle state_change does not flush and is re-emitted as pluk-event', () => {
    const w = newWatcher();
    const detections: WatcherDetection[] = [];
    const forwarded: PlukEvent[] = [];
    w.on('detection', d => detections.push(d));
    w.on('pluk-event', e => forwarded.push(e as PlukEvent));
    feed(w, mkEvent('raw_output', { line: 'no work found' }));
    feed(w, mkEvent('state_change', { from: 'idle', to: 'busy' }));
    assert.strictEqual(detections.length, 0);
    assert.strictEqual(forwarded.length, 1);
    flushViaIdle(w);
    assert.strictEqual(detections.length, 1);
  });

  it('stop() flushes any pending buffer', () => {
    const w = newWatcher();
    const detections: WatcherDetection[] = [];
    w.on('detection', d => detections.push(d));
    feed(w, mkEvent('raw_output', { line: 'no work found' }));
    w.stop();
    assert.strictEqual(detections.length, 1);
  });

  it('records a sighting for high-confidence matches (into redirected HOME)', () => {
    const w = newWatcher();
    feed(w, mkEvent('raw_output', { line: 'no work found' }));
    flushViaIdle(w);
    const sightingsPath = path.join(homeDir, '.rationguard', 'sightings.json');
    assert.ok(fs.existsSync(sightingsPath));
    const store = JSON.parse(fs.readFileSync(sightingsPath, 'utf-8'));
    assert.ok(store.sightings.length >= 1);
  });
});

describe('rebuttal send guards (no child process is ever spawned)', () => {
  it('suppresses detections during the post-rebuttal quiet period', () => {
    const w = newWatcher();
    const detections: WatcherDetection[] = [];
    w.on('detection', d => detections.push(d));
    (w as unknown as { lastRebuttalSentAt: number }).lastRebuttalSentAt = Date.now();
    feed(w, mkEvent('raw_output', { line: 'no work found' }));
    flushViaIdle(w);
    assert.strictEqual(detections.length, 0);
  });

  it('never auto-sends rebuttals for project-local (untrusted) excuses', () => {
    writeCustomExcuses(projectDir, [
      { pattern: 'zorblat frobnicate', rebuttal: 'PROJECT REBUTTAL', category: 'deferral', keywords: ['zorblat'] },
    ]);
    const w = newWatcher({ rebuttal: 'send' });
    const detections: WatcherDetection[] = [];
    w.on('detection', d => detections.push(d));
    feed(w, mkEvent('raw_output', { line: 'zorblat frobnicate' }));
    flushViaIdle(w);
    assert.strictEqual(detections.length, 1);
    assert.strictEqual(detections[0].sentRebuttals, undefined);
    assert.strictEqual((w as unknown as { lastRebuttalSentAt: number }).lastRebuttalSentAt, 0);
  });

  it('skips a rebuttal whose pattern is still in cooldown', () => {
    writeCustomExcuses(homeDir, [
      { pattern: 'flimwok zumzum', rebuttal: 'a real rebuttal', category: 'deferral', keywords: ['flimwok'] },
    ]);
    const w = newWatcher({ rebuttal: 'send' });
    const detections: WatcherDetection[] = [];
    w.on('detection', d => detections.push(d));
    (w as unknown as { rebuttalCooldowns: Map<string, number> }).rebuttalCooldowns.set('flimwok zumzum', Date.now());
    feed(w, mkEvent('raw_output', { line: 'flimwok zumzum' }));
    flushViaIdle(w);
    assert.strictEqual(detections.length, 1);
    assert.strictEqual(detections[0].sentRebuttals, undefined);
    assert.strictEqual((w as unknown as { lastRebuttalSentAt: number }).lastRebuttalSentAt, 0);
  });

  it('a rebuttal that sanitizes to empty (control chars only) is never delivered', () => {
    writeCustomExcuses(homeDir, [
      { pattern: 'quuxglarp injection', rebuttal: '\n\r\t \x07\x1b', category: 'deferral', keywords: ['quuxglarp'] },
    ]);
    const w = newWatcher({ rebuttal: 'send' });
    const detections: WatcherDetection[] = [];
    w.on('detection', d => detections.push(d));
    feed(w, mkEvent('raw_output', { line: 'quuxglarp injection' }));
    flushViaIdle(w);
    assert.strictEqual(detections.length, 1);
    // sanitizeRebuttal collapses the control characters to nothing, so
    // sendRebuttal bails out before exec and no rebuttal is recorded as sent.
    assert.strictEqual(detections[0].sentRebuttals, undefined);
    assert.strictEqual((w as unknown as { lastRebuttalSentAt: number }).lastRebuttalSentAt, 0);
  });

  it('rejects session names that fail validation before any exec', () => {
    writeCustomExcuses(homeDir, [
      { pattern: 'glorp session check', rebuttal: 'a real rebuttal', category: 'deferral', keywords: ['glorp'] },
    ]);
    const w = newWatcher({ session: 'bad;name $(evil)', rebuttal: 'send' });
    feed(w, mkEvent('raw_output', { line: 'glorp session check' }));
    assert.throws(() => flushViaIdle(w), /Invalid session name/);
  });
});
