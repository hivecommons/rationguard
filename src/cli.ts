#!/usr/bin/env node

import { check, generatePromptBlock } from './checker.js';
import { recordSighting, recordSightingIfEligible, listSightings, AUTO_LEARN_CONFIDENCE_THRESHOLD } from './learner.js';
import { getAllExcuses } from './excuses.js';
import { CATEGORY_LABELS } from './types.js';
import type { ExcuseCategory, Excuse } from './types.js';
import { Watcher, isValidSessionName } from './watcher.js';
import type { WatcherDetection } from './watcher.js';
import { discoverSessions, attach, getPatterns, loadPatterns, listAvailableCLIs, bundledPatternsDir, BUILTIN_PATTERNS, type SessionInfo } from '@hivecommons/pluk';
import { sanitizeForTerminal, stringifyForTerminal } from './sanitize.js';
import { startDiagnostics } from './diagnostics.js';
import fs from 'node:fs';
import path from 'node:path';

const ANSI_RED = '\x1b[31m';
const ANSI_YELLOW = '\x1b[33m';
const ANSI_GREEN = '\x1b[32m';
const ANSI_CYAN = '\x1b[36m';
const ANSI_DIM = '\x1b[2m';
const ANSI_BOLD = '\x1b[1m';
const ANSI_RESET = '\x1b[0m';

// One keyword hit scores 0.45 (the matcher's floor) and renders dim; two hits
// (0.6) render yellow.
const CONFIDENCE_MEDIUM = 0.6;

function colorConfidence(confidence: number): string {
  if (confidence >= AUTO_LEARN_CONFIDENCE_THRESHOLD) return `${ANSI_RED}${(confidence * 100).toFixed(0)}%${ANSI_RESET}`;
  if (confidence >= CONFIDENCE_MEDIUM) return `${ANSI_YELLOW}${(confidence * 100).toFixed(0)}%${ANSI_RESET}`;
  return `${ANSI_DIM}${(confidence * 100).toFixed(0)}%${ANSI_RESET}`;
}

const HELP = `${ANSI_BOLD}rationguard${ANSI_RESET} — Detect and rebut rationalization patterns in AI agent output

${ANSI_BOLD}QUICK START${ANSI_RESET}

  ${ANSI_CYAN}rationguard attach${ANSI_RESET} my-agent        Start agent + pluk + rationguard in one command
    --cli=claude                       CLI type (claude, copilot, gemini, goose, codex)
    --rebuttal=send                    Auto-send rebuttals back to the agent
    --dangerous                        Skip CLI permission prompts (auto-approve all)
    --dir=/path/to/project             Working directory for the agent
    --no-open                          Don't open a terminal window
    --verbose                          Show debug output for each step
    --command=<path>                   Override the CLI executable (bypasses --cli resolution)
    --no-raw                           Don't include raw terminal bytes in the pluk event log
    --cli-args="<args>"                Extra arguments passed to the agent CLI
    --rationguard-bin=<cmd>            Override the rationguard command pluk launches (default: this executable; also PLUK_RATIONGUARD_BIN)
    --run-dir=/var/run/pluk            Pluk run directory

${ANSI_BOLD}USAGE${ANSI_RESET}

  ${ANSI_CYAN}rationguard check${ANSI_RESET} <text>           Check text for excuse patterns
  ${ANSI_CYAN}rationguard check${ANSI_RESET} --file=<path>    Check file contents
  echo "..." | ${ANSI_CYAN}rationguard check${ANSI_RESET}     Check piped input
    --fail-on-match                    Exit 2 when any pattern matches (for hooks/CI gates; 1 = usage error)

  ${ANSI_CYAN}rationguard sessions${ANSI_RESET}               List active pluk-monitored agent sessions
    --run-dir=/var/run/pluk            Pluk run directory
    --json                             Output as JSON

  ${ANSI_CYAN}rationguard watch${ANSI_RESET} <session>        Real-time detection via pluk event stream
    --cli=claude                       CLI type (claude, copilot, gemini, goose, codex)
    --mode=subscribe                   subscribe (tail JSONL) or watch (classify stdin)
    --rebuttal=log                     log (print) or send (pluk-send back)
    --run-dir=/var/run/pluk            Pluk run directory
    --patterns-dir=<path>              Override pluk's CLI pattern directory
    --json                             Output detections as JSON
    --verbose                          Show debug output
    --log-format=json                  Log rebuttal delivery (watch) or match (check) events as JSON lines on stderr
    --diagnostics[=secs]               Periodic bounded health summary on stderr (default 60s)

  ${ANSI_CYAN}rationguard prompt${ANSI_RESET}                 Generate a defense table for agent prompts
    --format=yaml                      Output format: markdown (default) or yaml

  ${ANSI_CYAN}rationguard add${ANSI_RESET}                    Record a new excuse sighting (auto-promotes after 3)
    --excuse="<text>"                  The excuse pattern
    --rebuttal="<text>"                How to counter it
    --category=<category>              One of: false-completion, complexity-dodge,
                                       deferral, lane-confusion, partial-credit

  ${ANSI_CYAN}rationguard list${ANSI_RESET}                   Show all known excuses (built-in + custom)
  ${ANSI_CYAN}rationguard sightings${ANSI_RESET}              Show recorded sightings and their counts

  ${ANSI_CYAN}rationguard help${ANSI_RESET}                   Show this help
  ${ANSI_CYAN}rationguard <command> --help${ANSI_RESET}     Show this help (also -h)

${ANSI_BOLD}REAL-TIME DETECTION${ANSI_RESET}

  ${ANSI_CYAN}rationguard attach${ANSI_RESET} creates a tmux session, starts the AI CLI, wires
  pluk event capture, and runs rationguard in this terminal. A new terminal
  window opens so you can interact with the agent.

  ${ANSI_DIM}# One command — starts claude + opens terminal + watches for excuses${ANSI_RESET}
  rationguard attach my-agent --cli=claude --rebuttal=send

  ${ANSI_DIM}# Start goose in a specific project directory${ANSI_RESET}
  rationguard attach my-agent --cli=goose --dir=/path/to/project

  ${ANSI_DIM}# Watch an already-running session (no attach, just monitor)${ANSI_RESET}
  rationguard watch my-agent --rebuttal=send

${ANSI_BOLD}AUTO-LEARNING${ANSI_RESET}

  When ${ANSI_CYAN}rationguard check${ANSI_RESET} finds no match but the text looks like an excuse,
  use ${ANSI_CYAN}rationguard add${ANSI_RESET} to record a sighting. After ${ANSI_BOLD}3 sightings${ANSI_RESET} of the
  same pattern, it auto-promotes to a custom excuse in ~/.rationguard/custom-excuses.json.

${ANSI_BOLD}MODES${ANSI_RESET}

  ${ANSI_BOLD}Post-response (detection):${ANSI_RESET}  Pipe agent output through ${ANSI_CYAN}rationguard check${ANSI_RESET}
  ${ANSI_BOLD}Real-time (live):${ANSI_RESET}           ${ANSI_CYAN}rationguard watch${ANSI_RESET} <session> via pluk
  ${ANSI_BOLD}System prompt (prevention):${ANSI_RESET} Inject ${ANSI_CYAN}rationguard prompt${ANSI_RESET} output into agent instructions

${ANSI_BOLD}OUTPUT${ANSI_RESET}

  --json    Output results as JSON
`;

async function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) {
      resolve('');
      return;
    }
    const chunks: Buffer[] = [];
    process.stdin.on('data', (chunk) => {
      chunks.push(chunk as Buffer);
    });
    process.stdin.on('end', () => {
      resolve(Buffer.concat(chunks).toString('utf-8').trim());
    });
  });
}

function parseFlags(args: string[]): { command: string; positional: string[]; flags: Record<string, string> } {
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
      if (eqIdx > 0) {
        flags[arg.slice(2, eqIdx)] = arg.slice(eqIdx + 1);
      } else {
        flags[arg.slice(2)] = 'true';
      }
    } else if (arg === '-h') {
      flags['help'] = 'true';
    } else {
      // A single leading '-' is text, not a flag (e.g. a "- Nothing left" bullet).
      positional.push(arg);
    }
  }

  return { command, positional, flags };
}

async function cmdCheck(positional: string[], flags: Record<string, string>): Promise<void> {
  let input = positional.join(' ');

  const fromFile = flags['file'] !== undefined;
  if (fromFile) {
    requirePathFlag('file', flags['file']);
    const filePath = flags['file'];
    if (!fs.existsSync(filePath)) {
      console.error(`${ANSI_RED}Error:${ANSI_RESET} File not found: ${sanitizeForTerminal(filePath)}`);
      process.exit(1);
    }
    try {
      input = fs.readFileSync(filePath, 'utf-8');
    } catch (err) {
      console.error(`${ANSI_RED}Error:${ANSI_RESET} Cannot read file ${sanitizeForTerminal(filePath)}: ${sanitizeForTerminal((err as Error).message)}`);
      process.exit(1);
    }
  }

  // An explicit --file (even an empty one) must never be silently replaced by stdin.
  if (!input && !fromFile) {
    input = await readStdin();
  }

  if (!input) {
    console.error(`${ANSI_RED}Error:${ANSI_RESET} No input. Provide text, --file=<path>, or pipe input. Use -- to mark the end of options before positional text.`);
    process.exit(1);
  }

  requireOneOf('log-format', flags['log-format'], ['text', 'json'], 'Valid values');
  const jsonLog = flags['log-format'] === 'json';
  const failOnMatch = flags['fail-on-match'] === 'true';
  const allExcuses = getAllExcuses();
  const result = check(input, { excuses: allExcuses }, {
    onEvent: jsonLog ? (event) => console.error(JSON.stringify(event)) : undefined,
  });

  // Eligibility (confidence threshold, project-source exclusion) is decided
  // once in learner.ts and shared with watcher.ts — see recordSightingIfEligible.
  for (const match of result.matches) {
    recordSightingIfEligible(match);
  }

  if (flags['json'] === 'true') {
    console.log(stringifyForTerminal(result, 2));
    if (failOnMatch && !result.clean) process.exitCode = 2;
    return;
  }

  if (result.clean) {
    console.log(`${ANSI_GREEN}✓${ANSI_RESET} Clean — no rationalization patterns detected.`);
    return;
  }

  console.log(`${ANSI_RED}✗${ANSI_RESET} Found ${result.matches.length} rationalization pattern(s):\n`);

  for (const match of result.matches) {
    if (!match.excuse) continue;
    const category = CATEGORY_LABELS[match.excuse.category];
    console.log(`  ${colorConfidence(match.confidence)} ${ANSI_BOLD}${category}${ANSI_RESET}`);
    console.log(`     Pattern:  "${sanitizeForTerminal(match.excuse.pattern)}"`);
    console.log(`     Matched:  "${sanitizeForTerminal(match.matchedText)}"`);
    console.log(`     Rebuttal: ${sanitizeForTerminal(match.excuse.rebuttal)}`);
    console.log();
  }
  if (failOnMatch) process.exitCode = 2;
}

function cmdPrompt(flags: Record<string, string>): void {
  requireOneOf('format', flags['format'], ['markdown', 'yaml'], 'Valid values');
  // Project-local excuses come from the (potentially untrusted) working
  // directory — a cloned repo must never inject text into a block that is
  // destined for agent instructions. Builtin + user excuses only.
  const allExcuses = getAllExcuses().filter(e => e.source !== 'project');
  const block = generatePromptBlock({ excuses: allExcuses });

  if (flags['format'] === 'yaml') {
    console.log('rationalization_defense: |');
    for (const line of block.split('\n')) {
      console.log(`  ${line}`);
    }
    return;
  }

  console.log(block);
}

function cmdAdd(positional: string[], flags: Record<string, string>): void {
  requireValueFlag('excuse', flags['excuse']);
  requireValueFlag('rebuttal', flags['rebuttal']);
  const excuse = positional.join(' ') || flags['excuse'];
  if (!excuse) {
    console.error(`${ANSI_RED}Error:${ANSI_RESET} Provide excuse text as an argument or --excuse="<text>". Use -- to mark the end of options before positional text.`);
    console.error(`  rationguard add "I already handled that" --category=false-completion`);
    process.exit(1);
  }

  // An unknown category would be stored on the sighting as-is and, on the
  // third sighting, promoted into an excuse with no rebuttal that
  // isValidExcuse then silently drops — so reject it up front.
  const rawCategory = flags['category'];
  if (rawCategory !== undefined && !Object.prototype.hasOwnProperty.call(CATEGORY_LABELS, rawCategory)) {
    const valid = Object.keys(CATEGORY_LABELS).join(', ');
    console.error(`${ANSI_RED}Error:${ANSI_RESET} Unknown category "${sanitizeForTerminal(rawCategory)}". Valid categories: ${valid}.`);
    if (rawCategory === 'true') {
      console.error(`  Note: write --category=<name> (with '='); "--category <name>" is parsed as a bare flag and <name> becomes excuse text.`);
    }
    process.exit(1);
  }
  const category = rawCategory as ExcuseCategory | undefined;
  const rebuttal = flags['rebuttal'] || undefined;

  let result: ReturnType<typeof recordSighting>;
  try {
    result = recordSighting(excuse, category, rebuttal);
  } catch (err) {
    console.error(`${ANSI_RED}Error:${ANSI_RESET} Could not write the trusted store: ${sanitizeForTerminal((err as Error).message)}`);
    process.exit(1);
  }

  if (result.count === 0) {
    console.error(`${ANSI_RED}Error:${ANSI_RESET} Could not determine a home directory for the trusted store; sighting not recorded.`);
    process.exit(1);
  }

  if (result.autoPromoted && result.excuse) {
    console.log(`${ANSI_GREEN}⬆${ANSI_RESET} Auto-promoted to custom excuse! (seen ${result.count} times)`);
    console.log(`   Category: ${CATEGORY_LABELS[result.excuse.category]}`);
    console.log(`   Rebuttal: ${sanitizeForTerminal(result.excuse.rebuttal)}`);
  } else if (result.isNew) {
    console.log(`${ANSI_YELLOW}+${ANSI_RESET} Recorded new sighting (${result.count}/3 for auto-promotion)`);
  } else {
    console.log(`${ANSI_YELLOW}↑${ANSI_RESET} Sighting count: ${result.count}/3 for auto-promotion`);
  }
}

function cmdList(flags: Record<string, string>): void {
  const allExcuses = getAllExcuses();

  if (flags['json'] === 'true') {
    console.log(stringifyForTerminal(allExcuses, 2));
    return;
  }

  const grouped = new Map<string, Excuse[]>();
  for (const excuse of allExcuses) {
    const cat = CATEGORY_LABELS[excuse.category];
    if (!grouped.has(cat)) grouped.set(cat, []);
    grouped.get(cat)!.push(excuse);
  }

  for (const [category, excuses] of grouped) {
    console.log(`\n${ANSI_BOLD}${category}${ANSI_RESET}`);
    for (const excuse of excuses) {
      console.log(`  ${ANSI_CYAN}•${ANSI_RESET} ${sanitizeForTerminal(excuse.pattern)}`);
      console.log(`    ${ANSI_DIM}→ ${sanitizeForTerminal(excuse.rebuttal)}${ANSI_RESET}`);
    }
  }
  console.log();
}

function requirePathFlag(flag: string, raw: string | undefined): void {
  if (raw !== 'true') return;
  console.error(`${ANSI_RED}Error:${ANSI_RESET} --${flag} needs a value.`);
  console.error(`  Note: write --${flag}=PATH (with '='); a bare --${flag} is parsed as "true". For a path literally named "true", write --${flag}=./true.`);
  process.exit(1);
}

function requireValueFlag(flag: string, raw: string | undefined): void {
  if (raw !== 'true') return;
  console.error(`${ANSI_RED}Error:${ANSI_RESET} --${flag} needs a value.`);
  console.error(`  Note: write --${flag}=<value> (with '='); a bare --${flag} is parsed as "true".`);
  process.exit(1);
}

function requirePositiveSeconds(flag: string, raw: string | undefined): void {
  if (raw === undefined || raw === 'true') return;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds > 0) return;
  console.error(`${ANSI_RED}Error:${ANSI_RESET} --${flag} "${sanitizeForTerminal(raw)}" must be a positive number of seconds.`);
  console.error(`  Note: write --${flag}=<seconds> (e.g. --${flag}=30), or a bare --${flag} for the 60s default.`);
  process.exit(1);
}

function requireOneOf(flag: string, raw: string | undefined, valid: string[], label: string): void {
  if (raw === undefined || valid.includes(raw)) return;
  console.error(`${ANSI_RED}Error:${ANSI_RESET} Unknown --${flag} "${sanitizeForTerminal(raw)}". ${label}: ${valid.join(', ')}.`);
  if (raw === 'true') {
    console.error(`  Note: write --${flag}=<value> (with '='); a bare --${flag} is parsed as "true".`);
  }
  process.exit(1);
}

// Only --mode=watch hands --cli/--patterns-dir to pluk, which would otherwise
// run silently with an all-null pattern set (unknown --cli) or fall back to the
// bundled patterns (missing --patterns-dir).
function requireWatchPatterns(cli: string, patternsDir: string | undefined): void {
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

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

// pluk takes the rationguard command as a shell-word string.
function selfCommand(): string {
  return `${shellQuote(process.execPath)} ${shellQuote(process.argv[1] ?? '')}`;
}

function cmdAttach(positional: string[], flags: Record<string, string>): void {
  const session = positional[0];

  if (!session) {
    console.error(`${ANSI_RED}Error:${ANSI_RESET} session name is required`);
    console.error('  rationguard attach my-agent --cli=claude --rebuttal=send');
    process.exit(1);
  }

  requireOneOf('rebuttal', flags['rebuttal'], ['log', 'send'], 'Valid values');
  requirePathFlag('run-dir', flags['run-dir']);
  requireValueFlag('cli', flags['cli']);
  requirePathFlag('dir', flags['dir']);
  requirePathFlag('command', flags['command']);
  requireValueFlag('cli-args', flags['cli-args']);
  requireValueFlag('rationguard-bin', flags['rationguard-bin']);

  // Default to the running process: otherwise pluk re-resolves `rationguard`
  // on PATH and throws when run via npx, `node dist/cli.js` or node_modules/.bin.
  // An empty/blank --rationguard-bin= or PLUK_RATIONGUARD_BIN counts as unset:
  // pluk would trim it and fall back to the same PATH lookup.
  const flagBin = flags['rationguard-bin']?.trim();
  const envBin = process.env['PLUK_RATIONGUARD_BIN']?.trim();
  const rationguardBin = flagBin || envBin || selfCommand();

  attach({
    session,
    cli: flags['cli'] ?? 'claude',
    cliCommand: flags['command'],
    cliArgs: flags['cli-args'],
    runDir: flags['run-dir'],
    rationguard: true,
    rationguardBin,
    rebuttal: (flags['rebuttal'] as 'log' | 'send') ?? 'log',
    noRaw: flags['no-raw'] === 'true',
    workDir: flags['dir'],
    noOpen: flags['no-open'] === 'true',
    verbose: flags['verbose'] === 'true',
    dangerouslySkipPermissions: flags['dangerous'] === 'true',
  });
}

function cmdSessions(flags: Record<string, string>): void {
  requirePathFlag('run-dir', flags['run-dir']);
  const runDir = flags['run-dir'] ?? process.env['PLUK_RUN_DIR'];
  const sessions = discoverSessions(runDir);

  if (flags['json'] === 'true') {
    console.log(stringifyForTerminal(sessions, 2));
    return;
  }

  if (sessions.length === 0) {
    console.log(`${ANSI_DIM}No active pluk sessions found.${ANSI_RESET}`);
    console.log(`${ANSI_DIM}Set PLUK_RUN_DIR or use --run-dir to point to your pluk logs.${ANSI_RESET}`);
    return;
  }

  const COL_SESSION = 17;
  const COL_CLI = 10;
  const COL_STATE = 10;
  const COL_TMUX = 6;
  const COL_AGO = 12;

  console.log(
    `\n${ANSI_BOLD}${'SESSION'.padEnd(COL_SESSION)}${'CLI'.padEnd(COL_CLI)}${'STATE'.padEnd(COL_STATE)}${'TMUX'.padEnd(COL_TMUX)}${'LAST ACTIVITY'.padEnd(COL_AGO)}EVENTS${ANSI_RESET}`,
  );

  for (const s of sessions) {
    const tmuxIcon = s.tmuxAlive ? `${ANSI_GREEN}●${ANSI_RESET}` : `${ANSI_DIM}○${ANSI_RESET}`;
    const stateColor = s.state === 'working' ? ANSI_GREEN : s.state === 'idle' ? ANSI_CYAN : ANSI_DIM;
    console.log(
      `${sanitizeForTerminal(s.session).padEnd(COL_SESSION)}${sanitizeForTerminal(s.cli).padEnd(COL_CLI)}${stateColor}${sanitizeForTerminal(s.state).padEnd(COL_STATE)}${ANSI_RESET}${tmuxIcon}${''.padEnd(COL_TMUX - 2)}${sanitizeForTerminal(s.lastActivityAgo).padEnd(COL_AGO)}${s.eventCount}`,
    );
  }

  console.log(`\n${ANSI_DIM}Use: rationguard watch <session> to start monitoring${ANSI_RESET}\n`);
}

async function cmdWatch(positional: string[], flags: Record<string, string>): Promise<void> {
  const session = positional[0];

  if (!session) {
    console.error(`${ANSI_RED}Error:${ANSI_RESET} session name is required`);
    console.error('  rationguard watch <session>');
    console.error('  rationguard watch my-agent --cli=claude --rebuttal=send');
    process.exit(1);
  }

  if (!isValidSessionName(session)) {
    console.error(`${ANSI_RED}Error:${ANSI_RESET} invalid session name "${sanitizeForTerminal(session)}" — use only letters, numbers, underscore, and dash`);
    process.exit(1);
  }

  requireOneOf('mode', flags['mode'], ['subscribe', 'watch'], 'Valid modes');
  requirePathFlag('run-dir', flags['run-dir']);
  requireValueFlag('cli', flags['cli']);
  requirePathFlag('patterns-dir', flags['patterns-dir']);
  requireOneOf('rebuttal', flags['rebuttal'], ['log', 'send'], 'Valid values');
  requirePositiveSeconds('diagnostics', flags['diagnostics']);
  const mode = (flags['mode'] ?? 'subscribe') as 'subscribe' | 'watch';
  const rebuttalMode = (flags['rebuttal'] ?? 'log') as 'log' | 'send';
  const jsonOutput = flags['json'] === 'true';
  const verbose = flags['verbose'] === 'true';
  requireOneOf('log-format', flags['log-format'], ['text', 'json'], 'Valid values');
  const logFormat = (flags['log-format'] ?? 'text') as 'text' | 'json';
  const cli = flags['cli'] ?? 'claude';
  if (mode === 'watch') requireWatchPatterns(cli, flags['patterns-dir']);

  // In JSON mode stdout carries only JSON Lines, so status text goes to stderr.
  const status = jsonOutput ? console.error : console.log;
  status(`${ANSI_BOLD}rationguard${ANSI_RESET} watching ${ANSI_CYAN}${session}${ANSI_RESET} (mode=${mode}, rebuttal=${rebuttalMode})`);
  status(`${ANSI_DIM}Press Ctrl+C to stop.${ANSI_RESET}\n`);

  const watcher = new Watcher({
    session,
    cli,
    runDir: flags['run-dir'],
    patternsDir: flags['patterns-dir'],
    mode,
    rebuttal: rebuttalMode,
    verbose,
    logFormat,
    onDetection(detection: WatcherDetection) {
      if (jsonOutput) {
        console.log(stringifyForTerminal({
          timestamp: detection.timestamp,
          session,
          matches: detection.matches.map(m => ({
            pattern: m.excuse?.pattern,
            category: m.excuse?.category,
            confidence: m.confidence,
            matchedText: m.matchedText,
            rebuttal: m.excuse?.rebuttal,
          })),
        }));
        return;
      }

      const sentPatterns = new Set(detection.sentRebuttals ?? []);

      for (const match of detection.matches) {
        if (!match.excuse) continue;
        const category = CATEGORY_LABELS[match.excuse.category];
        console.log(`${ANSI_RED}⚠${ANSI_RESET} ${colorConfidence(match.confidence)} ${ANSI_BOLD}${category}${ANSI_RESET} — "${sanitizeForTerminal(match.matchedText)}"`);
        console.log(`  ${ANSI_DIM}Rebuttal:${ANSI_RESET} ${sanitizeForTerminal(match.excuse.rebuttal)}`);

        if (rebuttalMode === 'send') {
          if (sentPatterns.has(match.excuse.pattern)) {
            console.log(`  ${ANSI_GREEN}→ Sent rebuttal to ${session}${ANSI_RESET}`);
          } else {
            console.log(`  ${ANSI_DIM}→ Rebuttal suppressed (cooldown/dedup)${ANSI_RESET}`);
          }
        }
        console.log();
      }
    },
  });

  const stopDiagnostics = startDiagnostics('watch', () => ({ ...watcher.stats() }), flags['diagnostics']);

  watcher.on('error', (err: Error) => {
    process.exitCode = 1;
    console.error(`${ANSI_RED}Error:${ANSI_RESET} ${sanitizeForTerminal(err.message)}`);
  });

  process.on('SIGINT', () => {
    watcher.stop();
    stopDiagnostics();
    status(`\n${ANSI_DIM}Stopped watching.${ANSI_RESET}`);
    process.exit(0);
  });

  await watcher.start();
}

function cmdSightings(flags: Record<string, string>): void {
  const sightings = listSightings();

  if (flags['json'] === 'true') {
    console.log(stringifyForTerminal(sightings, 2));
    return;
  }

  if (sightings.length === 0) {
    console.log(`${ANSI_DIM}No sightings recorded yet. Use ${ANSI_CYAN}rationguard add${ANSI_RESET}${ANSI_DIM} to record excuses.${ANSI_RESET}`);
    return;
  }

  console.log(`\n${ANSI_BOLD}Recorded Sightings${ANSI_RESET} (sorted by frequency)\n`);
  for (const s of sightings) {
    const status = s.promoted
      ? `${ANSI_GREEN}promoted${ANSI_RESET}`
      : `${s.count}/3`;
    const category = CATEGORY_LABELS[s.suggestedCategory];
    console.log(`  ${ANSI_BOLD}${s.count}×${ANSI_RESET} "${sanitizeForTerminal(s.text)}" ${ANSI_DIM}[${category}]${ANSI_RESET} ${status}`);
  }
  console.log();
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const { command, positional, flags } = parseFlags(args);

  if (flags['help'] === 'true' || args.includes('-h')) {
    console.log(HELP);
    return;
  }

  switch (command) {
    case 'attach':
      cmdAttach(positional, flags);
      break;
    case 'check':
      await cmdCheck(positional, flags);
      break;
    case 'sessions':
    case 'ls':
      cmdSessions(flags);
      break;
    case 'watch':
      await cmdWatch(positional, flags);
      break;
    case 'prompt':
      cmdPrompt(flags);
      break;
    case 'add':
      cmdAdd(positional, flags);
      break;
    case 'list':
      cmdList(flags);
      break;
    case 'sightings':
      cmdSightings(flags);
      break;
    case 'help':
      console.log(HELP);
      break;
    case '':
      // Implicit check fallback: if we have input (positional text or file flag),
      // treat as check; otherwise show help
      if (positional.length > 0 || flags['file']) {
        await cmdCheck(positional, flags);
      } else {
        console.log(HELP);
      }
      break;
    default:
      // Treat unknown command as check input
      await cmdCheck([command, ...positional], flags);
      break;
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
