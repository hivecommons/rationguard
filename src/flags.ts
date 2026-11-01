import { getPatterns, loadPatterns, listAvailableCLIs, bundledPatternsDir, BUILTIN_PATTERNS } from '@hivecommons/pluk';
import { sanitizeForTerminal } from './sanitize.js';
import { isValidDiagnosticsSeconds, MIN_DIAGNOSTICS_INTERVAL_MS, MAX_TIMER_DELAY_MS } from './diagnostics.js';
import fs from 'node:fs';
import path from 'node:path';

const ANSI_RED = '\x1b[31m';
const ANSI_RESET = '\x1b[0m';

export const KNOWN_FLAGS = new Set([
  'category',
  'cli',
  'cli-args',
  'command',
  'dangerous',
  'diagnostics',
  'dir',
  'excuse',
  'fail-on-match',
  'file',
  'format',
  'help',
  'json',
  'log-format',
  'mode',
  'no-open',
  'no-raw',
  'patterns-dir',
  'rationguard-bin',
  'rebuttal',
  'run-dir',
  'verbose',
]);

export function parseFlags(args: string[]): { command: string; positional: string[]; flags: Record<string, string> } {
  const flags: Record<string, string> = {};
  const positional: string[] = [];
  let command = '';
  let endOfOptions = false;

  for (const arg of args) {
    if (endOfOptions) {
      positional.push(arg);
    } else if (!command && !arg.startsWith('-')) {
      command = arg;
    } else if (arg === '--') {
      endOfOptions = true;
    } else if (arg.startsWith('--')) {
      const eqIdx = arg.indexOf('=');
      const name = eqIdx > 0 ? arg.slice(2, eqIdx) : arg.slice(2);
      if (!KNOWN_FLAGS.has(name)) {
        console.error(`${ANSI_RED}Error:${ANSI_RESET} Unknown flag --${sanitizeForTerminal(name)}. See rationguard --help.`);
        process.exit(1);
      }
      flags[name] = eqIdx > 0 ? arg.slice(eqIdx + 1) : 'true';
    } else if (arg === '-h') {
      flags['help'] = 'true';
    } else {
      // A single leading '-' is text, not a flag (e.g. a "- Nothing left" bullet).
      positional.push(arg);
    }
  }

  return { command, positional, flags };
}

export function requirePathFlag(flag: string, raw: string | undefined): void {
  if (raw !== 'true') return;
  console.error(`${ANSI_RED}Error:${ANSI_RESET} --${flag} needs a value.`);
  console.error(`  Note: write --${flag}=PATH (with '='); a bare --${flag} is parsed as "true". For a path literally named "true", write --${flag}=./true.`);
  process.exit(1);
}

export function requireBooleanFlag(flag: string, raw: string | undefined): void {
  if (raw === undefined || raw === 'true' || raw === 'false') return;
  console.error(`${ANSI_RED}Error:${ANSI_RESET} Unknown --${flag} "${sanitizeForTerminal(raw)}". Boolean flags take no value (write --${flag}, or --${flag}=true|false).`);
  process.exit(1);
}

export function requireValueFlag(flag: string, raw: string | undefined): void {
  if (raw !== 'true') return;
  console.error(`${ANSI_RED}Error:${ANSI_RESET} --${flag} needs a value.`);
  console.error(`  Note: write --${flag}=<value> (with '='); a bare --${flag} is parsed as "true".`);
  process.exit(1);
}

export function requireDiagnosticsSeconds(flag: string, raw: string | undefined): void {
  if (raw === undefined || raw === 'true') return;
  if (isValidDiagnosticsSeconds(Number(raw))) return;
  console.error(`${ANSI_RED}Error:${ANSI_RESET} --${flag} "${sanitizeForTerminal(raw)}" must be a number of seconds between ${MIN_DIAGNOSTICS_INTERVAL_MS / 1000} and ${MAX_TIMER_DELAY_MS / 1000}.`);
  console.error(`  Note: write --${flag}=<seconds> (e.g. --${flag}=30), or a bare --${flag} for the 60s default.`);
  process.exit(1);
}

export function requireOneOf(flag: string, raw: string | undefined, valid: string[], label: string): void {
  if (raw === undefined || valid.includes(raw)) return;
  console.error(`${ANSI_RED}Error:${ANSI_RESET} Unknown --${flag} "${sanitizeForTerminal(raw)}". ${label}: ${valid.join(', ')}.`);
  if (raw === 'true') {
    console.error(`  Note: write --${flag}=<value> (with '='); a bare --${flag} is parsed as "true".`);
  }
  process.exit(1);
}

// run silently with an all-null pattern set (unknown --cli) or fall back to the
// bundled patterns (missing --patterns-dir).
export function requireWatchPatterns(cli: string, patternsDir: string | undefined): void {
  if (patternsDir !== undefined && !fs.existsSync(patternsDir)) {
    console.error(`${ANSI_RED}Error:${ANSI_RESET} --patterns-dir "${sanitizeForTerminal(patternsDir)}" does not exist.`);
    process.exit(1);
  }
  if (patternsDir !== undefined && !fs.existsSync(path.join(patternsDir, `${cli}.patterns`))) {
    console.error(`${ANSI_RED}Error:${ANSI_RESET} --patterns-dir "${sanitizeForTerminal(patternsDir)}" has no ${sanitizeForTerminal(cli)}.patterns file.`);
    process.exit(1);
  }
  let set;
  if (patternsDir !== undefined) {
    // loadPatterns throws on I/O errors; getPatterns would swallow them and use the bundled set.
    try {
      set = loadPatterns(patternsDir, cli);
    } catch (err) {
      console.error(`${ANSI_RED}Error:${ANSI_RESET} --patterns-dir "${sanitizeForTerminal(patternsDir)}" ${sanitizeForTerminal(cli)}.patterns cannot be read: ${sanitizeForTerminal(err instanceof Error ? err.message : String(err))}`);
      process.exit(1);
    }
  } else {
    set = getPatterns(cli);
  }
  // Mirrors pluk's unexported hasAnyPattern (src/patterns.ts); parsePatternsContent
  // never throws, so an all-null set is the only signal that nothing was parsed.
  for (const v of Object.values(set)) if (v instanceof RegExp) return;
  if (patternsDir !== undefined) {
    console.error(`${ANSI_RED}Error:${ANSI_RESET} --patterns-dir "${sanitizeForTerminal(patternsDir)}" ${sanitizeForTerminal(cli)}.patterns defines no patterns.`);
    process.exit(1);
  }
  const known = new Set<string>([
    ...(patternsDir !== undefined ? listAvailableCLIs(patternsDir) : []),
    ...listAvailableCLIs(bundledPatternsDir()),
  ]);
  if (known.size === 0) for (const c of Object.keys(BUILTIN_PATTERNS)) known.add(c);
  console.error(`${ANSI_RED}Error:${ANSI_RESET} Unknown --cli "${sanitizeForTerminal(cli)}". Known CLIs: ${[...known].join(', ')}.`);
  process.exit(1);
}
