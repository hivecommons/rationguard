import { EventEmitter } from 'node:events';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { check } from './checker.js';
import { recordSightingIfEligible } from './learner.js';
import { getAllExcuses } from './excuses.js';
import { sanitizeForTerminal, stripTerminalEscapes } from './sanitize.js';
import type { Excuse, CheckResult, MatchResult } from './types.js';
import type { PlukEvent, PlukEventType, Subscriber, WatchOptions } from '@hivecommons/pluk';

const RAW_OUTPUT_BUFFER_MAX_LINES = 20;
const RAW_OUTPUT_FLUSH_MS = 2_000;
const REBUTTAL_COOLDOWN_MS = 30_000;
const POST_REBUTTAL_QUIET_MS = 60_000;

export interface WatcherDetection {
  event: PlukEvent;
  result: CheckResult;
  matches: MatchResult[];
  timestamp: string;
  sentRebuttals?: string[];
}

export interface WatcherOptions {
  session: string;
  cli?: string;
  runDir?: string;
  patternsDir?: string;
  mode: 'subscribe' | 'watch';
  filter?: PlukEventType[];
  rebuttal?: 'log' | 'send';
  quiet?: boolean;
  verbose?: boolean;
  onDetection?: (detection: WatcherDetection) => void;
}

const SESSION_NAME_RE = /^[a-zA-Z0-9_.-]+$/;

/**
 * Resolve the pluk-send binary that matches the @hivecommons/pluk version
 * this package actually depends on, instead of trusting whatever `pluk-send`
 * happens to be first on PATH — a shelled-out lookup can silently diverge
 * from the npm-pinned dependency `Subscriber`/`watch`/`discoverSessions`/
 * `attach` are resolved against (hivecommons/rationguard#77).
 *
 * `RATIONGUARD_PLUK_SEND_BIN` is an internal test hook; it is not documented
 * for end users.
 */
export function resolvePlukSendBin(): string {
  const override = process.env['RATIONGUARD_PLUK_SEND_BIN'];
  if (override) return override;
  try {
    const require = createRequire(import.meta.url);
    const pkgJsonPath = require.resolve('@hivecommons/pluk/package.json');
    const nodeModulesDir = dirname(dirname(dirname(pkgJsonPath)));
    const binPath = join(nodeModulesDir, '.bin', 'pluk-send');
    if (existsSync(binPath)) return binPath;
  } catch {
    // @hivecommons/pluk isn't resolvable from here (e.g. an unusual install
    // layout) — fall back to whatever pluk-send is first on PATH.
  }
  return 'pluk-send';
}

function validateSession(session: string): void {
  if (!SESSION_NAME_RE.test(session)) {
    throw new Error(`Invalid session name: ${session}`);
  }
}

/**
 * Collapse CR/LF and other control characters so a rebuttal is delivered as
 * exactly one line followed by one Enter — embedded newlines would otherwise
 * submit extra, attacker-controllable lines to the agent CLI.
 */
function sanitizeRebuttal(rebuttal: string): string {
  return rebuttal.replace(/[\x00-\x1f\x7f]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function sendRebuttal(session: string, rebuttalRaw: string, verbose = false): boolean {
  validateSession(session);
  const rebuttal = sanitizeRebuttal(rebuttalRaw);
  if (!rebuttal) return false;

  if (verbose) {
    console.error(`\x1b[2m[rationguard]\x1b[0m sendRebuttal: trying pluk-send`);
  }
  try {
    execFileSync(resolvePlukSendBin(), [`--session=${session}`, `--text=${rebuttal}`, '--enter'], { stdio: 'pipe' });
    if (verbose) {
      console.error(`\x1b[2m[rationguard]\x1b[0m sendRebuttal: pluk-send succeeded`);
    }
    return true;
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    if (verbose) {
      console.error(`\x1b[2m[rationguard]\x1b[0m sendRebuttal: pluk-send failed: ${errMsg}`);
      console.error(`\x1b[2m[rationguard]\x1b[0m sendRebuttal: falling back to tmux send-keys`);
    }
    try {
      // `--` ends option parsing: tmux otherwise reads a rebuttal that starts
      // with '-' as send-keys flags (-R/-X/-N) instead of literal text.
      execFileSync('tmux', ['send-keys', '-l', '-t', session, '--', rebuttal], { stdio: 'pipe' });
      execFileSync('tmux', ['send-keys', '-t', session, 'Enter'], { stdio: 'pipe' });
      if (verbose) {
        console.error(`\x1b[2m[rationguard]\x1b[0m sendRebuttal: tmux send-keys succeeded`);
      }
      return true;
    } catch (err2) {
      const errMsg2 = err2 instanceof Error ? err2.message : String(err2);
      console.error(`\x1b[2m[rationguard]\x1b[0m sendRebuttal: FAILED both methods: ${sanitizeForTerminal(errMsg2).slice(0, 200)}`);
      return false;
    }
  }
}

const ANSI_DIM = '\x1b[2m';
const ANSI_RESET = '\x1b[0m';

/**
 * Bounded counters a long-lived watch session accumulates. Every field is a
 * fixed-cardinality count — never a raw message, pattern, or session name —
 * so this is safe to snapshot into `--diagnostics` output.
 */
export interface WatcherStats {
  flushCount: number;
  cleanCount: number;
  matchCount: number;
  rebuttalSent: number;
  rebuttalFailed: number;
  rebuttalSuppressed: number;
  bufferFlushedFull: number;
}

export function emptyWatcherStats(): WatcherStats {
  return {
    flushCount: 0,
    cleanCount: 0,
    matchCount: 0,
    rebuttalSent: 0,
    rebuttalFailed: 0,
    rebuttalSuppressed: 0,
    bufferFlushedFull: 0,
  };
}

export class Watcher extends EventEmitter {
  private excuses: Excuse[];
  private opts: WatcherOptions;
  private buffer: string[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private subscriber: Subscriber | null = null;
  private watchHandle: { stop: () => void } | null = null;
  private verbose: boolean;
  private flushCount = 0;
  private rebuttalCooldowns: Map<string, number> = new Map();
  private lastRebuttalSentAt = 0;
  private stats_: WatcherStats = emptyWatcherStats();

  constructor(opts: WatcherOptions) {
    super();
    this.opts = opts;
    this.excuses = getAllExcuses();
    this.verbose = opts.verbose ?? false;
  }

  private log(msg: string): void {
    if (this.verbose) {
      console.error(`${ANSI_DIM}[rationguard]${ANSI_RESET} ${msg}`);
    }
  }

  /**
   * Print-safety boundary for values interpolated into verbose log lines
   * that rationguard does not own: excuse patterns/rebuttals (the
   * project-local store is repo-controlled) and pluk event fields. Same
   * rule cli.ts applies to everything it prints.
   */
  private safe(value: unknown): string {
    return sanitizeForTerminal(String(value ?? ''));
  }

  /** Snapshot of bounded counters since the watcher started (see WatcherStats). */
  stats(): WatcherStats {
    return { ...this.stats_ };
  }

  async start(): Promise<void> {
    this.log(`starting watcher: session=${this.opts.session} mode=${this.opts.mode} cli=${this.opts.cli ?? 'claude'} rebuttal=${this.opts.rebuttal ?? 'none'}`);
    this.log(`loaded ${this.excuses.length} excuses across ${new Set(this.excuses.map(e => e.category)).size} categories`);
    const pluk = await import('@hivecommons/pluk');

    if (this.opts.mode === 'subscribe') {
      this.log(`subscribing to JSONL log (runDir=${this.opts.runDir ?? 'default'})`);
      this.subscriber = new pluk.Subscriber({
        session: this.opts.session,
        runDir: this.opts.runDir,
        filter: this.opts.filter ?? ['raw_output', 'state_change'],
        verbose: this.verbose,
      });

      this.subscriber.on('event', (event: PlukEvent) => this.handleEvent(event));
      this.subscriber.on('error', (err: Error) => this.emit('error', err));

      await this.subscriber.start();
    } else {
      this.log('starting in watch mode (classifying stdin)');
      this.watchHandle = pluk.watch({
        session: this.opts.session,
        cli: this.opts.cli ?? 'claude',
        patternsDir: this.opts.patternsDir,
        includeRaw: true,
        onEvent: (event: PlukEvent) => this.handleEvent(event),
      });
    }
  }

  stop(): void {
    if (this.subscriber) this.subscriber.stop();
    if (this.watchHandle) this.watchHandle.stop();
    this.flushBuffer();
    if (this.flushTimer) clearTimeout(this.flushTimer);
  }

  private handleEvent(event: PlukEvent): void {
    if (event.type === 'raw_output') {
      this.buffer.push(event.data['line'] ?? '');
      this.scheduleFlush();

      if (this.buffer.length >= RAW_OUTPUT_BUFFER_MAX_LINES) {
        this.log(`buffer full (${RAW_OUTPUT_BUFFER_MAX_LINES} lines), flushing`);
        this.stats_.bufferFlushedFull++;
        this.flushBuffer();
      }
      return;
    }

    if (event.type === 'state_change') {
      this.log(`state_change: ${this.safe(event.data['from'])} → ${this.safe(event.data['to'])}`);
      if (event.data['to'] === 'idle') {
        this.flushBuffer();
      }
    }

    this.emit('pluk-event', event);
  }

  private scheduleFlush(): void {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flushBuffer();
    }, RAW_OUTPUT_FLUSH_MS);
  }

  private flushBuffer(): void {
    if (this.buffer.length === 0) return;

    this.flushCount++;
    this.stats_.flushCount++;
    const lineCount = this.buffer.length;
    const text = this.buffer.join('\n');
    this.buffer = [];

    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }

    // Only used to build the human-readable log preview below; pattern
    // matching runs against the raw, unstripped `text`. Uses the shared
    // escape-stripping helper from sanitize.ts so this cleanup can't drift
    // out of sync with the operator-facing print-safety boundary.
    const stripped = stripTerminalEscapes(text, '').trim();
    const preview = stripped.slice(0, 200).replace(/\n/g, ' ');
    this.log(`flush #${this.flushCount}: checking ${lineCount} lines (${text.length} chars)`);
    this.log(`flush #${this.flushCount}: text: "${preview}${stripped.length > 200 ? '...' : ''}"`);
    const result = check(text, { excuses: this.excuses });

    if (result.clean) {
      this.log(`flush #${this.flushCount}: clean`);
      this.stats_.cleanCount++;
    }

    const quietRemaining = POST_REBUTTAL_QUIET_MS - (Date.now() - this.lastRebuttalSentAt);
    if (!result.clean && quietRemaining > 0) {
      this.log(`flush #${this.flushCount}: ${result.matches.length} match(es) suppressed (post-rebuttal quiet period, ${Math.round(quietRemaining / 1000)}s remaining)`);
      this.stats_.rebuttalSuppressed += result.matches.length;
      return;
    }

    if (!result.clean) {
      this.log(`flush #${this.flushCount}: ${result.matches.length} match(es) found`);
      this.stats_.matchCount += result.matches.length;
      const detection: WatcherDetection = {
        event: {
          v: 1,
          ts: new Date().toISOString(),
          seq: 0,
          pid: process.pid,
          session: this.opts.session,
          pane: '0',
          source: 'rationguard',
          type: 'raw_output',
          data: { line: text },
        },
        result,
        matches: result.matches,
        timestamp: new Date().toISOString(),
      };

      for (const match of result.matches) {
        // Eligibility (confidence threshold, project-source exclusion) is
        // decided once in learner.ts and shared with cli.ts — see
        // recordSightingIfEligible.
        recordSightingIfEligible(match);
      }

      if (this.opts.rebuttal === 'send') {
        const now = Date.now();
        const sent: string[] = [];
        const sentTexts = new Set<string>();
        for (const match of result.matches) {
          if (!match.excuse) continue;
          if (match.excuse.source === 'project') {
            this.log(`skipping rebuttal for "${this.safe(match.excuse.pattern)}" (project-local excuse — untrusted working directory, detection only)`);
            continue;
          }
          const key = match.excuse.pattern;
          const lastSent = this.rebuttalCooldowns.get(key) ?? 0;
          if (now - lastSent < REBUTTAL_COOLDOWN_MS) {
            this.log(`skipping rebuttal for "${this.safe(key)}" (cooldown, ${Math.round((REBUTTAL_COOLDOWN_MS - (now - lastSent)) / 1000)}s remaining)`);
            this.stats_.rebuttalSuppressed++;
            continue;
          }
          if (sentTexts.has(match.excuse.rebuttal)) {
            this.log(`skipping duplicate rebuttal text for "${this.safe(key)}"`);
            this.rebuttalCooldowns.set(key, now);
            this.stats_.rebuttalSuppressed++;
            continue;
          }
          this.rebuttalCooldowns.set(key, now);
          this.log(`sending rebuttal to ${this.opts.session}: "${this.safe(match.excuse.rebuttal.slice(0, 80))}..."`);
          const ok = sendRebuttal(this.opts.session, match.excuse.rebuttal, this.verbose);
          this.log(`rebuttal ${ok ? 'DELIVERED' : 'FAILED'}`);
          if (ok) {
            this.stats_.rebuttalSent++;
            sent.push(key);
            sentTexts.add(match.excuse.rebuttal);
          } else {
            this.stats_.rebuttalFailed++;
          }
        }
        if (sent.length > 0) {
          this.lastRebuttalSentAt = Date.now();
          detection.sentRebuttals = sent;
          this.log(`sent ${sent.length} unique rebuttal(s) for: ${this.safe(sent.join(', '))} (quiet period: ${POST_REBUTTAL_QUIET_MS / 1000}s)`);
        }
      }

      this.emit('detection', detection);

      if (this.opts.onDetection) {
        this.opts.onDetection(detection);
      }
    }
  }
}

export function createWatcher(opts: WatcherOptions): Watcher {
  return new Watcher(opts);
}
