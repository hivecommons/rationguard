// Run with: node --test .github/tests/workflow-permissions.test.cjs
//
// A top-level permissions: block prevents the implicit repository-wide grant,
// but it does not say which individual scopes a workflow may write. Keep that
// policy explicit here: a workflow may only declare scopes already reviewed
// for that workflow, and only at the reviewed permission level or below.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync, readdirSync } = require('node:fs');
const { join } = require('node:path');

const WORKFLOWS = join(__dirname, '../workflows');
const LEVEL = { none: 0, read: 1, write: 2 };

// These are ceilings, not required grants. Tightening a permission from write
// to read (or omitting a scope) remains safe; adding an unreviewed scope or
// raising a scope above its reviewed ceiling fails the gate.
const ALLOWLIST = {
  'add-help-wanted.yml': {
    workflow: { issues: 'write' },
  },
  'ai-fix.yml': {
    workflow: { contents: 'read', issues: 'write', 'pull-requests': 'write' },
    jobs: {
      'ai-fix': { contents: 'write', issues: 'write', 'pull-requests': 'write' },
    },
  },
  'assignment-helper.yml': {
    workflow: { issues: 'write' },
  },
  'auto-release.yml': {
    workflow: { actions: 'write', contents: 'write' },
  },
  'ci.yml': {
    workflow: { contents: 'read', packages: 'read' },
  },
  'close-linked-issues.yml': {
    workflow: { contents: 'read', issues: 'write', 'pull-requests': 'read' },
  },
  'copilot-automation.yml': {
    workflow: {
      contents: 'read',
      issues: 'write',
      'pull-requests': 'write',
      statuses: 'write',
    },
    jobs: {
      'copilot-automation': {
        contents: 'write',
        issues: 'write',
        'pull-requests': 'write',
        statuses: 'write',
      },
    },
  },
  'copilot-dco.yml': {
    workflow: { contents: 'read', 'pull-requests': 'write', statuses: 'write' },
  },
  'feedback.yml': {
    workflow: { contents: 'read', 'pull-requests': 'write' },
  },
  'greetings.yml': {
    workflow: { contents: 'read', issues: 'write', 'pull-requests': 'write' },
  },
  'label-helper.yml': {
    workflow: { contents: 'read', issues: 'write', 'pull-requests': 'write' },
  },
  'mutation.yml': {
    workflow: { contents: 'read' },
    jobs: {
      mutation: { contents: 'read', 'pull-requests': 'write' },
    },
  },
  'pr-verifier.yml': {
    workflow: { checks: 'write', contents: 'read', packages: 'read', 'pull-requests': 'read' },
  },
  'publish.yml': {
    workflow: { contents: 'read' },
    jobs: {
      test: { contents: 'read', packages: 'read' },
      publish: { contents: 'read', 'id-token': 'write' },
      release: { contents: 'write' },
    },
  },
  'scorecard.yml': {
    workflow: {
      actions: 'read',
      contents: 'read',
      'id-token': 'write',
      'security-events': 'write',
    },
  },
  'stale.yml': {
    workflow: { issues: 'write' },
  },
};

function withoutComment(value) {
  return value.replace(/\s+#.*$/, '').trim();
}

function scalarValue(value) {
  const clean = withoutComment(value);
  const quote = clean[0];
  if ((quote === '"' || quote === "'") && clean.at(-1) === quote) {
    return clean.slice(1, -1);
  }
  return clean;
}

function inlineEntries(value) {
  const body = value.slice(1, -1).trim();
  if (body === '') return {};
  const entries = {};
  for (const item of body.split(',')) {
    const match = /^([A-Za-z][A-Za-z0-9-]*):\s*(.+)$/.exec(item.trim());
    if (!match) return null;
    entries[match[1]] = scalarValue(match[2]);
  }
  return entries;
}

function ownerFor(lines, index, indent) {
  if (indent === 0) return 'workflow';
  for (let i = index - 1; i >= 0; i--) {
    const line = lines[i];
    if (/^\s*$/.test(line) || /^\s*#/.test(line)) continue;
    const spaces = /^ */.exec(line)[0].length;
    if (spaces >= indent) continue;
    const match = new RegExp(`^ {${spaces}}([A-Za-z0-9_.-]+):(?:\\s|#|$)`).exec(line);
    if (match) return match[1];
  }
  return `indent-${indent}`;
}

// This is deliberately a small YAML subset: permissions are mappings of
// scalar scope names to scalar levels in the workflows under test. Unsupported
// syntax is returned as a problem rather than silently accepted.
function permissionBlocks(yaml) {
  const lines = yaml.split('\n');
  const blocks = [];
  for (let i = 0; i < lines.length; i++) {
    const match = /^( *)(?:permissions):\s*(.*)$/.exec(lines[i]);
    if (!match || /^\s*#/.test(lines[i])) continue;

    const indent = match[1].length;
    const rest = withoutComment(match[2]);
    const block = {
      line: i + 1,
      owner: ownerFor(lines, i, indent),
      entries: null,
      scalar: undefined,
      malformed: null,
    };

    if (rest !== '') {
      if (rest === '{}' || (rest.startsWith('{') && rest.endsWith('}'))) {
        block.entries = rest === '{}' ? {} : inlineEntries(rest);
        if (block.entries === null) block.malformed = 'invalid flow mapping';
      } else {
        block.scalar = scalarValue(rest);
      }
      blocks.push(block);
      continue;
    }

    const entries = {};
    let entryIndent = null;
    for (let j = i + 1; j < lines.length; j++) {
      const line = lines[j];
      if (/^\s*$/.test(line) || /^\s*#/.test(line)) continue;
      const spaces = /^ */.exec(line)[0].length;
      if (spaces <= indent) break;
      if (entryIndent === null) entryIndent = spaces;
      if (spaces !== entryIndent) {
        block.malformed = `unexpected indentation on line ${j + 1}`;
        continue;
      }
      const entry = new RegExp(`^ {${entryIndent}}([A-Za-z][A-Za-z0-9-]*):\\s*(.*)$`).exec(line);
      if (!entry) {
        block.malformed = `invalid entry on line ${j + 1}`;
        continue;
      }
      entries[entry[1]] = scalarValue(entry[2]);
    }
    block.entries = entries;
    blocks.push(block);
  }
  return blocks;
}

function permissionProblems(file, yaml, expected = ALLOWLIST[file]) {
  if (!expected) return [`no permission allowlist for ${file}`];

  const problems = [];
  const blocks = permissionBlocks(yaml);
  if (!blocks.some(block => block.owner === 'workflow')) {
    problems.push('no top-level permissions: block');
  }

  for (const block of blocks) {
    const allowed = block.owner === 'workflow'
      ? expected.workflow
      : expected.jobs?.[block.owner];
    if (!allowed) {
      problems.push(`line ${block.line}: permissions: block for unreviewed ${block.owner}`);
      continue;
    }
    if (block.scalar !== undefined) {
      problems.push(`line ${block.line}: scalar permissions value ${block.scalar} is not allowlisted`);
      continue;
    }
    if (block.malformed) {
      problems.push(`line ${block.line}: ${block.malformed}`);
      continue;
    }
    for (const [scope, value] of Object.entries(block.entries)) {
      const ceiling = allowed[scope];
      if (ceiling === undefined) {
        problems.push(`line ${block.line}: ${scope}: ${value} is not allowlisted for ${block.owner}`);
      } else if (LEVEL[value] === undefined || LEVEL[ceiling] === undefined || LEVEL[value] > LEVEL[ceiling]) {
        problems.push(`line ${block.line}: ${scope}: ${value} exceeds the ${ceiling} ceiling for ${block.owner}`);
      }
    }
  }
  return problems;
}

const FIXTURE_ALLOWLIST = {
  workflow: { contents: 'read', issues: 'write' },
  jobs: { test: { contents: 'read' } },
};

const GOOD = `name: fixture
permissions:
  contents: read
  issues: write
jobs:
  test:
    permissions:
      contents: read
    runs-on: ubuntu-latest
`;

test('fixture: reviewed workflow and job scopes pass at or below their ceilings', () => {
  assert.deepEqual(permissionProblems('fixture.yml', GOOD, FIXTURE_ALLOWLIST), []);
});

test('fixture: an unreviewed scope is rejected', () => {
  const problems = permissionProblems(
    'fixture.yml',
    GOOD.replace('  issues: write', '  issues: write\n  id-token: write'),
    FIXTURE_ALLOWLIST,
  );
  assert.match(problems.join('\n'), /id-token: write is not allowlisted for workflow/);
});

test('fixture: raising a reviewed scope is rejected', () => {
  const problems = permissionProblems(
    'fixture.yml',
    GOOD.replace('  contents: read', '  contents: write'),
    FIXTURE_ALLOWLIST,
  );
  assert.match(problems.join('\n'), /contents: write exceeds the read ceiling for workflow/);
});

test('fixture: scalar and unreviewed job permission blocks are rejected', () => {
  assert.match(
    permissionProblems('fixture.yml', GOOD.replace(/permissions:\n[\s\S]*?jobs:/, 'permissions: read-all\njobs:'), FIXTURE_ALLOWLIST).join('\n'),
    /scalar permissions value read-all is not allowlisted/,
  );
  const unknownJob = GOOD.replace('  test:\n', '  deploy:\n');
  assert.match(
    permissionProblems('fixture.yml', unknownJob, FIXTURE_ALLOWLIST).join('\n'),
    /permissions: block for unreviewed deploy/,
  );
  const unknownJobScope = GOOD.replace('      contents: read', '      deployments: write');
  assert.match(
    permissionProblems('fixture.yml', unknownJobScope, FIXTURE_ALLOWLIST).join('\n'),
    /deployments: write is not allowlisted for test/,
  );
});

test('fixture: omitted scopes and tightened grants remain valid', () => {
  const tightened = GOOD
    .replace('  issues: write\n', '')
    .replace('      contents: read', '      contents: none');
  assert.deepEqual(permissionProblems('fixture.yml', tightened, FIXTURE_ALLOWLIST), []);
});

const files = readdirSync(WORKFLOWS).filter(file => /\.ya?ml$/.test(file)).sort();

test('every workflow has a reviewed scoped-permission allowlist', () => {
  assert.deepEqual(Object.keys(ALLOWLIST).sort(), files);
});

test('every workflow stays within its reviewed scoped-permission allowlist', () => {
  const problems = [];
  for (const file of files) {
    const yaml = readFileSync(join(WORKFLOWS, file), 'utf8');
    for (const problem of permissionProblems(file, yaml)) problems.push(`${file}: ${problem}`);
  }
  assert.deepEqual(problems, []);
});
