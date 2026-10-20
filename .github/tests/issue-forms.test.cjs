// Run with: node --test .github/tests/issue-forms.test.cjs
//
// GitHub validates issue forms only when a user opens the chooser: a form
// that fails schema validation is silently dropped from the list, and a
// dropdown that drifts from the CLI (a renamed subcommand, a new --cli
// value, a sixth excuse category) keeps offering stale choices with no
// signal anywhere in CI. The forms are a published description of the CLI
// surface, so pin them to the source the same way the workflow tests pin
// ci.yml to the real build.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync, readdirSync, existsSync } = require('node:fs');
const { join } = require('node:path');

const repoRoot = join(__dirname, '../..');
const TEMPLATES = join(repoRoot, '.github/ISSUE_TEMPLATE');
const README = readFileSync(join(repoRoot, 'README.md'), 'utf8');
const CLI_SRC = readFileSync(join(repoRoot, 'src/cli.ts'), 'utf8');
const TYPES_SRC = readFileSync(join(repoRoot, 'src/types.ts'), 'utf8');

// Labels the forms may apply. GitHub ignores a label that does not exist in
// the repository, so this list is the reviewed set rather than "anything".
const KNOWN_LABELS = new Set(['bug', 'enhancement']);
const FIELD_TYPES = new Set(['markdown', 'input', 'textarea', 'dropdown', 'checkboxes']);

function formFiles() {
  return readdirSync(TEMPLATES)
    .filter(f => /\.ya?ml$/.test(f) && f !== 'config.yml')
    .sort();
}

function unquote(raw) {
  const s = raw.trim();
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  return s;
}

function scalar(yaml, key) {
  const match = yaml.match(new RegExp(`^${key}:[ \\t]*(.*)$`, 'm'));
  return match ? unquote(match[1]) : undefined;
}

// Flow-sequence labels: ["bug"] or ["a", "b"].
function labels(yaml) {
  const match = yaml.match(/^labels:[ \t]*\[(.*)\]\s*$/m);
  assert.ok(match, 'labels must be a flow sequence ("labels: [...]")');
  return match[1].split(',').map(unquote).filter(Boolean);
}

// Minimal reader for the two-space-indented list under `body:`. Each `- type:`
// starts a field; `id:` and `options:` entries are gathered until the next
// field. Deliberately line-based so the gate has no runtime dependency.
function fields(yaml) {
  const lines = yaml.split('\n');
  const start = lines.findIndex(l => /^body:\s*$/.test(l));
  assert.notEqual(start, -1, 'form has no body: block');
  const out = [];
  let current = null;
  let inOptions = false;
  for (const line of lines.slice(start + 1)) {
    const typeMatch = line.match(/^  - type:[ \t]*(\S+)\s*$/);
    if (typeMatch) {
      current = { type: typeMatch[1], id: undefined, label: undefined, options: [], required: undefined };
      out.push(current);
      inOptions = false;
      continue;
    }
    if (!current) continue;
    const idMatch = line.match(/^    id:[ \t]*(.*)$/);
    if (idMatch) { current.id = unquote(idMatch[1]); inOptions = false; continue; }
    const labelMatch = line.match(/^      label:[ \t]*(.*)$/);
    if (labelMatch) { current.label = unquote(labelMatch[1]); inOptions = false; continue; }
    const reqMatch = line.match(/^      required:[ \t]*(\S+)\s*$/);
    if (reqMatch) { current.required = reqMatch[1]; inOptions = false; continue; }
    if (/^      options:\s*$/.test(line)) { inOptions = true; continue; }
    if (inOptions) {
      const opt = line.match(/^        - (.*)$/);
      if (opt) { current.options.push(unquote(opt[1])); continue; }
      if (line.trim() !== '') inOptions = false;
    }
  }
  return out;
}

function dropdown(yaml, id, file) {
  const field = fields(yaml).find(f => f.id === id);
  assert.ok(field, `${file}: no field with id "${id}"`);
  assert.equal(field.type, 'dropdown', `${file}: field "${id}" is not a dropdown`);
  return field.options;
}

// GitHub's anchor slug: lowercase, strip punctuation, spaces to hyphens.
function headingSlugs(markdown) {
  return new Set(
    [...markdown.matchAll(/^#{1,6}[ \t]+(.+?)\s*$/gm)].map(m =>
      m[1]
        .toLowerCase()
        .replace(/[`*_]/g, '')
        .replace(/[^\p{L}\p{N}\s-]/gu, '')
        .trim()
        .replace(/\s+/g, '-'),
    ),
  );
}

// Subcommands dispatched by main()'s switch, excluding aliases and the
// implicit fallbacks that are not user-facing command names.
function cliSubcommands() {
  const start = CLI_SRC.indexOf('switch (command) {');
  assert.notEqual(start, -1, 'src/cli.ts: main() switch (command) not found');
  const body = CLI_SRC.slice(start, CLI_SRC.indexOf('\n  }\n', start));
  const cases = [...body.matchAll(/^\s+case '([^']*)':/gm)].map(m => m[1]);
  assert.ok(cases.length > 0, 'src/cli.ts: no case labels found in main() switch');
  return cases.filter(c => c !== '' && c !== 'help' && c !== 'ls');
}

function cliTypes() {
  const match = CLI_SRC.match(/--cli=\w+\s+CLI type \(([^)]+)\)/);
  assert.ok(match, 'src/cli.ts: HELP no longer lists the --cli values as "CLI type (...)"');
  return match[1].split(',').map(s => s.trim());
}

function excuseCategories() {
  const match = TYPES_SRC.match(/export type ExcuseCategory =\s*([\s\S]*?);/);
  assert.ok(match, 'src/types.ts: ExcuseCategory union not found');
  return [...match[1].matchAll(/'([^']+)'/g)].map(m => m[1]);
}

test('every issue form is a complete, schema-valid form', () => {
  const files = formFiles();
  assert.ok(files.length >= 3, `expected the bug, excuse-pattern and feature forms, found ${files.join(', ')}`);
  for (const file of files) {
    const yaml = readFileSync(join(TEMPLATES, file), 'utf8');
    assert.ok(scalar(yaml, 'name'), `${file}: missing name`);
    assert.ok(scalar(yaml, 'description'), `${file}: missing description`);
    const title = scalar(yaml, 'title');
    assert.match(title ?? '', /^[a-z]+: $/, `${file}: title prefix must look like "kind: " so issues sort by kind`);
    for (const label of labels(yaml)) {
      assert.ok(KNOWN_LABELS.has(label), `${file}: label "${label}" is not a known repository label`);
    }

    const all = fields(yaml);
    const inputs = all.filter(f => f.type !== 'markdown');
    assert.ok(inputs.length > 0, `${file}: a form with only markdown blocks fails GitHub validation`);
    const ids = new Set();
    for (const f of all) {
      assert.ok(FIELD_TYPES.has(f.type), `${file}: unknown field type "${f.type}"`);
      if (f.type === 'markdown') {
        assert.equal(f.required, undefined, `${file}: markdown blocks cannot carry validations`);
        continue;
      }
      assert.ok(f.id, `${file}: ${f.type} field without an id`);
      assert.match(f.id, /^[a-z][a-z0-9-]*$/, `${file}: id "${f.id}" must be lowercase kebab-case`);
      assert.ok(!ids.has(f.id), `${file}: duplicate field id "${f.id}"`);
      ids.add(f.id);
      assert.ok(f.label, `${file}: field "${f.id}" has no label`);
      if (f.required !== undefined) {
        assert.ok(['true', 'false'].includes(f.required), `${file}: field "${f.id}" required must be true/false`);
      }
      if (f.type === 'dropdown') {
        assert.ok(f.options.length >= 2, `${file}: dropdown "${f.id}" needs at least two options`);
        assert.equal(new Set(f.options).size, f.options.length, `${file}: dropdown "${f.id}" has duplicate options`);
      } else {
        assert.equal(f.options.length, 0, `${file}: options on non-dropdown field "${f.id}"`);
      }
    }
    assert.ok(inputs.some(f => f.required === 'true'), `${file}: at least one field should be required`);
  }
});

test('every README anchor linked from a form resolves to a heading', () => {
  const slugs = headingSlugs(README);
  for (const file of formFiles()) {
    const yaml = readFileSync(join(TEMPLATES, file), 'utf8');
    const anchors = [...yaml.matchAll(/github\.com\/hivecommons\/rationguard#([\w-]+)/g)].map(m => m[1]);
    for (const anchor of anchors) {
      assert.ok(slugs.has(anchor), `${file}: README has no heading for #${anchor}`);
    }
  }
});

test('bug report: Command dropdown matches the subcommands main() dispatches', () => {
  const yaml = readFileSync(join(TEMPLATES, 'bug_report.yml'), 'utf8');
  const options = dropdown(yaml, 'command', 'bug_report.yml');
  assert.equal(options[options.length - 1], 'other', 'last option must remain the "other" catch-all');
  const bare = options.filter(o => /^[a-z]+$/.test(o) && o !== 'other');
  const extras = options.filter(o => !/^[a-z]+$/.test(o));
  assert.deepEqual(bare.sort(), cliSubcommands().sort(), 'subcommand options drifted from src/cli.ts main() switch');
  assert.ok(extras.some(o => /library API/i.test(o)), 'keep a "library API" option for non-CLI consumers');
});

test('bug report: Agent CLI dropdown matches the --cli values in HELP', () => {
  const yaml = readFileSync(join(TEMPLATES, 'bug_report.yml'), 'utf8');
  const options = dropdown(yaml, 'cli', 'bug_report.yml');
  const bare = options.filter(o => /^[a-z]+$/.test(o));
  assert.deepEqual(bare, cliTypes(), '--cli options drifted from the HELP text in src/cli.ts');
  assert.ok(options.some(o => /--command/.test(o)), 'keep an option for a custom --command');
  assert.equal(options[options.length - 1], 'not applicable', 'last option must remain "not applicable"');
});

test('bug report: version and environment guidance match package.json', () => {
  const yaml = readFileSync(join(TEMPLATES, 'bug_report.yml'), 'utf8');
  const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
  const placeholder = yaml.match(/id: version[\s\S]*?placeholder:[ \t]*(.*)$/m);
  assert.ok(placeholder, 'version field has no placeholder');
  assert.match(unquote(placeholder[1]), /^\d+\.\d+\.\d+$/, 'version placeholder must be a plain semver');
  const minNode = pkg.engines.node.match(/>=\s*(\d+)/)[1];
  assert.match(yaml, new RegExp(`Node\\.js ${minNode} or newer`), `form must state the Node.js ${minNode} floor from package.json engines`);
  assert.match(yaml, new RegExp(pkg.name.replace(/[/@]/g, '\\$&')), 'form must reference the published package name');
});

test('excuse pattern report: Expected category dropdown matches ExcuseCategory', () => {
  const yaml = readFileSync(join(TEMPLATES, 'excuse_pattern.yml'), 'utf8');
  const categories = excuseCategories();
  const options = dropdown(yaml, 'category', 'excuse_pattern.yml');
  assert.deepEqual(options.slice(0, -1), categories, 'category options drifted from src/types.ts ExcuseCategory');
  assert.match(options[options.length - 1], /^none\b/, 'last option must be the "none (should not match)" escape hatch');
  const words = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve'];
  const word = words[categories.length];
  assert.ok(word, `ExcuseCategory has ${categories.length} members; extend the number-word list in this test`);
  assert.match(yaml, new RegExp(`\\b${word} categories\\b`), `intro must say "${word} categories"`);
  assert.ok(README.includes(`## The ${categories.length} Excuse Categories`), 'README heading count drifted from ExcuseCategory');
});

test('excuse pattern report: report-type dropdown covers false positive, miss, and proposal', () => {
  const yaml = readFileSync(join(TEMPLATES, 'excuse_pattern.yml'), 'utf8');
  const options = dropdown(yaml, 'kind', 'excuse_pattern.yml');
  assert.equal(options.length, 3);
  assert.match(options[0], /^False positive/);
  assert.match(options[1], /^Missed excuse/);
  assert.match(options[2], /^New default excuse/);
});

test('config.yml: contact links are complete and point at files that exist', () => {
  const yaml = readFileSync(join(TEMPLATES, 'config.yml'), 'utf8');
  assert.match(yaml, /^blank_issues_enabled: (true|false)\s*$/m);
  const links = [...yaml.matchAll(/^  - name:[ \t]*(.*)\n    url:[ \t]*(\S+)\n    about:[ \t]*(.+)$/gm)];
  const count = (yaml.match(/^  - name:/gm) || []).length;
  assert.equal(links.length, count, 'every contact link needs name, url and about in that order');
  assert.ok(links.length >= 1, 'config.yml has no contact links');
  for (const [, name, url] of links) {
    assert.match(url, /^https:\/\//, `contact link "${name}" must use https`);
    const blob = url.match(/^https:\/\/github\.com\/hivecommons\/rationguard\/blob\/main\/(.+)$/);
    if (blob) {
      assert.ok(existsSync(join(repoRoot, blob[1])), `contact link "${name}" points at missing file ${blob[1]}`);
    }
  }
  assert.ok(links.some(([, , url]) => /SECURITY\.md$/.test(url)), 'security reports must be routed to SECURITY.md');
});
