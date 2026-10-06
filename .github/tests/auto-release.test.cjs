// Run with: node --test .github/tests/auto-release.test.cjs
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { spawnSync } = require('node:child_process');

const workflow = readFileSync(join(__dirname, '../workflows/auto-release.yml'), 'utf8');
const scripts = [...workflow.matchAll(/        run: \|\n((?:          .*\n|\n)+)/g)]
  .map(match => match[1].replace(/^          /gm, ''));
assert.equal(scripts.length, 3);

function decide({ version = '0.12.0', changelog = '## 0.12.0 - 2026-10-06\n\n- Fix\n', status = 2 }) {
  const dir = mkdtempSync(join(tmpdir(), 'auto-release-test-'));
  try {
    mkdirSync(join(dir, 'bin'));
    writeFileSync(join(dir, 'bin/git'), `#!/bin/bash\nexit ${status}\n`, { mode: 0o755 });
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ version }));
    writeFileSync(join(dir, 'CHANGELOG.md'), changelog);
    writeFileSync(join(dir, 'output'), '');
    const result = spawnSync('bash', ['-c', scripts[0]], {
      cwd: dir,
      env: { ...process.env, PATH: `${dir}/bin:${process.env.PATH}`, GITHUB_OUTPUT: join(dir, 'output') },
      encoding: 'utf8',
    });
    return { status: result.status, output: readFileSync(join(dir, 'output'), 'utf8') };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('new version with release notes is eligible', () => {
  assert.deepEqual(decide({}), { status: 0, output: 'tag=v0.12.0\nrelease=true\n' });
});

test('existing tag is a no-op', () => {
  assert.deepEqual(decide({ status: 0 }), { status: 0, output: 'tag=v0.12.0\nrelease=false\n' });
});

test('missing, empty and prefix-colliding sections do not tag', () => {
  for (const changelog of [
    '## Unreleased\n- Fix\n',
    '## 0.12.0\n \n## 0.11.0\n- Previous\n',
    '## 0.12.01\n- Wrong version\n',
    '## 0.12.0 - date\n\n',
  ]) {
    assert.equal(decide({ changelog }).output, 'tag=v0.12.0\nrelease=false\n');
  }
});

test('exact heading and prerelease versions work', () => {
  assert.match(decide({ changelog: '## 0.12.0\n- Fix\n' }).output, /release=true/);
  assert.match(decide({ version: '0.12.0-rc.1', changelog: '## 0.12.0-rc.1 - date\n- Fix\n' }).output, /release=true/);
});

test('remote errors fail closed rather than creating a tag', () => {
  const result = decide({ status: 128 });
  assert.equal(result.status, 128);
  assert.doesNotMatch(result.output, /release=true/);
});

test('invalid package version fails before emitting outputs', () => {
  assert.deepEqual(decide({ version: 'bad\nrelease=true' }), { status: 1, output: '' });
});

test('tag and dispatch use the same tag and triggering commit', () => {
  const dir = mkdtempSync(join(tmpdir(), 'auto-release-commands-'));
  try {
    writeFileSync(join(dir, 'gh'), '#!/bin/bash\nprintf "%s\\n" "$@" >> "$COMMAND_LOG"\n', { mode: 0o755 });
    const log = join(dir, 'commands');
    for (const script of scripts.slice(1)) {
      const result = spawnSync('bash', ['-e', '-c', script], {
        env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, COMMAND_LOG: log,
          TAG: 'v0.12.0', GITHUB_REPOSITORY: 'hivecommons/rationguard', GITHUB_SHA: 'abc123' },
      });
      assert.equal(result.status, 0);
    }
    const commands = readFileSync(log, 'utf8');
    assert.match(commands, /ref=refs\/tags\/v0\.12\.0\n-f\nsha=abc123/);
    assert.match(commands, /workflow\nrun\npublish.yml\n--repo\nhivecommons\/rationguard\n--ref\nrefs\/tags\/v0\.12\.0/);
    assert.equal((workflow.match(/if: steps.version.outputs.release == 'true'/g) || []).length, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
