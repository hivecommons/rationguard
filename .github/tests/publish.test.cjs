// Run with: node --test .github/tests/publish.test.cjs
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { spawnSync } = require('node:child_process');

const workflow = readFileSync(join(__dirname, '../workflows/publish.yml'), 'utf8');
const scripts = [...workflow.matchAll(/        run: \|\n((?:          .*\n|\n)+)/g)]
  .map(match => match[1].replace(/^          /gm, ''));
assert.equal(scripts.length, 5);
const [compareTag, onMain, changelogGate, extractNotes, createRelease] = scripts;
for (const script of scripts) {
  assert.doesNotMatch(script, /\$\{\{/, 'unexpected unexpanded workflow expression in publish script');
}

const GIT_ENV = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };

function git(cwd, ...args) {
  const res = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...GIT_ENV } });
  assert.equal(res.status, 0, `git ${args.join(' ')} failed: ${res.stderr}`);
  return res.stdout.trim();
}

function withDir(prefix, fn) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function run(script, { cwd, env = {}, path }) {
  const PATH = path ? `${path}:${process.env.PATH}` : process.env.PATH;
  const res = spawnSync('bash', ['-e', '-c', script], {
    cwd,
    env: { ...process.env, ...GIT_ENV, PATH, ...env },
    encoding: 'utf8',
  });
  return { status: res.status, stdout: res.stdout, stderr: res.stderr };
}

// --- verify-tag: compare tag to package.json version ---------------------

function compare(version, refName) {
  return withDir('publish-compare-', dir => {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ version }));
    return run(compareTag, { cwd: dir, env: { GITHUB_REF_NAME: refName } });
  });
}

test('tag matching package.json version passes', () => {
  assert.equal(compare('0.12.0', 'v0.12.0').status, 0);
  assert.equal(compare('0.12.0-rc.1', 'v0.12.0-rc.1').status, 0);
});

test('tag not matching package.json version fails with a bump hint', () => {
  for (const [version, ref] of [['0.12.0', 'v0.12.1'], ['0.12.0', 'v0.12.0-rc.1'], ['0.12.0-rc.1', 'v0.12.0']]) {
    const res = compare(version, ref);
    assert.equal(res.status, 1, `${version} vs ${ref}`);
    assert.equal(res.stdout, `::error::tag ${ref} does not match package.json version ${version}; bump package.json before tagging\n`);
  }
});

// --- verify-tag: tag commit must be on main -----------------------------

/**
 * Build a bare `origin` whose main has two commits, plus a clone with
 * `GITHUB_SHA` candidates: the main tip, an older main commit, and a commit
 * on a side branch that was never merged.
 */
function ancestry(pick) {
  return withDir('publish-ancestry-', dir => {
    const origin = join(dir, 'origin.git');
    const work = join(dir, 'work');
    git(dir, 'init', '-q', '--bare', '-b', 'main', origin);
    git(dir, 'clone', '-q', origin, work);
    git(work, 'config', 'user.email', 'test@example.com');
    git(work, 'config', 'user.name', 'test');
    git(work, 'checkout', '-q', '-b', 'main');
    writeFileSync(join(work, 'a'), '1\n');
    git(work, 'add', '-A');
    git(work, 'commit', '-q', '-m', 'one');
    const older = git(work, 'rev-parse', 'HEAD');
    writeFileSync(join(work, 'a'), '2\n');
    git(work, 'commit', '-q', '-am', 'two');
    const tip = git(work, 'rev-parse', 'HEAD');
    git(work, 'push', '-q', 'origin', 'main');
    git(work, 'checkout', '-q', '-b', 'side', older);
    writeFileSync(join(work, 'b'), '1\n');
    git(work, 'add', '-A');
    git(work, 'commit', '-q', '-m', 'side');
    const side = git(work, 'rev-parse', 'HEAD');
    git(work, 'push', '-q', 'origin', 'side');
    // Forget the local tracking ref so the script's own `git fetch` is what
    // makes origin/main resolvable, as in a fresh actions/checkout.
    git(work, 'update-ref', '-d', 'refs/remotes/origin/main');
    const sha = { tip, older, side }[pick];
    const res = run(onMain, { cwd: work, env: { GITHUB_SHA: sha, GITHUB_REF_NAME: 'v0.12.0' } });
    return { ...res, sha };
  });
}

test('tags on main (tip or earlier) pass the ancestry gate', () => {
  for (const pick of ['tip', 'older']) {
    const res = ancestry(pick);
    assert.equal(res.status, 0, `${pick}: ${res.stdout}${res.stderr}`);
  }
});

test('tag on an unmerged branch fails the ancestry gate', () => {
  const res = ancestry('side');
  assert.equal(res.status, 1);
  assert.match(res.stdout, new RegExp(`::error::tag v0\\.12\\.0 points at ${res.sha}, which is not reachable from main`));
});

// --- verify-tag + release: CHANGELOG section extraction -----------------

function gate(changelog, refName = 'v0.12.0') {
  return withDir('publish-changelog-', dir => {
    writeFileSync(join(dir, 'CHANGELOG.md'), changelog);
    const notes = join(dir, 'gate-notes.md');
    // The workflow writes to a fixed /tmp path; redirect it so parallel test
    // runs cannot clobber each other.
    assert.equal(changelogGate.split('/tmp/release-notes.md').length, 3);
    const res = run(changelogGate.replaceAll('/tmp/release-notes.md', notes), { cwd: dir, env: { GITHUB_REF_NAME: refName } });
    return { ...res, notes: existsSync(notes) ? readFileSync(notes, 'utf8') : null };
  });
}

function extract(changelog, refName = 'v0.12.0') {
  return withDir('publish-extract-', dir => {
    writeFileSync(join(dir, 'CHANGELOG.md'), changelog);
    const res = run(extractNotes, { cwd: dir, env: { GITHUB_REF_NAME: refName } });
    const notes = join(dir, 'release-notes.md');
    return { ...res, notes: existsSync(notes) ? readFileSync(notes, 'utf8') : null };
  });
}

const RELEASED = '## Unreleased\n\n## 0.12.0 - 2026-10-06\n\n### Fixed\n\n- Fix (#1)\n\n## 0.11.0 - 2026-10-01\n\n- Previous\n';

test('nonempty section for the tagged version passes both extraction steps', () => {
  for (const fn of [gate, extract]) {
    const res = fn(RELEASED);
    assert.equal(res.status, 0, res.stdout + res.stderr);
    assert.equal(res.notes, '\n### Fixed\n\n- Fix (#1)\n\n');
  }
});

test('exact heading without a date and prerelease versions are extracted', () => {
  for (const fn of [gate, extract]) {
    assert.equal(fn('## 0.12.0\n- Fix\n').notes, '- Fix\n');
    assert.equal(fn('## 0.12.0-rc.1 - date\n- Fix\n\n## 0.11.0\n- Old\n', 'v0.12.0-rc.1').notes, '- Fix\n\n');
  }
});

test('missing, empty and prefix-colliding sections fail the changelog gate', () => {
  for (const changelog of [
    '## Unreleased\n- Fix\n',
    '## 0.12.0\n \n## 0.11.0\n- Previous\n',
    '## 0.12.01\n- Wrong version\n',
    '## 0.12.0 - date\n\n',
  ]) {
    const res = gate(changelog);
    assert.equal(res.status, 1, changelog);
    assert.match(res.stdout, /::error::CHANGELOG\.md has no nonempty '## 0\.12\.0' section; move the '## Unreleased' entries/);
  }
});

test('release-notes extraction fails when the section is missing or empty', () => {
  for (const changelog of ['## Unreleased\n- Fix\n', '## 0.12.0 - date\n## 0.11.0\n- Old\n', '## 0.12.01\n- Wrong\n']) {
    assert.equal(extract(changelog).status, 1, changelog);
  }
});

test('gate and release step use the same awk extraction', () => {
  const awk = /awk -v h="## \$ver" '[^\n]*' CHANGELOG\.md/;
  assert.equal(changelogGate.match(awk)[0], extractNotes.match(awk)[0]);
});

// --- release: create GitHub release idempotently ------------------------

function release({ exists }) {
  return withDir('publish-release-', dir => {
    mkdirSync(join(dir, 'bin'));
    writeFileSync(join(dir, 'bin/gh'), [
      '#!/bin/bash',
      'printf "%s\\n" "$@" >> "$COMMAND_LOG"',
      'if [ "$1" = release ] && [ "$2" = view ]; then exit "$VIEW_STATUS"; fi',
      'exit 0',
    ].join('\n') + '\n', { mode: 0o755 });
    writeFileSync(join(dir, 'release-notes.md'), '- Fix\n');
    const log = join(dir, 'commands');
    const res = run(createRelease, {
      cwd: dir,
      path: join(dir, 'bin'),
      env: { COMMAND_LOG: log, VIEW_STATUS: exists ? '0' : '1', GITHUB_REF_NAME: 'v0.12.0', GH_TOKEN: 'x' },
    });
    return { ...res, commands: existsSync(log) ? readFileSync(log, 'utf8') : '' };
  });
}

test('existing release is left untouched', () => {
  const res = release({ exists: true });
  assert.equal(res.status, 0, res.stdout + res.stderr);
  assert.match(res.stdout, /release v0\.12\.0 already exists; leaving it untouched/);
  assert.doesNotMatch(res.commands, /\ncreate\n/);
});

test('missing release is created from the tag with the extracted notes', () => {
  const res = release({ exists: false });
  assert.equal(res.status, 0, res.stdout + res.stderr);
  assert.match(res.commands, /release\nview\nv0\.12\.0\n/);
  assert.match(res.commands, /release\ncreate\nv0\.12\.0\n--verify-tag\n--title\nv0\.12\.0\n--notes-file\nrelease-notes\.md\n/);
});

// --- job wiring ---------------------------------------------------------

test('publish only runs after verify-tag and the CI suite pass', () => {
  assert.match(workflow, /\n  test:\n(?:    .*\n)*?    needs: verify-tag\n/);
  assert.match(workflow, /\n  publish:\n(?:    .*\n)*?    needs: test\n/);
  assert.match(workflow, /\n  release:\n(?:    .*\n)*?    needs: publish\n/);
  assert.match(workflow, /npm ci --ignore-scripts/);
});
