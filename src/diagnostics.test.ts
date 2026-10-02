// Tests for the opt-in, local-only `--diagnostics` summary (mirrors
// @hivecommons/pluk's startDiagnostics, hivecommons/pluk#102).
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { startDiagnostics } from './diagnostics.js';

const settle = (ms = 60): Promise<void> => new Promise(r => setTimeout(r, ms));

describe('startDiagnostics', () => {
  it('is a no-op without the flag', () => {
    const lines: string[] = [];
    const stop = startDiagnostics('watch', () => ({ a: 1 }), undefined, l => lines.push(l));
    stop();
    assert.deepEqual(lines, []);
  });

  it('writes periodic and final JSON lines with fixed keys only', async () => {
    const lines: string[] = [];
    let n = 0;
    const stop = startDiagnostics('watch', () => ({ flushCount: ++n }), '0.02', l => lines.push(l));
    await settle(70);
    stop();
    stop(); // idempotent
    assert.ok(lines.length >= 2, `expected periodic + final, got ${lines.length}`);
    const parsed = lines.map(l => JSON.parse(l));
    for (const p of parsed) {
      assert.equal(p.rationguard_diagnostics, 1);
      assert.equal(p.command, 'watch');
      assert.equal(typeof p.uptime_s, 'number');
      assert.deepEqual(Object.keys(p).sort(), ['command', 'final', 'flushCount', 'rationguard_diagnostics', 'uptime_s']);
    }
    assert.equal(parsed.at(-1).final, true);
    assert.ok(parsed.slice(0, -1).every(p => p.final === false));
  });

  it('falls back to the default period for a bad value and survives a throwing writer', async () => {
    const lines: string[] = [];
    const stop = startDiagnostics('watch', () => ({ x: 1 }), 'nope', l => { lines.push(l); throw new Error('stderr gone'); });
    await settle(30);
    stop();
    assert.equal(lines.length, 1, 'bad period means no periodic line within 30ms, only the final one');
  });

  it('never includes a session name or raw output', async () => {
    const lines: string[] = [];
    const stop = startDiagnostics('watch', () => ({ flushCount: 3, matchCount: 1 }), '0.02', l => lines.push(l));
    await settle(30);
    stop();
    assert.ok(lines.length >= 1);
    for (const l of lines) {
      assert.ok(!l.includes('session'), `unexpected session-like field in: ${l}`);
    }
  });
});
