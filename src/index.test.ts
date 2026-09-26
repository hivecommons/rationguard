import { describe, it } from 'node:test';
import assert from 'node:assert';

// The package entry (`main: dist/index.js`) is what library consumers import,
// yet nothing else in the suite ever loads it — a typo'd re-export or a
// removed name would compile fine and only break downstream. This test pins
// the public API surface by importing through index.js exactly as a consumer
// would, and smoke-checks each value export through that entry.
import * as api from './index.js';
import type { CheckResult, Excuse } from './index.js';

describe('public API surface (index.js)', () => {
  it('re-exports every documented value with the expected shape', () => {
    assert.strictEqual(typeof api.check, 'function');
    assert.strictEqual(typeof api.generatePromptBlock, 'function');
    assert.strictEqual(typeof api.recordSighting, 'function');
    assert.strictEqual(typeof api.loadCustomExcuses, 'function');
    assert.strictEqual(typeof api.listSightings, 'function');
    assert.strictEqual(typeof api.Watcher, 'function');
    assert.strictEqual(typeof api.createWatcher, 'function');
    assert.ok(Array.isArray(api.DEFAULT_EXCUSES));
    assert.strictEqual(typeof api.CATEGORY_LABELS, 'object');
  });

  it('exports no unexpected names (additions must be deliberate)', () => {
    const expected = [
      'CATEGORY_LABELS',
      'DEFAULT_EXCUSES',
      'Watcher',
      'check',
      'createWatcher',
      'generatePromptBlock',
      'listSightings',
      'loadCustomExcuses',
      'recordSighting',
    ];
    assert.deepStrictEqual(Object.keys(api).sort(), expected);
  });

  it('check() works through the package entry', () => {
    const dirty: CheckResult = api.check('no work found');
    assert.strictEqual(dirty.clean, false);
    assert.ok(dirty.matches.some(m => m.excuse?.pattern === 'no work found'));

    const clean: CheckResult = api.check('purple elephants dance gracefully');
    assert.strictEqual(clean.clean, true);
    assert.deepStrictEqual(clean.matches, []);
  });

  it('generatePromptBlock() works through the package entry', () => {
    const block = api.generatePromptBlock();
    assert.match(block, /## Rationalization Defense — Known Excuses/);
    assert.match(block, /no work found/);
  });

  it('every DEFAULT_EXCUSES entry is well-formed and labeled', () => {
    assert.ok(api.DEFAULT_EXCUSES.length > 0);
    for (const excuse of api.DEFAULT_EXCUSES as Excuse[]) {
      assert.strictEqual(typeof excuse.pattern, 'string');
      assert.ok(excuse.pattern.length > 0);
      assert.strictEqual(typeof excuse.rebuttal, 'string');
      assert.ok(excuse.rebuttal.length > 0);
      assert.ok(Array.isArray(excuse.keywords));
      // Every category used by a built-in excuse must have a display label,
      // or the CLI's grouped `list` output renders an undefined heading.
      assert.ok(
        excuse.category in api.CATEGORY_LABELS,
        `category ${excuse.category} of "${excuse.pattern}" has no CATEGORY_LABELS entry`,
      );
    }
  });

  it('createWatcher() returns a Watcher through the package entry', () => {
    const watcher = api.createWatcher({ session: 'index-surface-test', mode: 'subscribe' });
    assert.ok(watcher instanceof api.Watcher);
  });
});
