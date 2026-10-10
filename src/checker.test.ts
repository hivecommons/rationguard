import { describe, it } from 'node:test';
import assert from 'node:assert';
import { check, generatePromptBlock } from './checker.js';
import { DEFAULT_EXCUSES } from './defaults.js';

describe('check', () => {
  it('does not match keywords inside longer words', () => {
    assert.strictEqual(check('The belated release was fine.').clean, true);
  });

  it('still matches inflected forms of short keywords', () => {
    assert.strictEqual(check('I deferred it.').clean, false);
    assert.strictEqual(check('We are deferring this to the next cycle.').clean, false);
    assert.strictEqual(check('I postponed it.').clean, false);
    assert.strictEqual(check('I am postponing it.').clean, false);
  });

  // #205: the stemmer must land the text and the keyword on the same form
  // for silent-e verbs (idle, circle, file, table, move), doubled consonants
  // (log/logged), "ss" endings (address) and short stems (need/needs).
  describe('stems silent-e, doubled-consonant and base forms to the keyword', () => {
    const cases: Array<[input: string, category: string, keyword: string]> = [
      ['I idled all morning.', 'false-completion', 'idle'],
      ['I addressed it.', 'deferral', 'will address'],
      ['I am addressing it.', 'deferral', 'will address'],
      ['I addressed some of the findings.', 'partial-credit', 'addresses some'],
      ['I am addressing some of them.', 'partial-credit', 'addresses some'],
      ['I need approval first.', 'complexity-dodge', 'needs approval'],
      ['I will file an issue.', 'deferral', 'filed an issue'],
      ['I will create an issue.', 'deferral', 'created an issue'],
      ['I will log it.', 'deferral', 'logged it'],
      ['I circled back to it.', 'deferral', 'circle back'],
      ['I am circling back to it.', 'deferral', 'circle back'],
      ['We are moving on.', 'false-completion', 'move on'],
      ['I moved on.', 'false-completion', 'move on'],
      ['I tabled this for now.', 'deferral', 'table this'],
      ['We are making progress.', 'partial-credit', 'making progress'],
      ['I am coming back to it.', 'deferral', 'coming back to'],
    ];

    for (const [input, category, keyword] of cases) {
      it(`${JSON.stringify(input)} hits ${JSON.stringify(keyword)} (${category})`, () => {
        const result = check(input);
        assert.strictEqual(result.clean, false, `expected a match for ${JSON.stringify(input)}`);
        const hit = result.matches.find(m => m.excuse?.category === category && m.excuse.keywords.includes(keyword));
        assert.ok(hit, `expected a ${category} match via keyword ${JSON.stringify(keyword)}; got ${JSON.stringify(result.matches.map(m => [m.excuse?.category, m.matchedText]))}`);
      });
    }
  });

  it('a stem that is too short is left alone', () => {
    // "scoped"/"stated"/"fined" must not collapse onto unrelated keywords
    // ("fine" in "seems fine", "later"), and words whose stem would be under
    // three letters keep their suffix ("need" is not "ne" + "ed").
    assert.strictEqual(check('The change was scoped, stated and fined.').clean, true);
    assert.strictEqual(check('I needed nothing from anyone.').clean, true);
  });

  // #200 moved keyword matching to word boundaries, so an inflected word only
  // hits when reduceText() stems the text and the keyword to the same form.
  // Pin the inflections that work today for every excuse category, so the next
  // change to normalizeText/reduceText/containsKeyword cannot silently regress
  // them the way #200 regressed "deferred"/"postponed" (#203).
  describe('inflected keyword forms reduce to the keyword', () => {
    const cases: Array<[input: string, category: string, keyword: string]> = [
      ['Tests passed on CI.', 'false-completion', 'tests pass'],
      ['All checks passed.', 'false-completion', 'checks pass'],
      ['I am finishing everything.', 'false-completion', 'finished everything'],
      ['Completing all of them.', 'false-completion', 'completed all'],
      ['Idles happen.', 'false-completion', 'idle'],
      ['I needed approval first.', 'complexity-dodge', 'needs approval'],
      ['It requires reviewing.', 'complexity-dodge', 'requires review'],
      ['I revisited it yesterday.', 'deferral', 'revisit'],
      ['Revisits are planned.', 'deferral', 'revisit'],
      ['It defers to the next owner.', 'deferral', 'defer'],
      ['I am opening a ticket.', 'deferral', 'opened a ticket'],
      ['I am creating an issue.', 'deferral', 'created an issue'],
      ['I am filing an issue.', 'deferral', 'filed an issue'],
      ['I am logging it.', 'deferral', 'logged it'],
      ['It is blocking on review.', 'deferral', 'blocked on'],
      ['I am starting work on it.', 'partial-credit', 'started working'],
      ['It seemed fine to me.', 'partial-credit', 'seems fine'],
      ['It looked ok.', 'partial-credit', 'looks ok'],
      ['It appeared to be correct.', 'partial-credit', 'appears to be'],
    ];

    for (const [input, category, keyword] of cases) {
      it(`${JSON.stringify(input)} hits ${JSON.stringify(keyword)} (${category})`, () => {
        const result = check(input);
        assert.strictEqual(result.clean, false, `expected a match for ${JSON.stringify(input)}`);
        const hit = result.matches.find(m => m.excuse?.category === category && m.excuse.keywords.includes(keyword));
        assert.ok(hit, `expected a ${category} match via keyword ${JSON.stringify(keyword)}; got ${JSON.stringify(result.matches.map(m => [m.excuse?.category, m.matchedText]))}`);
      });
    }
  });

  it('a keyword hit reached only through the reduced text scores like a direct hit', () => {
    // "revisited" is not a substring of the normalized text's keyword list;
    // it is found only because reduceText() strips "-ed". Its confidence must
    // still be the single-keyword floor rather than 0 or an exact-match 1.0.
    const result = check('I revisited it yesterday.');
    assert.strictEqual(result.matches.length, 1);
    assert.strictEqual(result.matches[0].matchedText, 'revisit');
    // 0.15 + 0.3 is 0.44999999999999996 in IEEE doubles.
    assert.ok(Math.abs(result.matches[0].confidence - 0.45) < 1e-9, String(result.matches[0].confidence));
  });

  it('does not flag JS await in code', () => {
    assert.strictEqual(check('const res = await fetch(url);').clean, true);
  });

  it('still matches keywords next to punctuation', () => {
    assert.strictEqual(check('Let me revisit, later.').clean, false);
  });

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

  it('does not exact-match a pattern inside a longer word', () => {
    const excuse = {
      pattern: 'later',
      rebuttal: 'Do it now.',
      category: 'deferral' as const,
      keywords: [],
    };
    assert.strictEqual(check('the report was belated', { excuses: [excuse] }).clean, true);
    const hit = check('Fine, later.', { excuses: [excuse] });
    assert.strictEqual(hit.matches[0].confidence, 1);
  });

  it('exact-matches a multi-word pattern surrounded by punctuation', () => {
    const excuse = {
      pattern: 'out of scope',
      rebuttal: 'Do it now.',
      category: 'deferral' as const,
      keywords: [],
    };
    assert.strictEqual(check('That is (out of scope), sorry.', { excuses: [excuse] }).clean, false);
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
