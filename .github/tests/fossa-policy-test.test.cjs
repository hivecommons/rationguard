// Run with: node --test .github/tests/fossa-policy-test.test.cjs
//
// fossa.yml's PR policy test must survive a base revision FOSSA has never
// seen (a push:main scan lost to infrastructure): it retries without --diff
// on FOSSA's "Revision … was not found" error and nothing else.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const yaml = readFileSync(join(__dirname, '../workflows/fossa.yml'), 'utf8');
// Comments explain why fossa-action's inputs are avoided; only real keys count.
const yamlWithoutComments = yaml.replace(/^\s*#.*$/gm, '');

test('fossa.yml policy test runs the CLI directly, not fossa-action run-tests', () => {
  assert.doesNotMatch(yamlWithoutComments, /run-tests:\s*true/, 'run-tests: true cannot fall back when the base revision is unknown');
  assert.doesNotMatch(yamlWithoutComments, /test-diff-revision:/);
  assert.match(yaml, /fossa test --project hivecommons\/rationguard --diff "\$BASE_SHA"/);
});

test('fossa.yml policy test falls back to a full test only on the unknown-revision error', () => {
  assert.match(yaml, /grep -q 'Revision for locator \.\* was not found' fossa-test\.log/);
  assert.match(yaml, /^\s+fossa test --project hivecommons\/rationguard\n/m, 'fallback runs fossa test without --diff');
  assert.match(yaml, /else\n\s+exit 1/, 'any other fossa test failure still fails the job');
});
