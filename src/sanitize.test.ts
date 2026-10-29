import { describe, it } from 'node:test';
import assert from 'node:assert';
import { sanitizeForTerminal, stringifyForTerminal, stripTerminalEscapes } from './sanitize.js';

describe('sanitizeForTerminal', () => {
  it('strips ESC-based ANSI/CSI sequences', () => {
    const out = sanitizeForTerminal('\x1b[2J\x1b[H malicious \x1b[31mred\x1b[0m');
    assert.ok(!out.includes('\x1b'), 'ESC byte must be removed');
    assert.match(out, /malicious/);
    assert.match(out, /red/);
  });

  it('strips OSC sequences (e.g. window title / OSC 52 clipboard writes)', () => {
    const out = sanitizeForTerminal('\x1b]0;pwned\x07innocent text\x1b]52;c;ZGF0YQ==\x07');
    assert.ok(!out.includes('\x1b'));
    assert.ok(!out.includes('\x07'));
    assert.match(out, /innocent text/);
  });

  it('strips APC/PM strings whole (ESC _ / ESC ^, BEL or ST terminated)', () => {
    const out = sanitizeForTerminal('\x1b_payload\x07ok\x1b^secret\x1b\\');
    assert.ok(!out.includes('\x1b'));
    assert.ok(!out.includes('\x07'));
    assert.match(out, /ok/);
    assert.ok(!out.includes('payload'));
    assert.ok(!out.includes('secret'));
    // Parity with OSC: same input (different introducer) should produce same output
    assert.strictEqual(
      sanitizeForTerminal('\x1b_payload\x07'),
      sanitizeForTerminal('\x1b]0;payload\x07'),
    );
  });

  it('strips other C0 control characters and DEL/C1', () => {
    const out = sanitizeForTerminal('a\x00b\x01c\x08d\x0be\x0cf\x0dg\x7fh\x9fi');
    assert.strictEqual(out, 'a b c d e f g h i');
  });

  it('preserves newlines and tabs', () => {
    const out = sanitizeForTerminal('line one\nline\ttwo');
    assert.strictEqual(out, 'line one\nline\ttwo');
  });

  it('collapses runs of stripped characters and surrounding whitespace to a single space', () => {
    const out = sanitizeForTerminal('foo\x1b[31m\x1b[0mbar');
    assert.strictEqual(out, 'foo bar');
  });

  it('trims leading and trailing whitespace produced by stripping', () => {
    const out = sanitizeForTerminal('\x1b[31mhello\x1b[0m');
    assert.strictEqual(out, 'hello');
  });

  it('is a no-op for plain text', () => {
    assert.strictEqual(sanitizeForTerminal('plain excuse text'), 'plain excuse text');
  });
});

describe('sanitizeForTerminal string-control strips', () => {
  it('handles floods of unterminated OSC/APC/PM introducers quickly', () => {
    for (const intro of ['\x1b]', '\x1b_', '\x1b^']) {
      const start = Date.now();
      const out = sanitizeForTerminal(intro.repeat(20000) + 'tail');
      assert.ok(Date.now() - start < 500);
      assert.ok(out.endsWith('tail'));
      assert.ok(!out.includes('\x1b'));
    }
  });

  it('still consumes terminated strings whole', () => {
    assert.strictEqual(sanitizeForTerminal('a\x1b]0;title\x07b'), 'a b');
    assert.strictEqual(sanitizeForTerminal('a\x1b]0;title\x1b\\b'), 'a b');
    assert.strictEqual(sanitizeForTerminal('a\x1b_pay\x07b\x1b^pm\x1b\\c'), 'a b c');
  });

  it('consumes an unterminated introducer before a later terminated string', () => {
    assert.strictEqual(sanitizeForTerminal('\x1b]x\x1b]y\x07z'), 'z');
  });
});

// Each case below pins one recogniser in stripTerminalEscapes with an input
// only that recogniser consumes whole: if its pattern regresses, the generic
// two-byte ESC rule or the final control-char sweep still removes the ESC
// byte, but the sequence's payload or final byte leaks into the output.
describe('stripTerminalEscapes', () => {
  it('strips a DCS string with a multi-character body whole (ESC P ... ST)', () => {
    assert.strictEqual(stripTerminalEscapes('a\x1bPq#0;2;0;0;0#0~~\x1b\\b'), 'a b');
  });

  it('strips charset-designation sequences whole (ESC ( B, ESC ) 0)', () => {
    assert.strictEqual(stripTerminalEscapes('a\x1b(Bb'), 'a b');
    assert.strictEqual(stripTerminalEscapes('a\x1b)0b'), 'a b');
  });

  it('strips keypad-mode sequences whole (ESC =, ESC >)', () => {
    assert.strictEqual(stripTerminalEscapes('a\x1b=b\x1b>c'), 'a b c');
  });

  it('strips other two-byte ESC sequences whole (ESC M reverse index)', () => {
    assert.strictEqual(stripTerminalEscapes('a\x1bMb'), 'a b');
  });

  it('removes the final byte of Fs/Fp two-byte sequences (ESC c, ESC 7, ESC 8)', () => {
    assert.strictEqual(stripTerminalEscapes('a\x1bcb'), 'a b');
    assert.strictEqual(stripTerminalEscapes('a\x1b7b'), 'a b');
    assert.strictEqual(stripTerminalEscapes('a\x1b8b'), 'a b');
  });

  it('collapses a run of raw C0/C1 control bytes to one replacement', () => {
    assert.strictEqual(stripTerminalEscapes('a\x01\x02\x9b\x9dz'), 'a z');
  });

  it('defaults the replacement to a single space', () => {
    assert.strictEqual(stripTerminalEscapes('a\x01b'), 'a b');
    assert.strictEqual(stripTerminalEscapes('a\x01b', ''), 'ab');
  });
});

describe('stringifyForTerminal', () => {
  it('escapes DEL and C1 control code points that JSON.stringify leaves raw', () => {
    const out = stringifyForTerminal({ t: 'a\x7fb\x80c\x9bd\x9fe' });
    assert.ok(!/[\x7f-\x9f]/.test(out), 'no raw DEL/C1 code point may remain');
    assert.strictEqual(out, '{"t":"a\\u007fb\\u0080c\\u009bd\\u009fe"}');
  });

  it('round-trips to the same value and keeps C0/ESC escaped', () => {
    const value = { s: '\x1b]0;x\x07\x9b2J\x00plain\u2028', n: [1, null, true] };
    const out = stringifyForTerminal(value, 2);
    assert.ok(!out.includes('\x1b') && !out.includes('\x9b') && !out.includes('\x00'));
    assert.deepStrictEqual(JSON.parse(out), value);
  });

  it('honours the indent argument like JSON.stringify', () => {
    assert.strictEqual(stringifyForTerminal({ a: 1 }, 2), JSON.stringify({ a: 1 }, null, 2));
    assert.strictEqual(stringifyForTerminal([1, 2]), '[1,2]');
  });
});
