import { describe, it } from 'node:test';
import assert from 'node:assert';
import { check, generatePromptBlock } from './checker.js';

describe('check', () => {
  it('detects false completion - standing by', () => {
    const result = check('Standing by for further instructions.');
    assert.strictEqual(result.clean, false);
    assert.ok(result.matches.length > 0);
    assert.strictEqual(result.matches[0].excuse?.category, 'false-completion');
  });

  it('detects false completion - all done', () => {
    const result = check('Everything is complete, no remaining tasks.');
    assert.strictEqual(result.clean, false);
    const categories = result.matches.map(m => m.excuse?.category);
    assert.ok(categories.includes('false-completion'));
  });

  it('detects complexity dodge', () => {
    const result = check('This issue is too complex to fix autonomously.');
    assert.strictEqual(result.clean, false);
    const categories = result.matches.map(m => m.excuse?.category);
    assert.ok(categories.includes('complexity-dodge'));
  });

  it('detects deferral', () => {
    const result = check('I will address this in the next iteration.');
    assert.strictEqual(result.clean, false);
    const categories = result.matches.map(m => m.excuse?.category);
    assert.ok(categories.includes('deferral'));
  });

  it('detects lane confusion', () => {
    const result = check('That is not my job, another agent should handle it.');
    assert.strictEqual(result.clean, false);
    const categories = result.matches.map(m => m.excuse?.category);
    assert.ok(categories.includes('lane-confusion'));
  });

  it('detects partial credit', () => {
    const result = check('I made progress on the fix and started working on it.');
    assert.strictEqual(result.clean, false);
    const categories = result.matches.map(m => m.excuse?.category);
    assert.ok(categories.includes('partial-credit'));
  });

  it('passes clean text', () => {
    const result = check('Fixed the bug in auth.go by adding null check on line 42. PR #123 opened.');
    assert.strictEqual(result.clean, true);
    assert.strictEqual(result.matches.length, 0);
  });

  it('detects multiple patterns in one text', () => {
    const result = check('All checks pass and everything passes. I will defer this to the next iteration and handle it later.');
    assert.strictEqual(result.clean, false);
    assert.ok(result.matches.length >= 2, `Expected >= 2 matches, got ${result.matches.length}`);
  });

  it('returns matches sorted by confidence descending', () => {
    const result = check('Standing by for work orders. Nothing to do. Idle and waiting for instructions.');
    assert.strictEqual(result.clean, false);
    for (let i = 1; i < result.matches.length; i++) {
      assert.ok(result.matches[i - 1].confidence >= result.matches[i].confidence);
    }
  });

  it('accepts custom excuse config', () => {
    const result = check('Synergizing the deliverables', {
      excuses: [{
        pattern: 'synergizing',
        rebuttal: 'That is not a real action. State what you actually did.',
        category: 'false-completion',
        keywords: ['synergizing', 'synergy'],
      }],
    });
    assert.strictEqual(result.clean, false);
    assert.strictEqual(result.matches[0].excuse?.pattern, 'synergizing');
  });

  it('does not match every input when a keyword reduces to nothing but filler', () => {
    // promoteToExcuse derives keywords from sighting text with a length>3
    // filter, so "will address" yields ['will', 'address']; 'will' is a
    // filler word that reduceText strips to ''.
    const promoted = {
      pattern: 'will address',
      rebuttal: 'Act now.',
      category: 'deferral' as const,
      keywords: ['will', 'address', '', '   ', 'just should'],
    };
    const clean = check('Opened PR #12 with the fix and tests.', { excuses: [promoted] });
    assert.strictEqual(clean.clean, true, `unexpected matches: ${JSON.stringify(clean.matches)}`);

    const hit = check('I will address that in a follow-up.', { excuses: [promoted] });
    assert.strictEqual(hit.clean, false);
    assert.strictEqual(hit.matches[0].matchedText, 'will address');
  });
});

describe('generatePromptBlock', () => {
  it('generates a markdown table', () => {
    const block = generatePromptBlock();
    assert.ok(block.includes('Rationalization Defense'));
    assert.ok(block.includes('| Excuse Pattern | Rebuttal |'));
    assert.ok(block.includes('standing by'));
  });

  it('includes custom excuses when provided', () => {
    const block = generatePromptBlock({
      excuses: [{
        pattern: 'custom excuse',
        rebuttal: 'custom rebuttal',
        category: 'deferral',
        keywords: ['custom'],
      }],
    });
    assert.ok(block.includes('custom excuse'));
    assert.ok(block.includes('custom rebuttal'));
  });
});
