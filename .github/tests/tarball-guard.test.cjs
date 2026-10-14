// Run with: node --test .github/tests/tarball-guard.test.cjs
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, dirname } = require('node:path');
const { spawnSync } = require('node:child_process');

const workflow = readFileSync(join(__dirname, '../workflows/ci.yml'), 'utf8');
const stepStart = workflow.indexOf('      - name: Tarball excludes tests\n');
assert.notEqual(stepStart, -1, 'ci.yml no longer has a "Tarball excludes tests" step');
const step = workflow.slice(stepStart, workflow.indexOf('\n      - name:', stepStart + 1));
const scripts = [...step.matchAll(/        run: \|\n((?:          .*\n|\n)+)/g)]
  .map(match => match[1].replace(/^          /gm, ''));
assert.equal(scripts.length, 1);
const script = scripts[0];
assert.doesNotMatch(script, /\$\{\{/, 'unexpected unexpanded workflow expression in guard script');

// The real manifest's `files` field is the thing under test: the guard only
// has teeth if these globs keep compiled tests out of the tarball.
const realPackage = JSON.parse(readFileSync(join(__dirname, '../../package.json'), 'utf8'));
assert.ok(Array.isArray(realPackage.files), 'package.json has no files field');

const DIST = [
  'dist/index.js', 'dist/index.js.map', 'dist/index.d.ts',
  'dist/cli.js', 'dist/cli.js.map', 'dist/cli.d.ts',
  'dist/index.test.js', 'dist/index.test.js.map', 'dist/index.test.d.ts',
  'dist/cli.test.js', 'dist/cli.test.js.map', 'dist/cli.test.d.ts',
];

function write(dir, file, content) {
  mkdirSync(dirname(join(dir, file)), { recursive: true });
  writeFileSync(join(dir, file), content);
}

/**
 * Build a package dir with a stub dist/ (shipped + compiled test files) and
 * the given `files` field, then run the guard exactly as CI does.
 */
function guardWith(files) {
  const dir = mkdtempSync(join(tmpdir(), 'tarball-guard-test-'));
  try {
    write(dir, 'package.json', JSON.stringify({ name: 'fixture', version: '1.0.0', files }, null, 2) + '\n');
    write(dir, 'README.md', 'readme\n');
    write(dir, 'LICENSE', 'license\n');
    for (const file of DIST) write(dir, file, '// stub\n');
    const res = spawnSync('bash', ['-c', script], { cwd: dir, encoding: 'utf8' });
    const pack = spawnSync('npm', ['pack', '--dry-run', '--json'], { cwd: dir, encoding: 'utf8' });
    assert.equal(pack.status, 0, `npm pack failed: ${pack.stderr}`);
    const paths = JSON.parse(pack.stdout)[0].files.map(f => f.path).sort();
    return { status: res.status, stdout: res.stdout, stderr: res.stderr, paths };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('the real files field ships dist without any compiled test artifact', () => {
  const res = guardWith(realPackage.files);
  assert.equal(res.status, 0, res.stdout + res.stderr);
  assert.ok(res.paths.includes('dist/index.js'), `shipped code missing from tarball: ${res.paths}`);
  assert.ok(res.paths.includes('dist/cli.js'), `shipped code missing from tarball: ${res.paths}`);
  assert.deepEqual(res.paths.filter(p => /\.test\./.test(p)), []);
});

test('a files field that leaks compiled tests fails the guard with an error annotation', () => {
  const res = guardWith(['dist', 'README.md', 'LICENSE']);
  assert.equal(res.status, 1);
  assert.match(res.stdout, /::error::npm tarball contains compiled test files/);
  assert.ok(res.paths.includes('dist/index.test.js'), 'fixture did not actually leak tests');
});

test('each compiled test artifact kind is caught on its own', () => {
  for (const kept of ['dist/*.test.js', 'dist/*.test.js.map', 'dist/*.test.d.ts']) {
    const files = ['dist', '!dist/*.test.js', '!dist/*.test.js.map', '!dist/*.test.d.ts'].filter(f => f !== `!${kept}`);
    const res = guardWith(files);
    assert.equal(res.status, 1, `guard missed leaked ${kept}: ${res.paths}`);
    assert.deepEqual(res.paths.filter(p => /\.test\./.test(p)), ['dist/cli', 'dist/index'].map(b => kept.replace('*', b.slice(5))).sort());
  }
});
