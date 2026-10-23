#!/usr/bin/env node
// Render Stryker's JSON report as Markdown for the advisory mutation workflow
// (job summary and sticky PR comment). Advisory only: always exits 0.
//
// Usage: node .github/scripts/mutation-summary.cjs [report.json] [maxSurvivorsPerFile]
const { readFileSync, existsSync } = require('node:fs');
const { relative, isAbsolute } = require('node:path');

const MARKER = '<!-- rationguard:mutation-report -->';
const HEADING = '### Mutation report (advisory)';
const DETECTED = new Set(['Killed', 'Timeout']);
const UNDETECTED = new Set(['Survived', 'NoCoverage']);

function score(mutants) {
  let detected = 0;
  let undetected = 0;
  for (const m of mutants) {
    if (DETECTED.has(m.status)) detected++;
    else if (UNDETECTED.has(m.status)) undetected++;
  }
  const valid = detected + undetected;
  return { detected, undetected, valid, score: valid === 0 ? null : (detected / valid) * 100 };
}

function fmt(value) {
  return value === null ? 'n/a' : `${value.toFixed(2)}%`;
}

function cell(text) {
  return String(text).replace(/\|/g, '\\|').replace(/`/g, "'").replace(/\s+/g, ' ').trim();
}

function render(report, maxSurvivors = 10) {
  const lines = [MARKER, HEADING, ''];
  const files = Object.entries(report.files || {})
    .map(([path, file]) => [isAbsolute(path) ? relative(process.cwd(), path) : path, file.mutants || []])
    .sort(([a], [b]) => a.localeCompare(b));
  const total = score(files.flatMap(([, mutants]) => mutants));
  lines.push(`**Mutation score: ${fmt(total.score)}** (${total.detected} detected / ${total.valid} valid mutants). Report-only; this never fails CI.`, '');
  if (files.length === 0) {
    lines.push('No files were mutated.');
    return lines.join('\n') + '\n';
  }
  lines.push('| File | Score | Killed | Survived | No coverage |', '| --- | --- | --- | --- | --- |');
  for (const [path, mutants] of files) {
    const s = score(mutants);
    const count = status => mutants.filter(m => m.status === status).length;
    lines.push(`| \`${path}\` | ${fmt(s.score)} | ${count('Killed') + count('Timeout')} | ${count('Survived')} | ${count('NoCoverage')} |`);
  }
  const survivors = files
    .map(([path, mutants]) => [path, mutants.filter(m => UNDETECTED.has(m.status))])
    .filter(([, mutants]) => mutants.length > 0);
  if (survivors.length > 0) {
    lines.push('', '#### Surviving mutants', '');
    for (const [path, mutants] of survivors) {
      lines.push(`<details><summary><code>${path}</code> (${mutants.length})</summary>`, '');
      const sorted = [...mutants].sort((a, b) => (a.location?.start?.line ?? 0) - (b.location?.start?.line ?? 0));
      for (const m of sorted.slice(0, maxSurvivors)) {
        const line = m.location?.start?.line ?? '?';
        const replacement = m.replacement === undefined ? '' : `: \`${cell(m.replacement)}\``;
        lines.push(`- L${line} ${cell(m.mutatorName)} (${m.status})${replacement}`);
      }
      if (sorted.length > maxSurvivors) lines.push(`- …and ${sorted.length - maxSurvivors} more`);
      lines.push('', '</details>');
    }
  }
  return lines.join('\n') + '\n';
}

function notice(text) {
  return `${MARKER}\n${HEADING}\n\n${text} Report-only; this never fails CI.\n`;
}

function main(argv, out = process.stdout) {
  const path = argv[0] || 'reports/mutation/mutation.json';
  const max = Number.parseInt(argv[1] || '10', 10);
  if (!existsSync(path)) {
    out.write(notice(`No mutation report found at \`${path}\` (the run may have timed out).`));
    return;
  }
  let report;
  try {
    report = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    out.write(notice(`Could not parse \`${path}\`: ${cell(err.message)}.`));
    return;
  }
  out.write(render(report, Number.isFinite(max) && max > 0 ? max : 10));
}

if (require.main === module) main(process.argv.slice(2));

module.exports = { MARKER, score, render, main };
