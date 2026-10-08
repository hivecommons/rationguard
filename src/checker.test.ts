import { describe, it } from 'node:test';
import assert from 'node:assert';
import { check, generatePromptBlock } from './checker.js';
import { DEFAULT_EXCUSES } from './defaults.js';

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

  // The CLI's colour tiers (cli.ts colorConfidence) assume the matcher's
  // confidence floor. Pin that floor so a change to KEYWORD_WEIGHT or
  // MIN_KEYWORD_CONFIDENCE has to revisit the tiers deliberately.
  it('folds curly apostrophes into ASCII before matching', () => {
    const result = check('that is another agent/team\u2019s job');
    assert.strictEqual(result.matches[0]?.confidence, 1.0);
  });

  describe('confidence floor', () => {
    // 1 * KEYWORD_WEIGHT + MIN_KEYWORD_CONFIDENCE; 0.15 + 0.3 is
    // 0.44999999999999996 in IEEE doubles, so compare with a tolerance.
    const SINGLE_HIT_FLOOR = 0.45;
    const EPSILON = 1e-9;
    const atLeastFloor = (c: number): boolean => c >= SINGLE_HIT_FLOOR - EPSILON;

    it('a single keyword hit on a custom excuse scores exactly the floor', () => {
      const excuse = {
        pattern: 'zzqx-never-literally-present',
        rebuttal: 'Do it.',
        category: 'deferral' as const,
        keywords: ['unicornfeather'],
      };
      const result = check('There is a unicornfeather on the desk.', { excuses: [excuse] });
      assert.strictEqual(result.matches.length, 1);
      assert.strictEqual(result.matches[0].matched, true);
      assert.ok(Math.abs(result.matches[0].confidence - SINGLE_HIT_FLOOR) < EPSILON, String(result.matches[0].confidence));
    });

    it('every default keyword scored in isolation yields confidence >= floor', () => {
      let scored = 0;
      for (const excuse of DEFAULT_EXCUSES) {
        for (const kw of excuse.keywords) {
          const result = check(kw);
          for (const m of result.matches) {
            scored++;
            assert.strictEqual(m.matched, true, `${JSON.stringify(kw)} -> ${m.excuse?.pattern}`);
            assert.ok(
              atLeastFloor(m.confidence),
              `${JSON.stringify(kw)} matched ${m.excuse?.pattern} at ${m.confidence} < ${SINGLE_HIT_FLOOR}`,
            );
            assert.ok(m.confidence <= 1, `${JSON.stringify(kw)} confidence ${m.confidence} > 1`);
          }
        }
      }
      assert.ok(scored > 0, 'expected at least one default keyword to match itself');
    });

    it('never returns a sub-floor or unmatched entry in matches', () => {
      const inputs = [
        'Standing by for further instructions.',
        'This issue is too complex to fix autonomously.',
        'I will address this in the next iteration.',
        'Opened PR #12 with the fix and tests.',
      ];
      for (const input of inputs) {
        for (const m of check(input).matches) {
          assert.strictEqual(m.matched, true);
          assert.ok(m.excuse !== null);
          assert.ok(atLeastFloor(m.confidence), `${input}: ${m.confidence}`);
        }
      }
    });
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
