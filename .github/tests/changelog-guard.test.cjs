// Run with: node --test .github/tests/changelog-guard.test.cjs
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, dirname } = require('node:path');
const { spawnSync } = require('node:child_process');

const workflow = readFileSync(join(__dirname, '../workflows/ci.yml'), 'utf8');
const guardJob = workflow.slice(workflow.indexOf('\n  changelog-guard:'));
const scripts = [...guardJob.matchAll(/        run: \|\n((?:          .*\n|\n)+)/g)]
  .map(match => match[1].replace(/^          /gm, ''));
assert.equal(scripts.length, 1);
const script = scripts[0].replaceAll('${{ github.base_ref }}', 'main');
assert.doesNotMatch(script, /\$\{\{/, 'unexpected unexpanded workflow expression in guard script');

const BASE_PACKAGE = {
  name: 'fixture',
  version: '1.0.0',
  dependencies: { '@hivecommons/pluk': '^0.9.0' },
  devDependencies: { typescript: '^5.7.0' },
};

function git(cwd, ...args) {
  const res = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' } });
  assert.equal(res.status, 0, `git ${args.join(' ')} failed: ${res.stderr}`);
  return res.stdout;
}

function write(dir, file, content) {
  mkdirSync(dirname(join(dir, file)), { recursive: true });
  writeFileSync(join(dir, file), content);
}

const BASE_FILES = {
  'CHANGELOG.md': '## Unreleased\n\n## 1.0.0\n- Initial\n',
  'src/index.ts': 'export const a = 1;\n',
  'src/index.test.ts': 'test a\n',
  'README.md': 'readme\n',
};

/**
 * Build a repo whose `origin/main` holds `basePackage` plus BASE_FILES,
 * apply `changes` (path -> content) on a PR branch, and run the guard the
 * way CI does (`origin/main...HEAD`).
 */
function guardFrom(basePackage, changes) {
  const dir = mkdtempSync(join(tmpdir(), 'changelog-guard-test-'));
  try {
    git(dir, 'init', '-q', '-b', 'main');
    git(dir, 'config', 'user.email', 'test@example.com');
    git(dir, 'config', 'user.name', 'test');
    write(dir, 'package.json', JSON.stringify(basePackage, null, 2) + '\n');
    for (const [file, content] of Object.entries(BASE_FILES)) write(dir, file, content);
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'base');
    git(dir, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
    git(dir, 'checkout', '-q', '-b', 'pr');
    for (const [file, content] of Object.entries(changes)) write(dir, file, content);
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'change');
    const res = spawnSync('bash', ['-c', script], { cwd: dir, encoding: 'utf8' });
    return { status: res.status, stdout: res.stdout, stderr: res.stderr };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const guard = changes => guardFrom(BASE_PACKAGE, changes);

const bumped = { ...BASE_PACKAGE, dependencies: { '@hivecommons/pluk': '^0.10.0' } };
const withChangelog = { 'CHANGELOG.md': '## Unreleased\n- Something\n\n## 1.0.0\n- Initial\n' };

test('shipped source change without a CHANGELOG entry fails', () => {
  const res = guard({ 'src/index.ts': 'export const a = 2;\n' });
  assert.equal(res.status, 1);
  assert.match(res.stdout, /::error::Shipped code changed but CHANGELOG\.md was not updated/);
});

test('shipped source change with a CHANGELOG entry passes', () => {
  const res = guard({ 'src/index.ts': 'export const a = 2;\n', ...withChangelog });
  assert.equal(res.status, 0, res.stdout + res.stderr);
});

test('test-only changes do not need a CHANGELOG entry', () => {
  for (const changes of [
    { 'src/index.test.ts': 'test b\n' },
    { 'src/new.test.ts': 'test new\n' },
    { 'src/__tests__/helper.ts': 'export {};\n' },
    { 'src/test/fixture.ts': 'export {};\n' },
  ]) {
    const res = guard(changes);
    assert.equal(res.status, 0, `${JSON.stringify(changes)}: ${res.stdout}${res.stderr}`);
  }
});

test('non-source changes do not need a CHANGELOG entry', () => {
  for (const changes of [
    { 'README.md': 'docs\n' },
    { 'docs/guide.md': 'guide\n' },
    { '.github/tests/x.test.cjs': '// test\n' },
    { 'src/notes.md': 'not typescript\n' },
  ]) {
    const res = guard(changes);
    assert.equal(res.status, 0, `${JSON.stringify(changes)}: ${res.stdout}${res.stderr}`);
  }
});

test('runtime dependency bump without a CHANGELOG entry fails', () => {
  const res = guard({ 'package.json': JSON.stringify(bumped, null, 2) + '\n' });
  assert.equal(res.status, 1);
  assert.match(res.stdout, /::error::Shipped code changed/);
});

test('runtime dependency bump with a CHANGELOG entry passes', () => {
  const res = guard({ 'package.json': JSON.stringify(bumped, null, 2) + '\n', ...withChangelog });
  assert.equal(res.status, 0, res.stdout + res.stderr);
});

test('devDependency, version and metadata changes in package.json do not need a CHANGELOG entry', () => {
  for (const pkg of [
    { ...BASE_PACKAGE, devDependencies: { typescript: '^5.8.0' } },
    { ...BASE_PACKAGE, version: '1.0.1' },
    { ...BASE_PACKAGE, description: 'new description' },
  ]) {
    const res = guard({ 'package.json': JSON.stringify(pkg, null, 2) + '\n' });
    assert.equal(res.status, 0, `${JSON.stringify(pkg)}: ${res.stdout}${res.stderr}`);
  }
});

test('adding a first dependencies block is a shipped change', () => {
  const { dependencies, ...noDeps } = BASE_PACKAGE;
  // Base without dependencies, PR adds one: the node comparison must treat
  // a missing block as {} rather than crash on undefined.
  const res = guardFrom(noDeps, { 'package.json': JSON.stringify({ ...noDeps, dependencies }, null, 2) + '\n' });
  assert.equal(res.status, 1, res.stdout + res.stderr);
  assert.match(res.stdout, /::error::Shipped code changed/);
});

