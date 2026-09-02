import { EventEmitter } from 'node:events';
import { execFileSync } from 'node:child_process';
import { check } from './checker.js';
import { DEFAULT_EXCUSES } from './defaults.js';
import { loadCustomExcuses, recordSighting } from './learner.js';
import type { Excuse, CheckResult, MatchResult } from './types.js';
import type { PlukEvent, PlukEventType, Subscriber, WatchOptions } from '@hivecommons/pluk';

const RAW_OUTPUT_BUFFER_MAX_LINES = 20;
const RAW_OUTPUT_FLUSH_MS = 2_000;
const CONFIDENCE_HIGH = 0.7;
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
  rebuttal?: 'log' | 'send' | 'inject';
  quiet?: boolean;
  verbose?: boolean;
  onDetection?: (detection: WatcherDetection) => void;
}

function getAllExcuses(): Excuse[] {
  const custom = loadCustomExcuses();
  const projectCustom = loadCustomExcuses('.');
  return [...DEFAULT_EXCUSES, ...custom, ...projectCustom];
}

const SESSION_NAME_RE = /^[a-zA-Z0-9_.-]+$/;

function validateSession(session: string): void {
  if (!SESSION_NAME_RE.test(session)) {
    throw new Error(`Invalid session name: ${session}`);
  }
}

function sendRebuttal(session: string, rebuttal: string, verbose = false): boolean {
  validateSession(session);

  if (verbose) {
    console.error(`\x1b[2m[rationguard]\x1b[0m sendRebuttal: trying pluk-send`);
  }
  try {
    execFileSync('pluk-send', [`--session=${session}`, `--text=${rebuttal}`, '--enter'], { stdio: 'pipe' });
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
      execFileSync('tmux', ['send-keys', '-l', '-t', session, rebuttal], { stdio: 'pipe' });
      execFileSync('tmux', ['send-keys', '-t', session, 'Enter'], { stdio: 'pipe' });
      if (verbose) {
        console.error(`\x1b[2m[rationguard]\x1b[0m sendRebuttal: tmux send-keys succeeded`);
      }
      return true;
    } catch (err2) {
      const errMsg2 = err2 instanceof Error ? err2.message : String(err2);
      console.error(`\x1b[2m[rationguard]\x1b[0m sendRebuttal: FAILED both methods: ${errMsg2}`);
      return false;
    }
  }
}

const ANSI_DIM = '\x1b[2m';
const ANSI_RESET = '\x1b[0m';

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
        this.flushBuffer();
      }
      return;
    }

    if (event.type === 'state_change') {
      this.log(`state_change: ${event.data['from']} → ${event.data['to']}`);
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
    const lineCount = this.buffer.length;
    const text = this.buffer.join('\n');
    this.buffer = [];

    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }

    const stripped = text
      .replace(/\x1b\[[0-9;?]*[a-zA-Z$]/g, '')
      .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
      .replace(/\x1bP[^\x1b]*\x1b\\/g, '')
      .replace(/\x1b[()][A-Z0-9]/g, '')
      .replace(/\x1b[=>]/g, '')
      .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')
      .trim();
    const preview = stripped.slice(0, 200).replace(/\n/g, ' ');
    this.log(`flush #${this.flushCount}: checking ${lineCount} lines (${text.length} chars)`);
    this.log(`flush #${this.flushCount}: text: "${preview}${stripped.length > 200 ? '...' : ''}"`);
    const result = check(text, { excuses: this.excuses });

    if (result.clean) {
      this.log(`flush #${this.flushCount}: clean`);
    }

    const quietRemaining = POST_REBUTTAL_QUIET_MS - (Date.now() - this.lastRebuttalSentAt);
    if (!result.clean && quietRemaining > 0) {
      this.log(`flush #${this.flushCount}: ${result.matches.length} match(es) suppressed (post-rebuttal quiet period, ${Math.round(quietRemaining / 1000)}s remaining)`);
      return;
    }

    if (!result.clean) {
      this.log(`flush #${this.flushCount}: ${result.matches.length} match(es) found`);
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
        if (match.excuse && match.confidence >= CONFIDENCE_HIGH) {
          recordSighting(match.matchedText, match.excuse.category);
        }
      }

      if (this.opts.rebuttal === 'send') {
        const now = Date.now();
        const sent: string[] = [];
        const sentTexts = new Set<string>();
        for (const match of result.matches) {
          if (!match.excuse) continue;
          const key = match.excuse.pattern;
          const lastSent = this.rebuttalCooldowns.get(key) ?? 0;
          if (now - lastSent < REBUTTAL_COOLDOWN_MS) {
            this.log(`skipping rebuttal for "${key}" (cooldown, ${Math.round((REBUTTAL_COOLDOWN_MS - (now - lastSent)) / 1000)}s remaining)`);
            continue;
          }
          if (sentTexts.has(match.excuse.rebuttal)) {
            this.log(`skipping duplicate rebuttal text for "${key}"`);
            this.rebuttalCooldowns.set(key, now);
            continue;
          }
          this.rebuttalCooldowns.set(key, now);
          this.log(`sending rebuttal to ${this.opts.session}: "${match.excuse.rebuttal.slice(0, 80)}..."`);
          const ok = sendRebuttal(this.opts.session, match.excuse.rebuttal, this.verbose);
          this.log(`rebuttal ${ok ? 'DELIVERED' : 'FAILED'}`);
          if (ok) {
            sent.push(key);
            sentTexts.add(match.excuse.rebuttal);
          }
        }
        if (sent.length > 0) {
          this.lastRebuttalSentAt = Date.now();
          detection.sentRebuttals = sent;
          this.log(`sent ${sent.length} unique rebuttal(s) for: ${sent.join(', ')} (quiet period: ${POST_REBUTTAL_QUIET_MS / 1000}s)`);
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
