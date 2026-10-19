// Run with: node --test .github/tests/workflow-hardening.test.cjs
//
// Structural gate over every workflow under .github/workflows/. Each one
// today pins every `uses:` to a full commit SHA with a `# <version>` comment,
// declares a top-level `permissions:` block and bounds every runner job with
// `timeout-minutes`. Nothing else enforces that: the other files in this
// directory execute `run:` scripts, and OpenSSF Scorecard reads the same
// files only on push to main and weekly, where a lower score fails nothing.
//
// Rules, each with a fixture self-test:
//   1. Every `uses:` is `owner/repo[/path]@<40-hex SHA>` followed by a
//      `# <version>` comment on the same line (what Dependabot rewrites on a
//      bump). `./local` paths are exempt; `docker://` images need `@sha256:`.
//   2. The workflow declares a top-level `permissions:` block, and neither it
//      nor any job grants `write-all`.
//   3. Every job with `runs-on:` also has `timeout-minutes:` (jobs that call
//      a reusable workflow via `uses:` cannot, and are exempt).
//   4. The workflow directory contributes at least one `uses:` line, so the
//      gate cannot pass vacuously on a tree it did not read.
// `persist-credentials: false` on checkouts is deliberately not asserted:
// the release workflows may need the token, and no checkout sets it today.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync, readdirSync } = require('node:fs');
const { join } = require('node:path');

const WORKFLOWS = join(__dirname, '../workflows');

const SHA40 = /^[0-9a-f]{40}$/;
const SHA256 = /^sha256:[0-9a-f]{64}$/;

// --- parsing -----------------------------------------------------------------

// Every `uses:` occurrence as { line (1-based), ref, comment }.
function usesLines(yaml) {
  const out = [];
  yaml.split('\n').forEach((text, i) => {
    const m = /^\s*(?:-\s+)?uses:\s*(.*)$/.exec(text);
    if (!m) return;
    let rest = m[1].trim();
    let comment = null;
    const hash = rest.search(/\s#/);
    if (hash >= 0) {
      comment = rest.slice(hash + 2).trim();
      rest = rest.slice(0, hash).trim();
    }
    out.push({ line: i + 1, ref: rest.replace(/^["']|["']$/g, ''), comment });
  });
  return out;
}

// The `jobs:` block as { name, line, body[] } entries.
function workflowJobs(yaml) {
  const lines = yaml.split('\n');
  const start = lines.findIndex(l => /^jobs:\s*$/.test(l));
  if (start < 0) return [];
  const jobs = [];
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i];
    if (/^\S/.test(l)) break;
    const m = /^  ([\w.-]+):\s*(?:#.*)?$/.exec(l);
    if (m) jobs.push({ name: m[1], line: i + 1, body: [] });
    else if (jobs.length) jobs[jobs.length - 1].body.push(l);
  }
  return jobs;
}

function hasTopLevelPermissions(yaml) {
  return yaml.split('\n').some(l => /^permissions:\s*(\S.*)?$/.test(l));
}

// --- rules -------------------------------------------------------------------

function pinProblems(yaml) {
  const problems = [];
  for (const { line, ref, comment } of usesLines(yaml)) {
    if (ref.startsWith('./')) continue;
    if (ref.startsWith('docker://')) {
      const at = ref.lastIndexOf('@');
      if (at < 0 || !SHA256.test(ref.slice(at + 1))) problems.push(`line ${line}: docker image ${ref} is not pinned to an @sha256 digest`);
      continue;
    }
    const at = ref.lastIndexOf('@');
    const sha = at < 0 ? '' : ref.slice(at + 1);
    if (!SHA40.test(sha)) problems.push(`line ${line}: uses: ${ref} is not pinned to a 40-hex commit SHA`);
    else if (!comment) problems.push(`line ${line}: uses: ${ref} has no "# <version>" comment after the SHA`);
  }
  return problems;
}

function permissionProblems(yaml) {
  const problems = [];
  if (!hasTopLevelPermissions(yaml)) problems.push('no top-level permissions: block');
  yaml.split('\n').forEach((l, i) => {
    if (/^\s*permissions:\s*write-all\s*(#.*)?$/.test(l)) problems.push(`line ${i + 1}: permissions: write-all`);
  });
  return problems;
}

function timeoutProblems(yaml) {
  const problems = [];
  for (const job of workflowJobs(yaml)) {
    const runsOn = job.body.some(l => /^\s{4}runs-on:/.test(l));
    const timeout = job.body.some(l => /^\s{4}timeout-minutes:/.test(l));
    if (runsOn && !timeout) problems.push(`line ${job.line}: job ${job.name} has runs-on: but no timeout-minutes:`);
  }
  return problems;
}

function workflowProblems(yaml) {
  return [...pinProblems(yaml), ...permissionProblems(yaml), ...timeoutProblems(yaml)];
}

// --- fixture self-tests -------------------------------------------------------

const GOOD = `name: CI
on: [push]
permissions:
  contents: read
jobs:
  test:
    runs-on: ubuntu-latest
    timeout-minutes: 5
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
      - uses: ./.github/actions/local
      - uses: docker://alpine@sha256:${'a'.repeat(64)}
  reuse:
    uses: hivecommons/infra/.github/workflows/reusable-stale.yml@1416d68a1fd5bd475b96c8ddfcffc8539bfa6b08 # main 2026-09-24
`;

test('fixture: a SHA-pinned, commented, permission-scoped, bounded workflow passes', () => {
  assert.deepEqual(workflowProblems(GOOD), []);
});

test('fixture: a tag ref, a bare SHA without a version comment and an undigested docker image are reported', () => {
  const yaml = GOOD
    .replace('actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1', 'actions/checkout@v7')
    .replace(/reusable-stale\.yml@(\w+) # main 2026-09-24/, 'reusable-stale.yml@$1')
    .replace(/docker:\/\/alpine@sha256:a+/, 'docker://alpine:3.20');
  const p = workflowProblems(yaml).join('\n');
  assert.match(p, /actions\/checkout@v7 is not pinned to a 40-hex commit SHA/);
  assert.match(p, /reusable-stale\.yml@1416d68a\w+ has no "# <version>" comment/);
  assert.match(p, /docker:\/\/alpine:3\.20 is not pinned to an @sha256 digest/);
});

test('fixture: a missing top-level permissions: block, and write-all at either level, are reported', () => {
  assert.deepEqual(permissionProblems(GOOD.replace('permissions:\n  contents: read\n', '')), ['no top-level permissions: block']);
  assert.deepEqual(permissionProblems(GOOD.replace('permissions:\n  contents: read\n', 'permissions: write-all\n')), ['line 3: permissions: write-all']);
  assert.deepEqual(permissionProblems(GOOD.replace('    runs-on: ubuntu-latest\n', '    runs-on: ubuntu-latest\n    permissions: write-all\n')), ['line 8: permissions: write-all']);
});

test('fixture: a job-level permissions: block does not satisfy the top-level rule', () => {
  const yaml = GOOD.replace('permissions:\n  contents: read\n', '').replace('    runs-on: ubuntu-latest\n', '    runs-on: ubuntu-latest\n    permissions:\n      contents: read\n');
  assert.deepEqual(permissionProblems(yaml), ['no top-level permissions: block']);
});

test('fixture: a runner job without timeout-minutes is reported; reusable-workflow jobs are exempt', () => {
  assert.deepEqual(timeoutProblems(GOOD.replace('    timeout-minutes: 5\n', '')), ['line 6: job test has runs-on: but no timeout-minutes:']);
  assert.deepEqual(timeoutProblems(GOOD), []);
});

test('fixture: a quoted uses: ref and a trailing-comment job header are read', () => {
  const yaml = GOOD
    .replace('- uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1', '- uses: "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1" # v7.0.1')
    .replace('  test:\n', '  test: # unit\n');
  assert.deepEqual(workflowProblems(yaml), []);
  assert.equal(workflowJobs(yaml)[0].name, 'test');
});

// --- live tree ----------------------------------------------------------------

const files = readdirSync(WORKFLOWS).filter(f => /\.ya?ml$/.test(f)).sort();

test('every .github/workflows/*.yml pins uses: to a commented SHA, declares permissions: and bounds runner jobs', () => {
  assert.ok(files.length > 0, 'no workflows found');
  const problems = [];
  for (const f of files) {
    for (const p of workflowProblems(readFileSync(join(WORKFLOWS, f), 'utf8'))) problems.push(`${f}: ${p}`);
  }
  assert.deepEqual(problems, []);
});

test('live tree: the workflow directory contributes uses: lines, so the pin rule actually ran', () => {
  const total = files.reduce((n, f) => n + usesLines(readFileSync(join(WORKFLOWS, f), 'utf8')).length, 0);
  assert.ok(total > 0, 'no uses: lines found under .github/workflows — the pin rule would pass vacuously');
});
