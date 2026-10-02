import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Watcher, createWatcher, resolvePlukSendBin, type WatcherDetection, type WatcherOptions } from './watcher.js';
import type { PlukEvent, Subscriber } from '@hivecommons/pluk';

// The Watcher reads user excuses from $HOME/.rationguard and project excuses
// from ./.rationguard, and its detections write sightings back to $HOME.
// Isolate both in a temp sandbox so tests never touch real state.
let sandbox: string;
let homeDir: string;
let projectDir: string;
let binDir: string;
let argsFile: string;
let fakePlukSend: string;
let tmuxBinDir: string;
let tmuxArgsFile: string;
const savedHome = process.env['HOME'];
const savedPath = process.env['PATH'];
const savedPlukSendBin = process.env['RATIONGUARD_PLUK_SEND_BIN'];
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
  fakePlukSend = path.join(binDir, 'pluk-send');
  fs.writeFileSync(fakePlukSend, '#!/bin/sh\nprintf \'%s\\n\' "$@" > "$RG_TEST_ARGS_FILE"\n');
  fs.chmodSync(fakePlukSend, 0o755);
  // A bin dir that has tmux but NOT pluk-send, to exercise the fallback path.
  tmuxBinDir = path.join(sandbox, 'tmux-bin');
  tmuxArgsFile = path.join(sandbox, 'tmux-args.txt');
  fs.mkdirSync(tmuxBinDir, { recursive: true });
  const fakeTmux = path.join(tmuxBinDir, 'tmux');
  fs.writeFileSync(fakeTmux, '#!/bin/sh\nprintf \'%s\\n\' "$@" >> "$RG_TEST_TMUX_ARGS_FILE"\n');
  fs.chmodSync(fakeTmux, 0o755);
  process.env['HOME'] = homeDir;
  process.env['RG_TEST_ARGS_FILE'] = argsFile;
  process.env['RG_TEST_TMUX_ARGS_FILE'] = tmuxArgsFile;
  process.chdir(projectDir);
});

after(() => {
  process.chdir(savedCwd);
  if (savedHome === undefined) delete process.env['HOME'];
  else process.env['HOME'] = savedHome;
  process.env['PATH'] = savedPath;
  if (savedPlukSendBin === undefined) delete process.env['RATIONGUARD_PLUK_SEND_BIN'];
  else process.env['RATIONGUARD_PLUK_SEND_BIN'] = savedPlukSendBin;
  delete process.env['RG_TEST_ARGS_FILE'];
  delete process.env['RG_TEST_TMUX_ARGS_FILE'];
  fs.rmSync(sandbox, { recursive: true, force: true });
});

beforeEach(() => {
  // Fresh excuse stores and captured args for every test.
  fs.rmSync(path.join(homeDir, '.rationguard'), { recursive: true, force: true });
  fs.rmSync(path.join(projectDir, '.rationguard'), { recursive: true, force: true });
  fs.rmSync(argsFile, { force: true });
  fs.rmSync(tmuxArgsFile, { force: true });
  process.env['PATH'] = savedPath;
  delete process.env['RATIONGUARD_PLUK_SEND_BIN'];
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

  it('buffers an empty string when a raw_output event carries no line', () => {
    const { watcher, detections } = makeWatcher();
    const w = internals(watcher);
    const event = rawOutput('test-session', 'ignored');
    delete (event.data as Record<string, unknown>)['line'];
    w.handleEvent(event);
    assert.deepStrictEqual(w.buffer, ['']);
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

  it('never records sightings for project-local excuses (no laundering into the HOME store)', () => {
    writeProjectExcuses([
      { pattern: 'the', rebuttal: 'attacker rebuttal', category: 'deferral', keywords: ['the'] },
    ]);
    const { watcher, detections } = makeWatcher();
    const w = internals(watcher);
    // Three high-confidence matches — enough to auto-promote if recorded.
    for (let i = 0; i < 3; i++) {
      w.handleEvent(rawOutput('test-session', 'I updated the file as requested.'));
      w.handleEvent(stateChange('test-session', 'working', 'idle'));
    }
    watcher.stop();

    assert.strictEqual(detections.length, 3);
    const sightingsPath = path.join(homeDir, '.rationguard', 'sightings.json');
    if (fs.existsSync(sightingsPath)) {
      const store = JSON.parse(fs.readFileSync(sightingsPath, 'utf-8')) as { sightings: Array<{ text: string }> };
      assert.ok(!store.sightings.some(s => s.text === 'the'), 'project excuse pattern must not be recorded as a sighting');
    }
    const userExcusesPath = path.join(homeDir, '.rationguard', 'custom-excuses.json');
    if (fs.existsSync(userExcusesPath)) {
      const excuses = JSON.parse(fs.readFileSync(userExcusesPath, 'utf-8')) as Array<{ pattern: string }>;
      assert.ok(!excuses.some(e => e.pattern === 'the'), 'project excuse must never be promoted into the trusted user store');
    }
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

describe('resolvePlukSendBin', () => {
  afterEach(() => {
    delete process.env['RATIONGUARD_PLUK_SEND_BIN'];
  });

  it('honors the RATIONGUARD_PLUK_SEND_BIN override', () => {
    process.env['RATIONGUARD_PLUK_SEND_BIN'] = '/some/custom/pluk-send';
    assert.strictEqual(resolvePlukSendBin(), '/some/custom/pluk-send');
  });

  it("resolves the pluk-send bin pinned by this package's @hivecommons/pluk dependency", () => {
    delete process.env['RATIONGUARD_PLUK_SEND_BIN'];
    const resolved = resolvePlukSendBin();
    assert.ok(
      resolved.endsWith(path.join('.bin', 'pluk-send')),
      `expected the local node_modules/.bin path, not a bare PATH lookup, got: ${resolved}`,
    );
    assert.ok(fs.existsSync(resolved), `expected ${resolved} to exist`);
  });
});

describe('rebuttal sending', () => {
  it('sends rebuttals via pluk-send and records them on the detection', () => {
    process.env['PATH'] = `${binDir}:${savedPath}`;
    process.env['RATIONGUARD_PLUK_SEND_BIN'] = fakePlukSend;
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
    process.env['RATIONGUARD_PLUK_SEND_BIN'] = fakePlukSend;
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
    process.env['RATIONGUARD_PLUK_SEND_BIN'] = fakePlukSend;
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
    process.env['RATIONGUARD_PLUK_SEND_BIN'] = fakePlukSend;
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
    process.env['RATIONGUARD_PLUK_SEND_BIN'] = fakePlukSend;
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
    process.env['RATIONGUARD_PLUK_SEND_BIN'] = path.join(sandbox, 'no-such-pluk-send');
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
    process.env['RATIONGUARD_PLUK_SEND_BIN'] = fakePlukSend;
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
    process.env['RATIONGUARD_PLUK_SEND_BIN'] = fakePlukSend;
    const { watcher, detections } = makeWatcher({ rebuttal: 'log' });
    const w = internals(watcher);
    w.handleEvent(rawOutput('test-session', 'no work found'));
    w.handleEvent(stateChange('test-session', 'working', 'idle'));
    watcher.stop();

    assert.strictEqual(detections.length, 1);
    assert.strictEqual(detections[0].sentRebuttals, undefined);
    assert.strictEqual(fs.existsSync(argsFile), false);
  });

  it('sends nothing when the rebuttal sanitizes to an empty string', () => {
    // A control-character-only rebuttal collapses to '' after sanitization.
    // sendRebuttal must bail out instead of delivering a bare Enter keypress
    // (an empty submit) to the agent session.
    process.env['PATH'] = `${binDir}:${savedPath}`;
    process.env['RATIONGUARD_PLUK_SEND_BIN'] = fakePlukSend;
    writeUserExcuses([
      {
        pattern: 'zorble empty rebuttal',
        rebuttal: '\x01\x02\r\n\t \x7f',
        category: 'deferral',
        keywords: ['zorble empty'],
      },
    ]);
    const { watcher, detections } = makeWatcher({ rebuttal: 'send' });
    const w = internals(watcher);
    w.handleEvent(rawOutput('test-session', 'zorble empty rebuttal'));
    w.handleEvent(stateChange('test-session', 'working', 'idle'));
    watcher.stop();

    assert.strictEqual(detections.length, 1);
    assert.strictEqual(detections[0].sentRebuttals, undefined);
    assert.strictEqual(fs.existsSync(argsFile), false, 'pluk-send must not be invoked for an empty rebuttal');
  });

  it('logs pluk-send success when verbose is enabled', () => {
    process.env['PATH'] = `${binDir}:${savedPath}`;
    process.env['RATIONGUARD_PLUK_SEND_BIN'] = fakePlukSend;
    const logs: string[] = [];
    const savedError = console.error;
    console.error = (...args: unknown[]) => { logs.push(args.map(String).join(' ')); };
    try {
      const { watcher, detections } = makeWatcher({ rebuttal: 'send', verbose: true });
      const w = internals(watcher);
      w.handleEvent(rawOutput('test-session', 'no work found'));
      w.handleEvent(stateChange('test-session', 'working', 'idle'));
      watcher.stop();

      assert.strictEqual(detections.length, 1);
      assert.ok(detections[0].sentRebuttals?.includes('no work found'));
    } finally {
      console.error = savedError;
    }
    assert.ok(
      logs.some(l => l.includes('sendRebuttal: pluk-send succeeded')),
      `expected verbose success log, got: ${logs.join(' | ')}`,
    );
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

describe('rebuttal delivery fallback', () => {
  it('falls back to tmux send-keys when pluk-send is unavailable', () => {
    // tmuxBinDir has a fake tmux but no pluk-send.
    process.env['PATH'] = tmuxBinDir;
    process.env['RATIONGUARD_PLUK_SEND_BIN'] = path.join(sandbox, 'no-such-pluk-send');
    const { watcher, detections } = makeWatcher({ rebuttal: 'send' });
    const w = internals(watcher);
    w.handleEvent(rawOutput('test-session', 'no work found'));
    w.handleEvent(stateChange('test-session', 'working', 'idle'));
    watcher.stop();

    assert.strictEqual(detections.length, 1);
    assert.ok(detections[0].sentRebuttals);
    assert.ok(detections[0].sentRebuttals.includes('no work found'));

    // Two invocations: literal text (after an end-of-options marker), then Enter.
    const args = fs.readFileSync(tmuxArgsFile, 'utf-8').trim().split('\n');
    assert.deepStrictEqual(args.slice(0, 5), ['send-keys', '-l', '-t', 'test-session', '--']);
    assert.ok(args[5].startsWith('Verify by checking'));
    assert.strictEqual(args[args.length - 1], 'Enter');
    assert.strictEqual(args[args.length - 2], 'test-session');
  });

  it('verbose mode logs the pluk-send failure and the tmux fallback', () => {
    process.env['PATH'] = tmuxBinDir;
    process.env['RATIONGUARD_PLUK_SEND_BIN'] = path.join(sandbox, 'no-such-pluk-send');
    const logs: string[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => { logs.push(args.join(' ')); };
    try {
      const { watcher, detections } = makeWatcher({ rebuttal: 'send', verbose: true });
      const w = internals(watcher);
      w.handleEvent(rawOutput('test-session', 'no work found'));
      w.handleEvent(stateChange('test-session', 'working', 'idle'));
      watcher.stop();
      assert.strictEqual(detections.length, 1);
    } finally {
      console.error = originalError;
    }

    assert.ok(logs.some(l => l.includes('sendRebuttal: trying pluk-send')));
    assert.ok(logs.some(l => l.includes('sendRebuttal: pluk-send failed')));
    assert.ok(logs.some(l => l.includes('falling back to tmux send-keys')));
    assert.ok(logs.some(l => l.includes('tmux send-keys succeeded')));
  });
});

describe('timed flush', () => {
  it('flushes buffered raw output when the flush timer elapses', async () => {
    const { watcher, detections } = makeWatcher();
    const w = internals(watcher);
    w.handleEvent(rawOutput('test-session', 'no work found'));
    // A second line must reuse the already-armed timer, not arm another.
    w.handleEvent(rawOutput('test-session', 'still no work found'));
    assert.ok(w.flushTimer, 'flush timer should be armed after raw output');
    assert.strictEqual(detections.length, 0);

    await once(watcher, 'detection');

    assert.strictEqual(detections.length, 1);
    assert.strictEqual(w.buffer.length, 0);
    assert.strictEqual(w.flushTimer, null);
    watcher.stop();
  });
});

describe('subscribe-mode start()', () => {
  it('tails the pluk JSONL log and emits detections for appended events', async () => {
    const runDir = path.join(sandbox, 'run-subscribe');
    const logsDir = path.join(runDir, 'logs');
    fs.mkdirSync(logsDir, { recursive: true });
    const logFile = path.join(logsDir, 'test-session.jsonl');
    fs.writeFileSync(logFile, '');

    const { watcher, detections } = makeWatcher({ runDir });
    let detected = false;
    watcher.on('detection', () => { detected = true; });
    const started = watcher.start();

    // The subscriber tails from EOF; keep appending until it picks events up.
    const lines =
      [rawOutput('test-session', 'no work found'), stateChange('test-session', 'working', 'idle')]
        .map(e => JSON.stringify(e))
        .join('\n') + '\n';
    for (let i = 0; i < 40 && !detected; i++) {
      fs.appendFileSync(logFile, lines);
      await new Promise(resolve => setTimeout(resolve, 250));
    }

    watcher.stop();
    await started;

    assert.ok(detected, 'expected at least one detection from the tailed log');
    assert.ok(detections.length >= 1);
    assert.ok(detections[0].matches.some(m => m.excuse?.pattern === 'no work found'));
  });
});

describe('subscribe-mode error forwarding', () => {
  it('re-emits subscriber errors as watcher "error" events', async () => {
    const runDir = path.join(sandbox, 'run-error-forward');
    const logsDir = path.join(runDir, 'logs');
    fs.mkdirSync(logsDir, { recursive: true });
    fs.writeFileSync(path.join(logsDir, 'test-session.jsonl'), '');

    const { watcher } = makeWatcher({ runDir });
    const errors: Error[] = [];
    watcher.on('error', (err: Error) => errors.push(err));
    const started = watcher.start();

    // Wait for start() to construct the subscriber, then simulate a tail
    // failure on it — the watcher must forward it to its own listeners.
    const w = watcher as unknown as { subscriber: Subscriber | null };
    for (let i = 0; i < 40 && !w.subscriber; i++) {
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.ok(w.subscriber, 'expected a subscriber after start() in subscribe mode');
    w.subscriber.emit('error', new Error('simulated tail failure'));

    watcher.stop();
    await started;

    assert.strictEqual(errors.length, 1);
    assert.match(errors[0].message, /simulated tail failure/);
  });
});

describe('verbose flush logging', () => {
  it('truncates long flush previews to 200 chars with an ellipsis', () => {
    const logs: string[] = [];
    const savedError = console.error;
    console.error = (...args: unknown[]) => { logs.push(args.map(String).join(' ')); };
    try {
      const { watcher } = makeWatcher({ verbose: true });
      const w = internals(watcher);
      w.handleEvent(rawOutput('test-session', 'x'.repeat(300)));
      w.handleEvent(stateChange('test-session', 'working', 'idle'));
      watcher.stop();
    } finally {
      console.error = savedError;
    }

    const previewLog = logs.find(l => l.includes(': text: "'));
    assert.ok(previewLog, `expected a flush preview log, got: ${logs.join(' | ')}`);
    assert.match(previewLog, /x{200}\.\.\."/, 'preview must be cut at 200 chars and end with an ellipsis');
    assert.ok(!previewLog.includes('x'.repeat(201)), 'preview must not exceed 200 chars of text');
  });

  it('does not append an ellipsis for previews at or under 200 chars', () => {
    const logs: string[] = [];
    const savedError = console.error;
    console.error = (...args: unknown[]) => { logs.push(args.map(String).join(' ')); };
    try {
      const { watcher } = makeWatcher({ verbose: true });
      const w = internals(watcher);
      w.handleEvent(rawOutput('test-session', 'y'.repeat(120)));
      w.handleEvent(stateChange('test-session', 'working', 'idle'));
      watcher.stop();
    } finally {
      console.error = savedError;
    }

    const previewLog = logs.find(l => l.includes(': text: "'));
    assert.ok(previewLog, `expected a flush preview log, got: ${logs.join(' | ')}`);
    assert.match(previewLog, /y{120}"$/, 'short preview must be printed whole with no ellipsis');
  });
});

describe('live watch mode (stdin classification)', () => {
  it('start() wires a pluk watch handle and stop() releases it', async () => {
    const { watcher } = makeWatcher({ mode: 'watch' });
    await watcher.start();

    const w = watcher as unknown as {
      watchHandle: { stop: () => void } | null;
      subscriber: unknown;
    };
    assert.ok(w.watchHandle, 'expected a watch handle after start() in watch mode');
    assert.strictEqual(typeof w.watchHandle.stop, 'function');
    assert.strictEqual(w.subscriber, null);

    // stop() must not throw when releasing the readline-backed handle.
    watcher.stop();
  });
});
