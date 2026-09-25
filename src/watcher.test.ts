import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Watcher, createWatcher, type WatcherDetection, type WatcherOptions } from './watcher.js';
import type { PlukEvent } from '@hivecommons/pluk';

// The Watcher reads user excuses from $HOME/.rationguard and project excuses
// from ./.rationguard, and its detections write sightings back to $HOME.
// Isolate both in a temp sandbox so tests never touch real state.
let sandbox: string;
let homeDir: string;
let projectDir: string;
let binDir: string;
let argsFile: string;
const savedHome = process.env['HOME'];
const savedPath = process.env['PATH'];
const savedCwd = process.cwd();

before(() => {
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'rationguard-watcher-'));
  homeDir = path.join(sandbox, 'home');
  projectDir = path.join(sandbox, 'project');
  binDir = path.join(sandbox, 'bin');
  argsFile = path.join(sandbox, 'pluk-send-args.txt');
  fs.mkdirSync(homeDir, { recursive: true });
  fs.mkdirSync(projectDir, { recursive: true });
  fs.mkdirSync(binDir, { recursive: true });
  const fakePlukSend = path.join(binDir, 'pluk-send');
  fs.writeFileSync(fakePlukSend, '#!/bin/sh\nprintf \'%s\\n\' "$@" > "$RG_TEST_ARGS_FILE"\n');
  fs.chmodSync(fakePlukSend, 0o755);
  process.env['HOME'] = homeDir;
  process.env['RG_TEST_ARGS_FILE'] = argsFile;
  process.chdir(projectDir);
});

after(() => {
  process.chdir(savedCwd);
  if (savedHome === undefined) delete process.env['HOME'];
  else process.env['HOME'] = savedHome;
  process.env['PATH'] = savedPath;
  delete process.env['RG_TEST_ARGS_FILE'];
  fs.rmSync(sandbox, { recursive: true, force: true });
});

beforeEach(() => {
  // Fresh excuse stores and captured args for every test.
  fs.rmSync(path.join(homeDir, '.rationguard'), { recursive: true, force: true });
  fs.rmSync(path.join(projectDir, '.rationguard'), { recursive: true, force: true });
  fs.rmSync(argsFile, { force: true });
  process.env['PATH'] = savedPath;
});

interface WatcherInternals {
  handleEvent(event: PlukEvent): void;
  flushBuffer(): void;
  buffer: string[];
  flushTimer: ReturnType<typeof setTimeout> | null;
  lastRebuttalSentAt: number;
}

function internals(w: Watcher): WatcherInternals {
  return w as unknown as WatcherInternals;
}

function rawOutput(session: string, line: string): PlukEvent {
  return {
    v: 1,
    ts: new Date().toISOString(),
    seq: 0,
    pid: process.pid,
    session,
    pane: '0',
    source: 'test',
    type: 'raw_output',
    data: { line },
  } as PlukEvent;
}

function stateChange(session: string, from: string, to: string): PlukEvent {
  return {
    v: 1,
    ts: new Date().toISOString(),
    seq: 0,
    pid: process.pid,
    session,
    pane: '0',
    source: 'test',
    type: 'state_change',
    data: { from, to },
  } as PlukEvent;
}

function makeWatcher(overrides: Partial<WatcherOptions> = {}): { watcher: Watcher; detections: WatcherDetection[] } {
  const detections: WatcherDetection[] = [];
  const watcher = createWatcher({
    session: 'test-session',
    mode: 'subscribe',
    quiet: true,
    onDetection: d => detections.push(d),
    ...overrides,
  });
  return { watcher, detections };
}

function writeUserExcuses(excuses: object[]): void {
  const dir = path.join(homeDir, '.rationguard');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'custom-excuses.json'), JSON.stringify(excuses, null, 2) + '\n');
}

function writeProjectExcuses(excuses: object[]): void {
  const dir = path.join(projectDir, '.rationguard');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'custom-excuses.json'), JSON.stringify(excuses, null, 2) + '\n');
}

describe('createWatcher', () => {
  it('returns a Watcher (an EventEmitter)', () => {
    const { watcher } = makeWatcher();
    assert.ok(watcher instanceof Watcher);
    assert.strictEqual(typeof watcher.on, 'function');
    watcher.stop();
  });
});

describe('event buffering and flushing', () => {
  it('buffers raw_output lines without flushing before the threshold', () => {
    const { watcher, detections } = makeWatcher();
    const w = internals(watcher);
    w.handleEvent(rawOutput('test-session', 'no work found'));
    assert.strictEqual(w.buffer.length, 1);
    assert.strictEqual(detections.length, 0);
    watcher.stop();
  });

  it('flushes on state_change to idle and emits a detection for excuse text', () => {
    const { watcher, detections } = makeWatcher();
    const w = internals(watcher);
    const emitted: WatcherDetection[] = [];
    watcher.on('detection', d => emitted.push(d));

    w.handleEvent(rawOutput('test-session', 'no work found'));
    w.handleEvent(stateChange('test-session', 'working', 'idle'));

    assert.strictEqual(detections.length, 1);
    assert.strictEqual(emitted.length, 1);
    assert.strictEqual(detections[0].result.clean, false);
    const patterns = detections[0].matches.map(m => m.excuse?.pattern);
    assert.ok(patterns.includes('no work found'));
    assert.strictEqual(w.buffer.length, 0);
    watcher.stop();
  });

  it('auto-flushes when the buffer reaches 20 lines', () => {
    const { watcher, detections } = makeWatcher();
    const w = internals(watcher);
    for (let i = 0; i < 19; i++) {
      w.handleEvent(rawOutput('test-session', `line ${i}`));
    }
    assert.strictEqual(detections.length, 0);
    w.handleEvent(rawOutput('test-session', 'no work found'));
    assert.strictEqual(detections.length, 1);
    assert.strictEqual(w.buffer.length, 0);
    watcher.stop();
  });

  it('does not emit a detection for clean text', () => {
    const { watcher, detections } = makeWatcher();
    const w = internals(watcher);
    w.handleEvent(rawOutput('test-session', 'purple elephants dance gracefully'));
    w.handleEvent(stateChange('test-session', 'working', 'idle'));
    assert.strictEqual(detections.length, 0);
    watcher.stop();
  });

  it('flushBuffer is a no-op when the buffer is empty', () => {
    const { watcher, detections } = makeWatcher();
    internals(watcher).flushBuffer();
    assert.strictEqual(detections.length, 0);
    watcher.stop();
  });

  it('re-emits non-idle pluk events as pluk-event', () => {
    const { watcher } = makeWatcher();
    const seen: PlukEvent[] = [];
    watcher.on('pluk-event', (e: PlukEvent) => seen.push(e));
    internals(watcher).handleEvent(stateChange('test-session', 'idle', 'working'));
    assert.strictEqual(seen.length, 1);
    assert.strictEqual(seen[0].data['to'], 'working');
    watcher.stop();
  });

  it('stop() flushes any pending buffered lines', () => {
    const { watcher, detections } = makeWatcher();
    internals(watcher).handleEvent(rawOutput('test-session', 'no work found'));
    watcher.stop();
    assert.strictEqual(detections.length, 1);
  });

  it('records a sighting for high-confidence matches', () => {
    const { watcher } = makeWatcher();
    const w = internals(watcher);
    w.handleEvent(rawOutput('test-session', 'no work found'));
    w.handleEvent(stateChange('test-session', 'working', 'idle'));
    watcher.stop();

    const raw = fs.readFileSync(path.join(homeDir, '.rationguard', 'sightings.json'), 'utf-8');
    const store = JSON.parse(raw) as { sightings: Array<{ text: string }> };
    assert.ok(store.sightings.some(s => s.text === 'no work found'));
  });
});

describe('post-rebuttal quiet period', () => {
  it('suppresses detections while the quiet period is active', () => {
    const { watcher, detections } = makeWatcher();
    const w = internals(watcher);
    w.lastRebuttalSentAt = Date.now();
    w.handleEvent(rawOutput('test-session', 'no work found'));
    w.handleEvent(stateChange('test-session', 'working', 'idle'));
    assert.strictEqual(detections.length, 0);
    watcher.stop();
  });

  it('emits detections again once the quiet period has elapsed', () => {
    const { watcher, detections } = makeWatcher();
    const w = internals(watcher);
    w.lastRebuttalSentAt = Date.now() - 61_000;
    w.handleEvent(rawOutput('test-session', 'no work found'));
    w.handleEvent(stateChange('test-session', 'working', 'idle'));
    assert.strictEqual(detections.length, 1);
    watcher.stop();
  });
});

describe('rebuttal sending', () => {
  it('sends rebuttals via pluk-send and records them on the detection', () => {
    process.env['PATH'] = `${binDir}:${savedPath}`;
    const { watcher, detections } = makeWatcher({ rebuttal: 'send' });
    const w = internals(watcher);
    w.handleEvent(rawOutput('test-session', 'no work found'));
    w.handleEvent(stateChange('test-session', 'working', 'idle'));
    watcher.stop();

    assert.strictEqual(detections.length, 1);
    assert.ok(detections[0].sentRebuttals);
    assert.ok(detections[0].sentRebuttals.includes('no work found'));

    const args = fs.readFileSync(argsFile, 'utf-8').split('\n');
    assert.strictEqual(args[0], '--session=test-session');
    assert.ok(args[1].startsWith('--text='));
    assert.strictEqual(args[2], '--enter');
  });

  it('sanitizes rebuttals to a single line before sending', () => {
    process.env['PATH'] = `${binDir}:${savedPath}`;
    writeUserExcuses([
      {
        pattern: 'zorble excuse alpha',
        rebuttal: 'line one\r\nline two\x1b[31m\ttrailing  ',
        category: 'deferral',
        keywords: ['zorble'],
      },
    ]);
    const { watcher, detections } = makeWatcher({ rebuttal: 'send' });
    const w = internals(watcher);
    w.handleEvent(rawOutput('test-session', 'zorble excuse alpha'));
    w.handleEvent(stateChange('test-session', 'working', 'idle'));
    watcher.stop();

    assert.strictEqual(detections.length, 1);
    const args = fs.readFileSync(argsFile, 'utf-8').split('\n');
    const textArg = args.find(a => a.startsWith('--text='));
    assert.ok(textArg);
    assert.strictEqual(textArg, '--text=line one line two [31m trailing');
  });

  it('deduplicates identical rebuttal texts within one flush', () => {
    process.env['PATH'] = `${binDir}:${savedPath}`;
    writeUserExcuses([
      { pattern: 'zorble one', rebuttal: 'shared rebuttal text', category: 'deferral', keywords: ['zorble one'] },
      { pattern: 'zorble two', rebuttal: 'shared rebuttal text', category: 'deferral', keywords: ['zorble two'] },
    ]);
    const { watcher, detections } = makeWatcher({ rebuttal: 'send' });
    const w = internals(watcher);
    w.handleEvent(rawOutput('test-session', 'zorble one and zorble two'));
    w.handleEvent(stateChange('test-session', 'working', 'idle'));
    watcher.stop();

    assert.strictEqual(detections.length, 1);
    assert.ok(detections[0].sentRebuttals);
    assert.strictEqual(detections[0].sentRebuttals.length, 1);
  });

  it('honors the per-excuse cooldown across flushes', () => {
    process.env['PATH'] = `${binDir}:${savedPath}`;
    const { watcher, detections } = makeWatcher({ rebuttal: 'send' });
    const w = internals(watcher);
    w.handleEvent(rawOutput('test-session', 'no work found'));
    w.handleEvent(stateChange('test-session', 'working', 'idle'));
    assert.strictEqual(detections[0].sentRebuttals?.length, 1);

    // Clear the quiet period so only the per-excuse cooldown applies.
    w.lastRebuttalSentAt = 0;
    fs.rmSync(argsFile, { force: true });
    w.handleEvent(rawOutput('test-session', 'no work found'));
    w.handleEvent(stateChange('test-session', 'working', 'idle'));
    watcher.stop();

    assert.strictEqual(detections.length, 2);
    assert.strictEqual(detections[1].sentRebuttals, undefined);
    assert.strictEqual(fs.existsSync(argsFile), false);
  });

  it('never auto-sends rebuttals for project-local (untrusted) excuses', () => {
    process.env['PATH'] = `${binDir}:${savedPath}`;
    writeProjectExcuses([
      {
        pattern: 'quux project excuse',
        rebuttal: 'malicious injected command',
        category: 'deferral',
        keywords: ['quux project'],
      },
    ]);
    const { watcher, detections } = makeWatcher({ rebuttal: 'send' });
    const w = internals(watcher);
    w.handleEvent(rawOutput('test-session', 'quux project excuse'));
    w.handleEvent(stateChange('test-session', 'working', 'idle'));
    watcher.stop();

    // Detection still fires, but nothing is typed into the session.
    assert.strictEqual(detections.length, 1);
    assert.strictEqual(detections[0].sentRebuttals, undefined);
    assert.strictEqual(fs.existsSync(argsFile), false);
  });

  it('reports no sent rebuttals when both pluk-send and tmux are unavailable', () => {
    process.env['PATH'] = binDir.replace(/bin$/, 'empty-bin');
    fs.mkdirSync(process.env['PATH'], { recursive: true });
    const { watcher, detections } = makeWatcher({ rebuttal: 'send' });
    const w = internals(watcher);
    w.handleEvent(rawOutput('test-session', 'no work found'));
    w.handleEvent(stateChange('test-session', 'working', 'idle'));
    watcher.stop();

    assert.strictEqual(detections.length, 1);
    assert.strictEqual(detections[0].sentRebuttals, undefined);
  });

  it('rejects session names with characters outside [a-zA-Z0-9_.-]', () => {
    process.env['PATH'] = `${binDir}:${savedPath}`;
    const { watcher } = makeWatcher({ rebuttal: 'send', session: 'bad;session' });
    const w = internals(watcher);
    w.handleEvent(rawOutput('bad;session', 'no work found'));
    assert.throws(
      () => w.handleEvent(stateChange('bad;session', 'working', 'idle')),
      /Invalid session name/,
    );
    watcher.stop();
  });

  it('logs instead of sending when rebuttal mode is not "send"', () => {
    process.env['PATH'] = `${binDir}:${savedPath}`;
    const { watcher, detections } = makeWatcher({ rebuttal: 'log' });
    const w = internals(watcher);
    w.handleEvent(rawOutput('test-session', 'no work found'));
    w.handleEvent(stateChange('test-session', 'working', 'idle'));
    watcher.stop();

    assert.strictEqual(detections.length, 1);
    assert.strictEqual(detections[0].sentRebuttals, undefined);
    assert.strictEqual(fs.existsSync(argsFile), false);
  });
});

describe('custom excuse loading', () => {
  it('merges user and project excuses with the built-in defaults', () => {
    writeUserExcuses([
      { pattern: 'frobnicate user excuse', rebuttal: 'user rebuttal', category: 'deferral', keywords: ['frobnicate user'] },
    ]);
    writeProjectExcuses([
      { pattern: 'frobnicate project excuse', rebuttal: 'project rebuttal', category: 'deferral', keywords: ['frobnicate project'] },
    ]);
    const { watcher, detections } = makeWatcher();
    const w = internals(watcher);
    w.handleEvent(rawOutput('test-session', 'frobnicate user excuse then frobnicate project excuse then no work found'));
    w.handleEvent(stateChange('test-session', 'working', 'idle'));
    watcher.stop();

    assert.strictEqual(detections.length, 1);
    const bySource = new Map(detections[0].matches.map(m => [m.excuse?.pattern, m.excuse?.source]));
    assert.strictEqual(bySource.get('frobnicate user excuse'), 'user');
    assert.strictEqual(bySource.get('frobnicate project excuse'), 'project');
    assert.strictEqual(bySource.get('no work found'), undefined);
  });
});
