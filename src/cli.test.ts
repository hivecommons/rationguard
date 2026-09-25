import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// End-to-end tests: run the compiled CLI as a subprocess with HOME and cwd
// sandboxed so sightings/custom-excuse stores never touch real state.
const CLI = fileURLToPath(new URL('./cli.js', import.meta.url));

let sandbox: string;
let homeDir: string;
let projectDir: string;

before(() => {
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'rationguard-cli-'));
  homeDir = path.join(sandbox, 'home');
  projectDir = path.join(sandbox, 'project');
  fs.mkdirSync(homeDir, { recursive: true });
  fs.mkdirSync(projectDir, { recursive: true });
});

after(() => {
  fs.rmSync(sandbox, { recursive: true, force: true });
});

beforeEach(() => {
  fs.rmSync(path.join(homeDir, '.rationguard'), { recursive: true, force: true });
  fs.rmSync(path.join(projectDir, '.rationguard'), { recursive: true, force: true });
});

interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

function run(args: string[], input?: string): RunResult {
  const res = spawnSync(process.execPath, [CLI, ...args], {
    input,
    cwd: projectDir,
    env: { ...process.env, HOME: homeDir },
    encoding: 'utf-8',
    timeout: 15_000,
  });
  return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}

describe('help', () => {
  it('prints usage on "help"', () => {
    const res = run(['help']);
    assert.strictEqual(res.status, 0);
    assert.match(stripAnsi(res.stdout), /USAGE/);
    assert.match(stripAnsi(res.stdout), /rationguard check/);
  });

  it('prints usage with no arguments', () => {
    const res = run([]);
    assert.strictEqual(res.status, 0);
    assert.match(stripAnsi(res.stdout), /USAGE/);
  });
});

describe('check', () => {
  it('reports clean text with exit 0', () => {
    const res = run(['check', 'purple elephants dance gracefully']);
    assert.strictEqual(res.status, 0);
    assert.match(stripAnsi(res.stdout), /Clean — no rationalization patterns detected/);
  });

  it('reports matches for excuse text with exit 0', () => {
    const res = run(['check', 'no work found']);
    assert.strictEqual(res.status, 0);
    const out = stripAnsi(res.stdout);
    assert.match(out, /rationalization pattern/);
    assert.match(out, /False Completion/);
    assert.match(out, /Rebuttal:/);
  });

  it('records a sighting in $HOME for high-confidence matches', () => {
    run(['check', 'no work found']);
    const raw = fs.readFileSync(path.join(homeDir, '.rationguard', 'sightings.json'), 'utf-8');
    const store = JSON.parse(raw) as { sightings: Array<{ text: string }> };
    assert.ok(store.sightings.some(s => s.text === 'no work found'));
  });

  it('outputs machine-readable JSON with --json', () => {
    const res = run(['check', 'no work found', '--json']);
    assert.strictEqual(res.status, 0);
    const parsed = JSON.parse(res.stdout) as { clean: boolean; matches: Array<{ excuse: { pattern: string } }> };
    assert.strictEqual(parsed.clean, false);
    assert.ok(parsed.matches.some(m => m.excuse.pattern === 'no work found'));
  });

  it('reads input from --file', () => {
    const file = path.join(sandbox, 'input.txt');
    fs.writeFileSync(file, 'standing by for instructions');
    const res = run(['check', `--file=${file}`]);
    assert.strictEqual(res.status, 0);
    assert.match(stripAnsi(res.stdout), /False Completion/);
  });

  it('exits 1 when --file does not exist', () => {
    const res = run(['check', '--file=/nonexistent/nope.txt']);
    assert.strictEqual(res.status, 1);
    assert.match(stripAnsi(res.stderr), /File not found/);
  });

  it('reads piped stdin input', () => {
    const res = run(['check'], 'this is too complex to fix');
    assert.strictEqual(res.status, 0);
    assert.match(stripAnsi(res.stdout), /Complexity Dodge/);
  });

  it('exits 1 with an error when there is no input at all', () => {
    const res = run(['check']);
    assert.strictEqual(res.status, 1);
    assert.match(stripAnsi(res.stderr), /No input/);
  });

  it('treats an unknown command as check input', () => {
    const res = run(['everything', 'is', 'complete,', 'no', 'remaining', 'tasks']);
    assert.strictEqual(res.status, 0);
    assert.match(stripAnsi(res.stdout), /False Completion/);
  });

  it('includes project-local excuses from ./.rationguard in detection', () => {
    const dir = path.join(projectDir, '.rationguard');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'custom-excuses.json'),
      JSON.stringify([
        { pattern: 'zorble project excuse', rebuttal: 'r', category: 'deferral', keywords: ['zorble'] },
      ]) + '\n',
    );
    const res = run(['check', 'zorble project excuse', '--json']);
    const parsed = JSON.parse(res.stdout) as { matches: Array<{ excuse: { pattern: string; source?: string } }> };
    const m = parsed.matches.find(x => x.excuse.pattern === 'zorble project excuse');
    assert.ok(m);
    assert.strictEqual(m.excuse.source, 'project');
  });
});

describe('prompt', () => {
  it('generates a markdown defense table', () => {
    const res = run(['prompt']);
    assert.strictEqual(res.status, 0);
    assert.match(res.stdout, /## Rationalization Defense — Known Excuses/);
    assert.match(res.stdout, /\| Excuse Pattern \| Rebuttal \|/);
    assert.match(res.stdout, /no work found/);
  });

  it('wraps the table in a YAML block with --format=yaml', () => {
    const res = run(['prompt', '--format=yaml']);
    assert.strictEqual(res.status, 0);
    assert.match(res.stdout, /^rationalization_defense: \|\n/);
    for (const line of res.stdout.trimEnd().split('\n').slice(1)) {
      assert.ok(line === '' || line.startsWith('  '), `unindented YAML line: ${JSON.stringify(line)}`);
    }
  });
});

describe('add', () => {
  it('records a new sighting', () => {
    const res = run(['add', 'circling back on this soon']);
    assert.strictEqual(res.status, 0);
    assert.match(stripAnsi(res.stdout), /Recorded new sighting \(1\/3/);
  });

  it('increments the count on repeat sightings', () => {
    run(['add', 'circling back on this soon']);
    const res = run(['add', 'circling back on this soon']);
    assert.strictEqual(res.status, 0);
    assert.match(stripAnsi(res.stdout), /Sighting count: 2\/3/);
  });

  it('auto-promotes to a custom excuse on the third sighting', () => {
    run(['add', 'circling back on this soon']);
    run(['add', 'circling back on this soon']);
    const res = run(['add', 'circling back on this soon']);
    assert.strictEqual(res.status, 0);
    assert.match(stripAnsi(res.stdout), /Auto-promoted to custom excuse/);
    const custom = JSON.parse(
      fs.readFileSync(path.join(homeDir, '.rationguard', 'custom-excuses.json'), 'utf-8'),
    ) as Array<{ pattern: string }>;
    assert.strictEqual(custom[0].pattern, 'circling back on this soon');
  });

  it('accepts --excuse, --category and --rebuttal flags', () => {
    const res = run(['add', '--excuse=bespoke excuse', '--category=lane-confusion', '--rebuttal=my rebuttal']);
    assert.strictEqual(res.status, 0);
    const store = JSON.parse(
      fs.readFileSync(path.join(homeDir, '.rationguard', 'sightings.json'), 'utf-8'),
    ) as { sightings: Array<{ text: string; suggestedCategory: string; suggestedRebuttal: string }> };
    assert.strictEqual(store.sightings[0].text, 'bespoke excuse');
    assert.strictEqual(store.sightings[0].suggestedCategory, 'lane-confusion');
    assert.strictEqual(store.sightings[0].suggestedRebuttal, 'my rebuttal');
  });

  it('exits 1 when no excuse text is given', () => {
    const res = run(['add']);
    assert.strictEqual(res.status, 1);
    assert.match(stripAnsi(res.stderr), /Provide excuse text/);
  });
});

describe('list', () => {
  it('groups built-in excuses by category', () => {
    const res = run(['list']);
    assert.strictEqual(res.status, 0);
    const out = stripAnsi(res.stdout);
    assert.match(out, /False Completion/);
    assert.match(out, /Complexity Dodge/);
    assert.match(out, /no work found/);
  });

  it('includes user custom excuses tagged with source "user" in --json output', () => {
    const dir = path.join(homeDir, '.rationguard');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'custom-excuses.json'),
      JSON.stringify([
        { pattern: 'frobnicate user excuse', rebuttal: 'r', category: 'deferral', keywords: ['frobnicate'] },
      ]) + '\n',
    );
    const res = run(['list', '--json']);
    const parsed = JSON.parse(res.stdout) as Array<{ pattern: string; source?: string }>;
    const custom = parsed.find(e => e.pattern === 'frobnicate user excuse');
    assert.ok(custom);
    assert.strictEqual(custom.source, 'user');
  });
});

describe('sightings', () => {
  it('reports when nothing has been recorded', () => {
    const res = run(['sightings']);
    assert.strictEqual(res.status, 0);
    assert.match(stripAnsi(res.stdout), /No sightings recorded yet/);
  });

  it('lists recorded sightings with counts', () => {
    run(['add', 'seen twice']);
    run(['add', 'seen twice']);
    const res = run(['sightings']);
    assert.strictEqual(res.status, 0);
    const out = stripAnsi(res.stdout);
    assert.match(out, /2× "seen twice"/);
    assert.match(out, /2\/3/);
  });

  it('outputs JSON sorted by count with --json', () => {
    run(['add', 'seen once']);
    run(['add', 'seen twice']);
    run(['add', 'seen twice']);
    const res = run(['sightings', '--json']);
    const parsed = JSON.parse(res.stdout) as Array<{ text: string; count: number }>;
    assert.strictEqual(parsed[0].text, 'seen twice');
    assert.strictEqual(parsed[0].count, 2);
  });
});

describe('sessions', () => {
  it('reports no sessions for an empty run dir', () => {
    const emptyRunDir = path.join(sandbox, 'empty-run-dir');
    fs.mkdirSync(emptyRunDir, { recursive: true });
    const res = run(['sessions', `--run-dir=${emptyRunDir}`]);
    assert.strictEqual(res.status, 0);
    assert.match(stripAnsi(res.stdout), /No active pluk sessions found/);
  });

  it('outputs an empty JSON array with --json', () => {
    const emptyRunDir = path.join(sandbox, 'empty-run-dir');
    fs.mkdirSync(emptyRunDir, { recursive: true });
    const res = run(['sessions', `--run-dir=${emptyRunDir}`, '--json']);
    assert.strictEqual(res.status, 0);
    assert.deepStrictEqual(JSON.parse(res.stdout), []);
  });
});

describe('watch and attach argument validation', () => {
  it('watch exits 1 without a session name', () => {
    const res = run(['watch']);
    assert.strictEqual(res.status, 1);
    assert.match(stripAnsi(res.stderr), /session name is required/);
  });

  it('attach exits 1 without a session name', () => {
    const res = run(['attach']);
    assert.strictEqual(res.status, 1);
    assert.match(stripAnsi(res.stderr), /session name is required/);
  });
});
