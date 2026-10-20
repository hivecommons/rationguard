// Run with: node --test .github/tests/docs-cli-surface.test.cjs
//
// README.md and runbooks/*.md are the operator-facing description of the CLI:
// they tell someone at 3am to run `rationguard sessions --run-dir=...` or
// `rationguard watch <s> --diagnostics`. Nothing checks those invocations
// against the real CLI, so a renamed subcommand or a dropped flag leaves
// the docs pointing at something that exits 1 with "Unknown command" — and
// the parser accepts any `--flag`, so a misspelt flag in a runbook is
// silently ignored rather than rejected. Pin every `rationguard <cmd>
// --flag` that appears in code (fenced blocks and inline spans) to the
// subcommands main() dispatches and the flags cli.ts actually reads, the
// same way issue-forms.test.cjs pins the issue forms to src/cli.ts.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync, readdirSync } = require('node:fs');
const { join } = require('node:path');

const repoRoot = join(__dirname, '../..');
const CLI_SRC = readFileSync(join(repoRoot, 'src/cli.ts'), 'utf8');

// Every markdown file an operator or contributor is pointed at.
const DOC_FILES = [
  'README.md',
  'CONTRIBUTING.md',
  'SECURITY.md',
  ...readdirSync(join(repoRoot, 'runbooks')).filter(f => f.endsWith('.md')).sort().map(f => join('runbooks', f)),
];

// Subcommands main() dispatches, read from the switch the same way
// issue-forms.test.cjs does, so both gates fail together if main() moves.
function dispatchedSubcommands() {
  const start = CLI_SRC.indexOf('switch (command) {');
  assert.notEqual(start, -1, 'src/cli.ts main() must dispatch via `switch (command)`');
  const body = CLI_SRC.slice(start, CLI_SRC.indexOf('\n  }\n', start));
  const cases = [...body.matchAll(/^\s+case '([^']*)':/gm)].map(m => m[1]).filter(Boolean);
  assert.ok(cases.length > 0, 'found no `case` labels in main() switch');
  return new Set(cases);
}

// parseFlags() stores every `--name[=value]` into a Record and `-h` as
// `help`; a flag only *does* anything if some code path reads flags['name'].
function readFlags() {
  const names = [...CLI_SRC.matchAll(/flags\[['"]([a-z][a-z-]*)['"]\]/g)].map(m => m[1]);
  assert.ok(names.length > 0, 'found no flags[...] reads in src/cli.ts');
  return new Set(names);
}

// The HELP template literal in cli.ts.
function helpText() {
  const match = CLI_SRC.match(/const HELP = `([\s\S]*?)`;\n/);
  assert.ok(match, 'src/cli.ts must define `const HELP = `...``');
  return match[1];
}

// Code the reader is expected to type: fenced blocks first, then inline
// spans from whatever is left so a span inside a fence is not counted twice.
function codeSegments(markdown) {
  const out = [];
  const fence = /```[^\n]*\n([\s\S]*?)```/g;
  for (const m of markdown.matchAll(fence)) out.push(m[1]);
  const prose = markdown.replace(fence, '');
  for (const m of prose.matchAll(/`([^`\n]+)`/g)) out.push(m[1]);
  return out;
}

// `rationguard <cmd> [args...]` on one line, where <cmd> is a bare word.
// `npm view @hivecommons/rationguard versions` does not match: the token
// before `rationguard` is `/`, not a shell separator. `rationguard <command>`
// (placeholder) is skipped by the [a-z] requirement.
const INVOCATION = /(?:^|[\s|;&(])rationguard\s+([a-z][a-z-]*)([^\n]*)/gm;

// Dispatched names that are deliberately not advertised as commands: `ls`
// is a bare alias for `sessions`, and `help` is reached via `--help` / `-h`.
const ALIASES = new Set(['ls', 'help']);

function documentedInvocations() {
  const found = [];
  for (const rel of DOC_FILES) {
    const markdown = readFileSync(join(repoRoot, rel), 'utf8');
    for (const code of codeSegments(markdown)) {
      for (const m of code.matchAll(INVOCATION)) {
        const flags = [...m[2].matchAll(/(?:^|\s)--([a-z][a-z-]*)/g)].map(f => f[1]);
        found.push({ file: rel, command: m[1], flags, text: `rationguard ${m[1]}${m[2]}`.trim() });
      }
    }
  }
  return found;
}

test('docs reference every subcommand the CLI dispatches, and nothing else', () => {
  const known = dispatchedSubcommands();
  const invocations = documentedInvocations();
  assert.ok(invocations.length >= 20, `expected the docs to show real invocations, found ${invocations.length}`);

  const unknown = invocations.filter(i => !known.has(i.command));
  assert.deepEqual(
    unknown.map(i => `${i.file}: ${i.text}`),
    [],
    `docs invoke subcommands main() does not dispatch (known: ${[...known].join(', ')})`,
  );

  // Every user-facing subcommand must be documented somewhere. `ls` is an
  // alias for `sessions`, and `help` is shown as `--help` / `-h` instead.
  const documented = new Set(invocations.map(i => i.command));
  const undocumented = [...known].filter(c => !ALIASES.has(c) && !documented.has(c));
  assert.deepEqual(undocumented, [], 'dispatched subcommands never shown in README/runbooks');
});

test('docs only pass flags cli.ts reads', () => {
  const known = readFlags();
  const bad = [];
  for (const i of documentedInvocations()) {
    for (const flag of i.flags) {
      if (!known.has(flag)) bad.push(`${i.file}: --${flag} in \`${i.text}\``);
    }
  }
  assert.deepEqual(bad, [], `docs pass flags no code path reads (known: ${[...known].sort().join(', ')})`);
});

test('help text and flags[...] reads describe the same flag set', () => {
  const help = helpText();
  const inHelp = new Set([...help.matchAll(/(?:^|\s)--([a-z][a-z-]*)/g)].map(m => m[1]));
  const read = readFlags();

  const readNotInHelp = [...read].filter(f => !inHelp.has(f)).sort();
  assert.deepEqual(readNotInHelp, [], 'cli.ts reads flags the help text never mentions');

  const helpNotRead = [...inHelp].filter(f => !read.has(f)).sort();
  assert.deepEqual(helpNotRead, [], 'help text advertises flags no code path reads');
});

test('help text lists every dispatched subcommand', () => {
  const help = helpText();
  const missing = [...dispatchedSubcommands()]
    .filter(c => !ALIASES.has(c))
    .filter(c => !new RegExp(`rationguard(?:\\$\\{ANSI_RESET\\})? ${c}\\b`).test(help));
  assert.deepEqual(missing, [], 'main() dispatches subcommands the help text does not show');
});
