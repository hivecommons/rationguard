#!/usr/bin/env node

import { check, generatePromptBlock } from './checker.js';
import { recordSighting, recordSightingIfEligible, listSightings, AUTO_LEARN_CONFIDENCE_THRESHOLD } from './learner.js';
import { getAllExcuses } from './excuses.js';
import { CATEGORY_LABELS } from './types.js';
import type { ExcuseCategory, Excuse } from './types.js';
import { Watcher } from './watcher.js';
import type { WatcherDetection } from './watcher.js';
import { discoverSessions, attach, type SessionInfo } from '@hivecommons/pluk';
import { sanitizeForTerminal } from './sanitize.js';
import { startDiagnostics } from './diagnostics.js';
import fs from 'node:fs';

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

${ANSI_BOLD}USAGE${ANSI_RESET}

  ${ANSI_CYAN}rationguard check${ANSI_RESET} <text>           Check text for excuse patterns
  ${ANSI_CYAN}rationguard check${ANSI_RESET} --file=<path>    Check file contents
  echo "..." | ${ANSI_CYAN}rationguard check${ANSI_RESET}     Check piped input

  ${ANSI_CYAN}rationguard sessions${ANSI_RESET}               List active pluk-monitored agent sessions
    --run-dir=/var/run/pluk            Pluk run directory
    --json                             Output as JSON

  ${ANSI_CYAN}rationguard watch${ANSI_RESET} <session>        Real-time detection via pluk event stream
    --cli=claude                       CLI type (claude, copilot, gemini, goose)
    --mode=subscribe                   subscribe (tail JSONL) or watch (classify stdin)
    --rebuttal=log                     log (print) or send (pluk-send back)
    --run-dir=/var/run/pluk            Pluk run directory
    --json                             Output detections as JSON
    --verbose                          Show debug output
    --diagnostics[=secs]               Periodic bounded health summary on stderr (default 60s)

  ${ANSI_CYAN}rationguard prompt${ANSI_RESET}                 Generate a defense table for agent prompts
  ${ANSI_CYAN}rationguard prompt${ANSI_RESET} --format=yaml   Output as YAML block

  ${ANSI_CYAN}rationguard add${ANSI_RESET}                    Record a new excuse sighting (auto-promotes after 3)
    --excuse="<text>"                  The excuse pattern
    --rebuttal="<text>"                How to counter it
    --category=<category>              One of: false-completion, complexity-dodge,
                                       deferral, lane-confusion, partial-credit

  ${ANSI_CYAN}rationguard list${ANSI_RESET}                   Show all known excuses (built-in + custom)
  ${ANSI_CYAN}rationguard sightings${ANSI_RESET}              Show recorded sightings and their counts

  ${ANSI_CYAN}rationguard help${ANSI_RESET}                   Show this help

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
  same pattern, it auto-promotes to a custom excuse in .rationguard/.

${ANSI_BOLD}MODES${ANSI_RESET}

  ${ANSI_BOLD}Post-response (detection):${ANSI_RESET}  Pipe agent output through ${ANSI_CYAN}rationguard check${ANSI_RESET}
  ${ANSI_BOLD}Real-time (live):${ANSI_RESET}           ${ANSI_CYAN}rationguard watch${ANSI_RESET} <session> via pluk
  ${ANSI_BOLD}System prompt (prevention):${ANSI_RESET} Inject ${ANSI_CYAN}rationguard prompt${ANSI_RESET} output into agent instructions

${ANSI_BOLD}OUTPUT${ANSI_RESET}

  --json    Output results as JSON
`;

async function readStdin(): Promise<string> {
  const STDIN_TIMEOUT_MS = 100;
  return new Promise((resolve) => {
    if (process.stdin.isTTY) {
      resolve('');
      return;
    }
    const chunks: Buffer[] = [];
    const timer = setTimeout(() => resolve(''), STDIN_TIMEOUT_MS);
    process.stdin.on('data', (chunk) => {
      clearTimeout(timer);
      chunks.push(chunk as Buffer);
    });
    process.stdin.on('end', () => {
      clearTimeout(timer);
      resolve(Buffer.concat(chunks).toString('utf-8').trim());
    });
  });
}

function parseFlags(args: string[]): { command: string; positional: string[]; flags: Record<string, string> } {
  const flags: Record<string, string> = {};
  const positional: string[] = [];
  let command = '';

  for (const arg of args) {
    if (!command && !arg.startsWith('-')) {
      command = arg;
    } else if (arg.startsWith('--')) {
      const eqIdx = arg.indexOf('=');
      if (eqIdx > 0) {
        flags[arg.slice(2, eqIdx)] = arg.slice(eqIdx + 1);
      } else {
        flags[arg.slice(2)] = 'true';
      }
    } else if (!arg.startsWith('-')) {
      positional.push(arg);
    }
  }

  return { command, positional, flags };
}

async function cmdCheck(positional: string[], flags: Record<string, string>): Promise<void> {
  let input = positional.join(' ');

  if (flags['file']) {
    const filePath = flags['file'];
    if (!fs.existsSync(filePath)) {
      console.error(`${ANSI_RED}Error:${ANSI_RESET} File not found: ${filePath}`);
      process.exit(1);
    }
    input = fs.readFileSync(filePath, 'utf-8');
  }

  if (!input) {
    input = await readStdin();
  }

  if (!input) {
    console.error(`${ANSI_RED}Error:${ANSI_RESET} No input. Provide text, --file=<path>, or pipe input.`);
    process.exit(1);
  }

  const allExcuses = getAllExcuses();
  const result = check(input, { excuses: allExcuses });

  if (flags['json'] === 'true') {
    console.log(JSON.stringify(result, null, 2));
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

  // Eligibility (confidence threshold, project-source exclusion) is decided
  // once in learner.ts and shared with watcher.ts — see recordSightingIfEligible.
  for (const match of result.matches) {
    recordSightingIfEligible(match);
  }
}

function cmdPrompt(flags: Record<string, string>): void {
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
  const excuse = positional.join(' ') || flags['excuse'];
  if (!excuse) {
    console.error(`${ANSI_RED}Error:${ANSI_RESET} Provide excuse text as an argument or --excuse="<text>".`);
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

  const result = recordSighting(excuse, category, rebuttal);

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
    console.log(JSON.stringify(allExcuses, null, 2));
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

function cmdAttach(positional: string[], flags: Record<string, string>): void {
  const session = positional[0];

  if (!session) {
    console.error(`${ANSI_RED}Error:${ANSI_RESET} session name is required`);
    console.error('  rationguard attach my-agent --cli=claude --rebuttal=send');
    process.exit(1);
  }

  attach({
    session,
    cli: flags['cli'] ?? 'claude',
    cliCommand: flags['command'],
    cliArgs: flags['cli-args'],
    runDir: flags['run-dir'],
    rationguard: true,
    rebuttal: (flags['rebuttal'] as 'log' | 'send') ?? 'log',
    noRaw: flags['no-raw'] === 'true',
    workDir: flags['dir'],
    noOpen: flags['no-open'] === 'true',
    verbose: flags['verbose'] === 'true',
    dangerouslySkipPermissions: flags['dangerous'] === 'true',
  });
}

function cmdSessions(flags: Record<string, string>): void {
  const runDir = flags['run-dir'] ?? process.env['PLUK_RUN_DIR'];
  const sessions = discoverSessions(runDir);

  if (flags['json'] === 'true') {
    console.log(JSON.stringify(sessions, null, 2));
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

  const mode = (flags['mode'] ?? 'subscribe') as 'subscribe' | 'watch';
  const rebuttalMode = (flags['rebuttal'] ?? 'log') as 'log' | 'send';
  const jsonOutput = flags['json'] === 'true';
  const verbose = flags['verbose'] === 'true';

  // In JSON mode stdout carries only JSON Lines, so status text goes to stderr.
  const status = jsonOutput ? console.error : console.log;
  status(`${ANSI_BOLD}rationguard${ANSI_RESET} watching ${ANSI_CYAN}${session}${ANSI_RESET} (mode=${mode}, rebuttal=${rebuttalMode})`);
  status(`${ANSI_DIM}Press Ctrl+C to stop.${ANSI_RESET}\n`);

  const watcher = new Watcher({
    session,
    cli: flags['cli'] ?? 'claude',
    runDir: flags['run-dir'],
    patternsDir: flags['patterns-dir'],
    mode,
    rebuttal: rebuttalMode,
    verbose,
    onDetection(detection: WatcherDetection) {
      if (jsonOutput) {
        console.log(JSON.stringify({
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
    console.error(`${ANSI_RED}Error:${ANSI_RESET} ${err.message}`);
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

  if (sightings.length === 0) {
    console.log(`${ANSI_DIM}No sightings recorded yet. Use ${ANSI_CYAN}rationguard add${ANSI_RESET}${ANSI_DIM} to record excuses.${ANSI_RESET}`);
    return;
  }

  if (flags['json'] === 'true') {
    console.log(JSON.stringify(sightings, null, 2));
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
    case '':
      console.log(HELP);
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
