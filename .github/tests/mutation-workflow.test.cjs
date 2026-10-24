// Run with: node --test .github/tests/mutation-workflow.test.cjs
//
// Contract between .github/workflows/mutation.yml, stryker.config.json and
// .github/scripts/mutation-summary.cjs. The three files name the same paths
// and budgets independently and nothing else checks they agree:
//   1. The cache step's `path` is Stryker's `incrementalFile`, and
//      `incremental` is on — otherwise the restored cache is never read and
//      every nightly starts from zero (#347).
//   2. The cache `key` is per-commit and `restore-keys` fall back to the same
//      prefix, so a new SHA still restores the previous run's results.
//   3. Every step `timeout-minutes` is below the job's, leaving room for the
//      Summary, sticky comment and artifact upload after a timed-out run.
//   4. The summary script's default report path lives inside the directory
//      the artifact step uploads, so a report the job summarises is also the
//      report it keeps.
//   5. Both Stryker output locations are git-ignored, so a local run cannot
//      commit a report or the incremental file.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join, dirname, relative, sep } = require('node:path');

const ROOT = join(__dirname, '../..');
const WORKFLOW = readFileSync(join(ROOT, '.github/workflows/mutation.yml'), 'utf8');
const STRYKER = JSON.parse(readFileSync(join(ROOT, 'stryker.config.json'), 'utf8'));
const SUMMARY = readFileSync(join(ROOT, '.github/scripts/mutation-summary.cjs'), 'utf8');
const GITIGNORE = readFileSync(join(ROOT, '.gitignore'), 'utf8');

// --- parsing -----------------------------------------------------------------

// The `mutation` job body, split into `steps:` entries. Each step is the text
// from its `- ` line up to the next one at the same indent.
function jobBody() {
  const start = WORKFLOW.indexOf('\n  mutation:\n');
  assert.ok(start >= 0, 'mutation.yml must define a `mutation` job');
  const rest = WORKFLOW.slice(start + '\n  mutation:\n'.length);
  const end = rest.search(/\n {2}\S/);
  return end < 0 ? rest : rest.slice(0, end);
}

function steps(body) {
  const idx = body.indexOf('\n    steps:\n');
  assert.ok(idx >= 0, 'mutation job must declare steps');
  const text = body.slice(idx + '\n    steps:\n'.length);
  const out = text.split(/\n(?= {6}- )/).map(s => s.replace(/^\s*\n/, ''));
  assert.ok(out.length > 0, 'mutation job must have at least one step');
  return out;
}

function scalar(text, key) {
  const m = new RegExp(`^\\s*${key}:[ \\t]*(.*?)\\s*(?:#.*)?$`, 'm').exec(text);
  return m ? m[1].replace(/^["']|["']$/g, '') : undefined;
}

// `restore-keys: |` block scalar as a list of trimmed lines.
function restoreKeys(text) {
  const m = /^\s*restore-keys:\s*\|\s*\n((?:\s{12,}.*\n?)+)/m.exec(text);
  return m ? m[1].split('\n').map(l => l.trim()).filter(Boolean) : [];
}

const BODY = jobBody();
const STEPS = steps(BODY);
const cacheStep = STEPS.find(s => /uses:\s*actions\/cache@/.test(s));
const uploadStep = STEPS.find(s => /uses:\s*actions\/upload-artifact@/.test(s));
const strykerSteps = STEPS.filter(s => /npx stryker run/.test(s));
const summaryStep = STEPS.find(s => /test:mutation:summary/.test(s));

// --- 1. cache path is the incremental file ----------------------------------

test('stryker.config.json enables incremental mode with a file under reports/', () => {
  assert.equal(STRYKER.incremental, true, 'incremental must be on or the cached file is never read');
  assert.equal(typeof STRYKER.incrementalFile, 'string');
  assert.ok(!STRYKER.incrementalFile.startsWith('/'), 'incrementalFile must be repo-relative');
});

test('mutation.yml restores the cache at exactly the configured incrementalFile', () => {
  assert.ok(cacheStep, 'mutation job must have an actions/cache step');
  assert.equal(scalar(cacheStep, 'path'), STRYKER.incrementalFile);
  assert.ok(STEPS.indexOf(cacheStep) < STEPS.indexOf(strykerSteps[0]), 'cache must be restored before Stryker runs');
});

// --- 2. per-commit key with a prefix fallback -------------------------------

test('cache key is per-commit and restore-keys fall back to its prefix', () => {
  const key = scalar(cacheStep, 'key');
  assert.ok(key, 'cache step must declare a key');
  assert.match(key, /\$\{\{\s*github\.sha\s*\}\}/, 'a fixed key would never save a newer incremental file');
  const prefix = key.slice(0, key.indexOf('${{'));
  assert.ok(prefix.length > 0, 'key must have a literal prefix for restore-keys to match');
  const fallbacks = restoreKeys(cacheStep);
  assert.ok(fallbacks.length > 0, 'without restore-keys a new commit never sees the previous run');
  assert.ok(fallbacks.some(k => k === prefix || k === prefix.replace(/-$/, '')), `restore-keys ${JSON.stringify(fallbacks)} must include the key prefix ${JSON.stringify(prefix)}`);
});

// --- 3. step budgets sit inside the job budget ------------------------------

test('every step timeout is below the job timeout so reporting still runs', () => {
  const job = Number(scalar(BODY.split('\n    steps:\n')[0], 'timeout-minutes'));
  assert.ok(Number.isInteger(job) && job > 0, 'job must declare timeout-minutes');
  const budgets = STEPS.map(s => scalar(s, 'timeout-minutes')).filter(v => v !== undefined).map(Number);
  assert.ok(budgets.length >= strykerSteps.length, 'each Stryker step must carry its own timeout-minutes');
  for (const s of strykerSteps) assert.ok(scalar(s, 'timeout-minutes'), `Stryker step lacks timeout-minutes:\n${s}`);
  for (const b of budgets) assert.ok(b < job, `step timeout ${b} must be below job timeout ${job}`);
  assert.ok(Math.max(...budgets) <= job - 15, `largest step budget ${Math.max(...budgets)} leaves under 15 minutes of ${job} for summary and upload`);
});

test('Stryker steps continue-on-error and the summary runs on always()', () => {
  for (const s of strykerSteps) assert.equal(scalar(s, 'continue-on-error'), 'true', `Stryker step must not fail the job:\n${s}`);
  assert.ok(summaryStep, 'mutation job must run test:mutation:summary');
  assert.equal(scalar(summaryStep, 'if'), 'always()');
  assert.equal(scalar(uploadStep, 'if'), 'always()');
});

// --- 4. summary default report is inside the uploaded artifact ------------

test('summary script default report path is inside the uploaded artifact directory', () => {
  const m = /argv\[0\]\s*\|\|\s*'([^']+)'/.exec(SUMMARY);
  assert.ok(m, 'mutation-summary.cjs must have a default report path');
  const report = m[1];
  assert.ok(uploadStep, 'mutation job must upload the report');
  const uploaded = scalar(uploadStep, 'path');
  const rel = relative(uploaded, report);
  assert.ok(rel && !rel.startsWith('..') && !rel.includes(sep + '..'), `${report} is not under uploaded ${uploaded}`);
  assert.equal(scalar(uploadStep, 'if-no-files-found'), 'ignore', 'a timed-out run has no report; upload must not fail the job');
  const summaryRun = scalar(summaryStep, 'run');
  assert.ok(summaryRun && !/mutation\.json/.test(summaryRun), 'summary step must rely on the script default, not restate the path');
});

// --- 5. nothing Stryker writes is committable --------------------------------

test('.gitignore covers both the incremental file and the report directory', () => {
  const rules = GITIGNORE.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#')).map(l => l.replace(/\/$/, ''));
  const covers = p => {
    for (let dir = p; dir && dir !== '.'; dir = dirname(dir)) if (rules.includes(dir)) return true;
    return rules.includes(p);
  };
  assert.ok(covers(STRYKER.incrementalFile), `${STRYKER.incrementalFile} is not git-ignored`);
  assert.ok(covers(scalar(uploadStep, 'path')), `${scalar(uploadStep, 'path')} is not git-ignored`);
});

// --- fixture self-test -------------------------------------------------------

test('scalar() and restoreKeys() read the shapes mutation.yml uses', () => {
  const step = [
    '      - name: Restore',
    '        uses: actions/cache@abc # v4',
    '        with:',
    '          path: reports/x.json',
    '          key: pre-${{ github.sha }}',
    '          restore-keys: |',
    '            pre-',
    '            other-',
    '      - run: next',
  ].join('\n');
  assert.equal(scalar(step, 'path'), 'reports/x.json');
  assert.equal(scalar(step, 'key'), 'pre-${{ github.sha }}');
  assert.deepEqual(restoreKeys(step), ['pre-', 'other-']);
  assert.equal(scalar(step, 'missing'), undefined);
});
