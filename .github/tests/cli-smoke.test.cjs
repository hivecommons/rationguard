// Run with: node --test .github/tests/cli-smoke.test.cjs
//
// Pins the "CLI smoke test" step in ci.yml: it must pass against the real
// built CLI, and it must still *fail* when the CLI regresses one of the
// --fail-on-match exit-code contracts it exists to guard. The packed-tarball
// step repeats the same assertions through `npx`; its block is checked for
// textual parity rather than executed, because running it needs a registry.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { spawnSync } = require('node:child_process');

const repoRoot = join(__dirname, '../..');
const workflow = readFileSync(join(__dirname, '../workflows/ci.yml'), 'utf8');

function stepScript(name) {
  const stepStart = workflow.indexOf(`      - name: ${name}\n`);
  assert.notEqual(stepStart, -1, `ci.yml no longer has a "${name}" step`);
  const next = workflow.indexOf('\n      - name:', stepStart + 1);
  const end = next === -1 ? workflow.indexOf('\n\n  ', stepStart + 1) : next;
  const step = workflow.slice(stepStart, end === -1 ? undefined : end);
  const scripts = [...step.matchAll(/        run: \|\n((?:          .*\n|\n)+)/g)]
    .map(match => match[1].replace(/^          /gm, ''));
  assert.equal(scripts.length, 1, `expected exactly one run block in "${name}"`);
  assert.doesNotMatch(scripts[0], /\$\{\{/, `unexpected unexpanded workflow expression in "${name}"`);
  return scripts[0];
}

const cliScript = stepScript('CLI smoke test');
const tarballScript = stepScript('Packed tarball smoke test');

/**
 * Build a fixture with a stub dist/cli.js whose exit codes for the three
 * --fail-on-match cases are controlled by the caller, then run the smoke
 * step exactly as CI does.
 */
function smokeWith({ matchExit = 2, cleanExit = 0, usageExit = 1 } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'cli-smoke-test-'));
  try {
    mkdirSync(join(dir, 'dist'));
    writeFileSync(join(dir, 'dist/cli.js'), `
const args = process.argv.slice(2);
const cmd = args[0];
if (cmd === 'help') { console.log('usage'); process.exit(0); }
const flags = args.filter(a => a.startsWith('--'));
const text = args.slice(1).filter(a => !a.startsWith('--')).join(' ');
if (text === '') process.exit(${usageExit});
const matched = /out of scope/.test(text);
if (flags.includes('--json')) {
  console.log(JSON.stringify({ clean: !matched, matches: matched ? [{ id: 'scope' }] : [] }));
}
if (flags.includes('--fail-on-match')) process.exit(matched ? ${matchExit} : ${cleanExit});
process.exit(0);
`);
    const res = spawnSync('bash', ['-c', cliScript], { cwd: dir, encoding: 'utf8' });
    return { status: res.status, stdout: res.stdout, stderr: res.stderr };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('the smoke step passes against the real built CLI', { skip: !existsSync(join(repoRoot, 'dist/cli.js')) && 'dist/cli.js not built' }, () => {
  const res = spawnSync('bash', ['-c', cliScript], { cwd: repoRoot, encoding: 'utf8' });
  assert.equal(res.status, 0, res.stdout + res.stderr);
});

test('the smoke step passes against a stub honouring the exit-code contract', () => {
  const res = smokeWith();
  assert.equal(res.status, 0, res.stdout + res.stderr);
});

test('a CLI that no longer exits 2 on match with --fail-on-match fails the smoke step', () => {
  for (const matchExit of [0, 1]) {
    const res = smokeWith({ matchExit });
    assert.equal(res.status, 1, `smoke step missed match exit ${matchExit}: ${res.stdout}${res.stderr}`);
    assert.match(res.stdout, new RegExp(`expected exit 2 on match with --fail-on-match, got ${matchExit}`));
  }
});

test('a CLI that exits non-zero on clean input with --fail-on-match fails the smoke step', () => {
  const res = smokeWith({ cleanExit: 2 });
  assert.notEqual(res.status, 0, 'smoke step accepted a non-zero exit on clean input');
  assert.doesNotMatch(res.stdout, /expected exit/, 'clean-input failure was misreported as a match/usage failure');
});

test('a CLI that no longer exits 1 on a usage error with --fail-on-match fails the smoke step', () => {
  for (const usageExit of [0, 2]) {
    const res = smokeWith({ usageExit });
    assert.equal(res.status, 1, `smoke step missed usage exit ${usageExit}: ${res.stdout}${res.stderr}`);
    assert.match(res.stdout, new RegExp(`expected exit 1 on usage error, got ${usageExit}`));
  }
});

test('the packed tarball step repeats the same --fail-on-match assertions via npx', () => {
  const block = script => {
    const lines = script.split('\n');
    const first = lines.findIndex(l => l === 'set +e');
    assert.notEqual(first, -1, 'no --fail-on-match assertion block found');
    const last = lines.length - 1 - [...lines].reverse().findIndex(l => /expected exit 1 on usage error/.test(l));
    return lines.slice(first, last + 1).join('\n');
  };
  const viaNode = block(cliScript);
  const viaNpx = block(tarballScript).replaceAll('npx --no-install rationguard ', 'node dist/cli.js ');
  assert.equal(viaNpx, viaNode);
  assert.equal((viaNode.match(/^node dist\/cli\.js check --fail-on-match/gm) || []).length, 3, 'expected three --fail-on-match invocations (match, clean, usage)');
});
