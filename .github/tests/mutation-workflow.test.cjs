// Run with: node --test .github/tests/mutation-workflow.test.cjs
//
// Contract between .github/workflows/mutation.yml, stryker.config.json and
// .github/scripts/mutation-summary.cjs. The three files name the same paths
// and budgets independently and nothing else checks they agree:
//   1. The cache step's `path` is the job's INCREMENTAL_FILE, every Stryker
//      step passes it as `--incrementalFile`, and `incremental` is on —
//      otherwise the restored cache is never read and every nightly starts
//      from zero (#347).
//   2. The cache `key` is per-shard and per-commit, and `restore-keys` fall
//      back to the same shard's prefix, so a new SHA still restores that
//      shard's previous results without reading another shard's file.
//   3. Every step `timeout-minutes` is below the job's, leaving room for the
//      Summary, sticky comment and artifact upload after a timed-out run.
//   4. The summary script's default report path lives inside the directory
//      the artifact step uploads, so a report the job summarises is also the
//      report it keeps.
//   5. Both Stryker output locations are git-ignored, so a local run cannot
//      commit a report or the incremental file.
//   6. The shard matrix mutates every non-test src file exactly once, so a
//      new source file cannot silently drop out of the nightly run (#400).
//   7. The nightly Stryker step passes --force and the pull-request step does
//      not: the command test runner cannot see test-file changes, so a nightly
//      that reuses the restored file reports last night's survivors verbatim,
//      while a PR run must reuse it to fit its budget (#431).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync, readdirSync } = require('node:fs');
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

// `- shard: <name>` / `files: <a,b>` pairs from the job's matrix include list.
function shards(head) {
  return [...head.matchAll(/^\s*- shard:\s*(\S+)\s*\n\s*files:\s*(\S+)/gm)]
    .map(m => ({ shard: m[1], files: m[2].split(',') }));
}

const BODY = jobBody();
const HEAD = BODY.split('\n    steps:\n')[0];
const STEPS = steps(BODY);
const INCREMENTAL_FILE = scalar(HEAD, 'INCREMENTAL_FILE');
const cacheStep = STEPS.find(s => /uses:\s*actions\/cache@/.test(s));
const uploadStep = STEPS.find(s => /uses:\s*actions\/upload-artifact@/.test(s) && scalar(s, 'path') === 'reports/mutation');
const strykerSteps = STEPS.filter(s => /npx stryker run/.test(s));
const summaryStep = STEPS.find(s => /test:mutation:summary/.test(s));

// --- 1. cache path is the incremental file ----------------------------------

test('stryker.config.json enables incremental mode with a file under reports/', () => {
  assert.equal(STRYKER.incremental, true, 'incremental must be on or the cached file is never read');
  assert.equal(typeof STRYKER.incrementalFile, 'string');
  assert.ok(!STRYKER.incrementalFile.startsWith('/'), 'incrementalFile must be repo-relative');
});

test('mutation.yml restores the cache at exactly the incrementalFile Stryker is given', () => {
  assert.ok(cacheStep, 'mutation job must have an actions/cache step');
  assert.ok(INCREMENTAL_FILE, 'mutation job must set INCREMENTAL_FILE');
  assert.match(INCREMENTAL_FILE, /\$\{\{\s*matrix\.shard\s*\}\}/, 'each shard needs its own incremental file');
  assert.equal(scalar(cacheStep, 'path'), INCREMENTAL_FILE);
  assert.ok(strykerSteps.length > 0, 'mutation job must run Stryker');
  for (const s of strykerSteps) assert.match(s, /--incrementalFile "\$INCREMENTAL_FILE"/, `Stryker step does not read the restored file:\n${s}`);
  assert.ok(STEPS.indexOf(cacheStep) < STEPS.indexOf(strykerSteps[0]), 'cache must be restored before Stryker runs');
});

// --- 2. per-commit key with a prefix fallback -------------------------------

test('cache key is per-shard and per-commit and restore-keys fall back to the shard prefix', () => {
  const key = scalar(cacheStep, 'key');
  assert.ok(key, 'cache step must declare a key');
  assert.match(key, /\$\{\{\s*github\.sha\s*\}\}$/, 'a fixed key would never save a newer incremental file');
  assert.match(key, /\$\{\{\s*matrix\.shard\s*\}\}/, 'shards sharing a key would restore one another\'s file');
  const prefix = key.replace(/\$\{\{\s*github\.sha\s*\}\}$/, '');
  assert.ok(/^[\w-]+-/.test(prefix), 'key must have a literal prefix for restore-keys to match');
  const fallbacks = restoreKeys(cacheStep);
  assert.ok(fallbacks.length > 0, 'without restore-keys a new commit never sees the previous run');
  assert.ok(fallbacks.includes(prefix), `restore-keys ${JSON.stringify(fallbacks)} must include the shard prefix ${JSON.stringify(prefix)}`);
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
  assert.match(scalar(summaryStep, 'if'), /^always\(\)/);
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
  assert.ok(covers(INCREMENTAL_FILE), `${INCREMENTAL_FILE} is not git-ignored`);
  assert.ok(covers(scalar(uploadStep, 'path')), `${scalar(uploadStep, 'path')} is not git-ignored`);
});

// --- 6. shards partition the mutated tree -----------------------------------

test('shard matrix mutates every non-test src/*.ts file exactly once', () => {
  const list = shards(HEAD);
  assert.ok(list.length > 1, 'mutation job must split the tree into a shard matrix');
  assert.equal(new Set(list.map(s => s.shard)).size, list.length, 'shard names must be unique');
  const sources = readdirSync(join(ROOT, 'src')).filter(f => f.endsWith('.ts') && !f.endsWith('.test.ts')).map(f => `src/${f}`).sort();
  const listed = list.flatMap(s => s.files);
  for (const f of listed) assert.ok(sources.includes(f), `shard file ${f} is not a non-test src/*.ts file`);
  assert.equal(new Set(listed).size, listed.length, `a file is listed in two shards: ${listed}`);
  assert.deepEqual([...listed].sort(), sources, 'every non-test src/*.ts file must belong to a shard');
});

// --- 7. nightly remeasures, pull requests reuse ------------------------------

test('nightly Stryker step passes --force and the pull-request step does not', () => {
  const isPullRequest = s => /github\.event_name\s*==\s*'pull_request\b/.test(scalar(s, 'if') ?? '');
  const isNightly = s => /github\.event_name\s*!=\s*'pull_request\b/.test(scalar(s, 'if') ?? '');
  const nightly = strykerSteps.filter(isNightly);
  const pullRequest = strykerSteps.filter(isPullRequest);
  assert.equal(nightly.length, 1, 'exactly one Stryker step must run on the nightly schedule');
  assert.equal(pullRequest.length, 1, 'exactly one Stryker step must run on pull requests');
  assert.equal(nightly.length + pullRequest.length, strykerSteps.length, 'every Stryker step must be gated on the event name');
  const force = /npx stryker run\b[^\n]*\s--force(?:\s|$)/;
  assert.match(scalar(nightly[0], 'run'), force, 'without --force the nightly reuses the restored incremental file and never remeasures a survivor a new test now kills');
  assert.doesNotMatch(scalar(pullRequest[0], 'run'), force, 'a forced pull-request run cannot reuse the nightly seed and blows its budget');
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

test('shards() reads the matrix include shape mutation.yml uses', () => {
  const head = [
    '    strategy:',
    '      matrix:',
    '        include:',
    '          - shard: a',
    '            files: src/a.ts',
    '          - shard: b',
    '            files: src/b.ts,src/c.ts',
    '    env:',
  ].join('\n');
  assert.deepEqual(shards(head), [
    { shard: 'a', files: ['src/a.ts'] },
    { shard: 'b', files: ['src/b.ts', 'src/c.ts'] },
  ]);
});
