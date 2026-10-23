// Run with: node --test .github/tests/mutation-summary.test.cjs
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, writeFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { spawnSync } = require('node:child_process');
const { MARKER, score, render } = require('../scripts/mutation-summary.cjs');

const SCRIPT = join(__dirname, '../scripts/mutation-summary.cjs');

const mutant = (status, line, extra = {}) => ({
  id: `${status}-${line}`,
  mutatorName: 'ConditionalExpression',
  status,
  replacement: 'true',
  location: { start: { line, column: 1 }, end: { line, column: 5 } },
  ...extra,
});

const REPORT = {
  schemaVersion: '2',
  thresholds: { high: 80, low: 60 },
  files: {
    'src/watcher.ts': { language: 'typescript', source: '', mutants: [mutant('Killed', 3), mutant('Survived', 9), mutant('NoCoverage', 4), mutant('Timeout', 1)] },
    'src/checker.ts': { language: 'typescript', source: '', mutants: [mutant('Killed', 2), mutant('CompileError', 5), mutant('Ignored', 6)] },
  },
};

function run(...args) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });
}

test('score counts Killed/Timeout as detected and Survived/NoCoverage as undetected', () => {
  assert.deepEqual(score(REPORT.files['src/watcher.ts'].mutants), { detected: 2, undetected: 2, valid: 4, score: 50 });
  assert.deepEqual(score(REPORT.files['src/checker.ts'].mutants), { detected: 1, undetected: 0, valid: 1, score: 100 });
  assert.equal(score([mutant('CompileError', 1)]).score, null);
});

test('render reports the overall score, a per-file table and surviving mutants', () => {
  const md = render(REPORT);
  assert.ok(md.startsWith(`${MARKER}\n`), 'sticky-comment marker must be the first line');
  assert.match(md, /\*\*Mutation score: 60\.00%\*\* \(3 detected \/ 5 valid mutants\)/);
  assert.match(md, /never fails CI/);
  assert.match(md, /\| `src\/checker\.ts` \| 100\.00% \| 1 \| 0 \| 0 \|/);
  assert.match(md, /\| `src\/watcher\.ts` \| 50\.00% \| 2 \| 1 \| 1 \|/);
  assert.ok(md.indexOf('src/checker.ts') < md.indexOf('src/watcher.ts'), 'files are sorted');
  assert.match(md, /<code>src\/watcher\.ts<\/code> \(2\)/);
  assert.doesNotMatch(md, /<code>src\/checker\.ts<\/code>/);
  assert.ok(md.indexOf('- L4 ConditionalExpression (NoCoverage)') < md.indexOf('- L9 ConditionalExpression (Survived)'), 'survivors sorted by line');
});

test('render truncates survivors per file and escapes table/code characters', () => {
  const mutants = [1, 2, 3].map(line => mutant('Survived', line, { replacement: 'a | `b`\n c' }));
  const md = render({ files: { 'src/x.ts': { mutants } } }, 2);
  assert.match(md, /- L1 ConditionalExpression \(Survived\): `a \\\| 'b' c`/);
  assert.doesNotMatch(md, /- L3 /);
  assert.match(md, /…and 1 more/);
});

test('render handles a report with no mutated files', () => {
  const md = render({ files: {} });
  assert.match(md, /Mutation score: n\/a/);
  assert.match(md, /No files were mutated\./);
});

test('CLI renders a report file and exits 0 when it is missing or malformed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mutation-summary-test-'));
  try {
    const good = join(dir, 'mutation.json');
    writeFileSync(good, JSON.stringify(REPORT));
    let res = run(good);
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /Mutation score: 60\.00%/);

    res = run(join(dir, 'missing.json'));
    assert.equal(res.status, 0, res.stderr);
    assert.ok(res.stdout.startsWith(MARKER));
    assert.match(res.stdout, /No mutation report found/);

    const bad = join(dir, 'bad.json');
    writeFileSync(bad, '{not json');
    res = run(bad);
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /Could not parse/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
