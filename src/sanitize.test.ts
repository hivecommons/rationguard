import { describe, it } from 'node:test';
import assert from 'node:assert';
import { sanitizeForTerminal } from './sanitize.js';

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
