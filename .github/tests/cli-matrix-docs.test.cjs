// Run with: node --test .github/tests/cli-matrix-docs.test.cjs
//
// Two documents describe the per-CLI surface in prose and tables rather than
// as `rationguard <cmd> --flag` invocations, so docs-cli-surface.test.cjs
// never sees them: the "Supported-CLI matrix" in ROADMAP.md (which the 1.0
// CLI-coverage criterion is measured against) and the `--dangerous` table in
// README.md. The `--cli` values come from the HELP text in src/cli.ts, the
// same source issue-forms.test.cjs pins the issue-form dropdown to; the
// `--dangerous` mapping is pluk's, not ours — `attach` passes the flag
// straight through — so the README table is pinned to the installed
// @hivecommons/pluk rather than to a third hand-maintained copy. A pluk bump
// that changes a mapping then fails here with the row to update, instead of
// leaving the README describing a flag that is no longer applied.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const repoRoot = join(__dirname, '../..');
const CLI_SRC = readFileSync(join(repoRoot, 'src/cli.ts'), 'utf8');
const README = readFileSync(join(repoRoot, 'README.md'), 'utf8');
const ROADMAP = readFileSync(join(repoRoot, 'ROADMAP.md'), 'utf8');
const PLUK_ATTACH = readFileSync(join(repoRoot, 'node_modules/@hivecommons/pluk/dist/attach.js'), 'utf8');

// Same extraction as issue-forms.test.cjs so both gates fail together if the
// HELP wording changes.
function cliTypes() {
  const match = CLI_SRC.match(/--cli=\w+\s+CLI type \(([^)]+)\)/);
  assert.ok(match, 'src/cli.ts: HELP no longer lists the --cli values as "CLI type (...)"');
  return match[1].split(',').map(s => s.trim());
}

// pluk's resolveDangerousFlag()/resolveDangerousEnv() tables. They are not
// exported, so read the object literals out of the installed dist.
function plukObjectLiteral(name) {
  const match = PLUK_ATTACH.match(new RegExp(`const ${name} = \\{([\\s\\S]*?)\\};`));
  assert.ok(match, `@hivecommons/pluk dist/attach.js no longer defines \`const ${name} = {...}\`; update this test's extraction`);
  const entries = [...match[1].matchAll(/^\s*(\w+):\s*'([^']*)'/gm)].map(m => [m[1], m[2]]);
  assert.ok(entries.length > 0, `found no entries in pluk ${name}`);
  return new Map(entries);
}

function plukDangerousMapping() {
  const flags = plukObjectLiteral('DANGEROUS_FLAGS');
  const env = plukObjectLiteral('DANGEROUS_ENV');
  for (const cli of env.keys()) assert.ok(!flags.has(cli), `pluk maps ${cli} both as a flag and as an env var`);
  return { flags, env };
}

function section(markdown, headingRe, file) {
  const start = markdown.search(headingRe);
  assert.notEqual(start, -1, `${file}: heading ${headingRe} not found`);
  const headingLevel = markdown.slice(start).match(/^#+/)[0];
  const rest = markdown.slice(start + headingLevel.length);
  const next = rest.search(new RegExp(`^#{1,${headingLevel.length}} `, 'm'));
  return next === -1 ? rest : rest.slice(0, next);
}

// `| \`cli\` | ... |` rows of the first table in a section, header and
// separator skipped.
function tableRows(text, file) {
  const rows = text.split('\n').filter(l => /^\|/.test(l));
  assert.ok(rows.length > 2, `${file}: no markdown table found`);
  return rows.slice(2).map(line => {
    const cells = line.split('|').slice(1, -1).map(c => c.trim());
    const cli = cells[0].match(/^`([^`]+)`$/);
    assert.ok(cli, `${file}: first table cell is not a backticked CLI name: ${line}`);
    return { cli: cli[1], cells, line };
  });
}

const NUMBER_WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve'];

test('README --dangerous section names every --cli value exactly once', () => {
  const types = cliTypes();
  const text = section(README, /^### `--dangerous` flag$/m, 'README.md');
  const inTable = tableRows(text, 'README.md').map(r => r.cli);

  const noop = text.match(/For other CLIs \(([^)]*)\)/);
  assert.ok(noop, 'README.md: `--dangerous` section must keep the "For other CLIs (...)" sentence (it may list no CLIs)');
  const inNoop = [...noop[1].matchAll(/`([a-z]+)`/g)].map(m => m[1]);

  const named = [...inTable, ...inNoop];
  assert.deepEqual(named.slice().sort(), types.slice().sort(), 'README.md `--dangerous` table + no-op list must name each --cli value from HELP exactly once');
});

test('README --dangerous table matches the mapping in the installed @hivecommons/pluk', () => {
  const { flags, env } = plukDangerousMapping();
  const text = section(README, /^### `--dangerous` flag$/m, 'README.md');
  const rows = tableRows(text, 'README.md');

  const expected = new Map([...flags, ...env]);
  assert.deepEqual(
    rows.map(r => r.cli).sort(),
    [...expected.keys()].sort(),
    'README.md `--dangerous` table must have one row per CLI pluk maps (DANGEROUS_FLAGS + DANGEROUS_ENV); any other --cli value belongs in the "For other CLIs" no-op sentence',
  );
  for (const row of rows) {
    const applied = row.cells[1].match(/^`([^`]+)`/);
    assert.ok(applied, `README.md: second cell must start with the backticked flag or variable pluk applies: ${row.line}`);
    assert.equal(applied[1], expected.get(row.cli), `README.md: \`${row.cli}\` row says \`${applied[1]}\` but the installed pluk applies \`${expected.get(row.cli)}\``);
    if (env.has(row.cli)) {
      assert.match(row.cells[1], /environment variable/, `README.md: \`${row.cli}\` is set through the environment by pluk, say so: ${row.line}`);
    }
  }
});

test('ROADMAP supported-CLI matrix lists exactly the --cli values from HELP', () => {
  const types = cliTypes();
  const text = section(ROADMAP, /^## Supported-CLI matrix$/m, 'ROADMAP.md');

  const sentence = text.match(/The (\w+) values accepted by `--cli` are ([^.]*)\./);
  assert.ok(sentence, 'ROADMAP.md: matrix section must open with "The <n> values accepted by `--cli` are `a`, `b` and `c`."');
  assert.equal(sentence[1], NUMBER_WORDS[types.length], `ROADMAP.md: "The ${sentence[1]} values accepted by --cli" but HELP lists ${types.length}`);
  const listed = [...sentence[2].matchAll(/`([a-z]+)`/g)].map(m => m[1]);
  assert.deepEqual(listed.slice().sort(), types.slice().sort(), 'ROADMAP.md: the "values accepted by --cli" sentence drifted from HELP');

  const rows = tableRows(text, 'ROADMAP.md').map(r => r.cli);
  assert.deepEqual(rows.slice().sort(), types.slice().sort(), 'ROADMAP.md: supported-CLI matrix rows drifted from the --cli values in HELP');
  assert.equal(new Set(rows).size, rows.length, 'ROADMAP.md: duplicate CLI rows in the supported-CLI matrix');
});

test('ROADMAP matrix --dangerous evidence matches the installed @hivecommons/pluk', () => {
  const { flags, env } = plukDangerousMapping();
  const text = section(ROADMAP, /^## Supported-CLI matrix$/m, 'ROADMAP.md');
  for (const row of tableRows(text, 'ROADMAP.md')) {
    const evidence = row.cells[2];
    const mapped = flags.get(row.cli) ?? env.get(row.cli);
    if (mapped === undefined) {
      assert.match(evidence, /`--dangerous` is a no-op/, `ROADMAP.md: pluk applies nothing for \`${row.cli}\`, the evidence cell must say \`--dangerous\` is a no-op: ${row.line}`);
      continue;
    }
    const claim = evidence.match(/`--dangerous` (?:maps to|sets) `([^`]+)`/);
    assert.ok(claim, `ROADMAP.md: \`${row.cli}\` evidence must state what \`--dangerous\` maps to (pluk applies \`${mapped}\`): ${row.line}`);
    assert.equal(claim[1], mapped, `ROADMAP.md: \`${row.cli}\` evidence says \`${claim[1]}\` but the installed pluk applies \`${mapped}\``);
  }
});
