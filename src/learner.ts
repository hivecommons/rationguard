import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CATEGORY_LABELS } from './types.js';
import type { Excuse, ExcuseCategory, MatchResult } from './types.js';
import { isStopWord } from './checker.js';

const SIGHTINGS_FILE = 'sightings.json';
const AUTO_ADD_THRESHOLD = 3;

/**
 * Minimum confidence for a match to be eligible for auto-learning. Shared by
 * every call site that decides whether to call `recordSighting` so the
 * threshold can't drift between them (see `recordSightingIfEligible`).
 */
export const AUTO_LEARN_CONFIDENCE_THRESHOLD = 0.7;

/**
 * Minimum confidence for `watch --rebuttal=send` to inject a rebuttal into the
 * agent session. Lower-confidence matches (e.g. a single keyword hit) are
 * still reported but never auto-sent.
 */
export const REBUTTAL_SEND_CONFIDENCE_THRESHOLD = AUTO_LEARN_CONFIDENCE_THRESHOLD;

interface Sighting {
  text: string;
  count: number;
  firstSeen: string;
  lastSeen: string;
  suggestedCategory: ExcuseCategory;
  suggestedRebuttal: string;
  promoted: boolean;
}

interface SightingsStore {
  sightings: Sighting[];
}

/**
 * Resolves the trusted per-user store directory (~/.rationguard), or null
 * when no home directory can be determined. This must NEVER fall back to
 * the current working directory: the cwd is an untrusted project checkout,
 * and excuses loaded from the no-projectDir path are tagged `source: 'user'`
 * (trusted) by getAllExcuses — a cwd fallback would let a cloned repo's
 * .rationguard/custom-excuses.json bypass every project-source guard
 * (rebuttal auto-send, prompt-block inclusion, sighting auto-promotion).
 */
export function getTrustedBase(): string | null {
  let home = process.env['HOME'];
  if (!home) {
    try {
      home = os.homedir();
    } catch {
      home = undefined;
    }
  }
  if (!home || !path.isAbsolute(home)) return null;
  return path.join(home, '.rationguard');
}

function getBaseDir(projectDir?: string): string | null {
  return projectDir ? path.join(projectDir, '.rationguard') : getTrustedBase();
}

function getStorePath(projectDir?: string): string | null {
  const base = getBaseDir(projectDir);
  return base ? path.join(base, SIGHTINGS_FILE) : null;
}

function isValidSighting(value: unknown): value is Sighting {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const s = value as Record<string, unknown>;
  return (
    typeof s['text'] === 'string' &&
    typeof s['count'] === 'number' &&
    typeof s['firstSeen'] === 'string' &&
    typeof s['lastSeen'] === 'string' &&
    typeof s['suggestedCategory'] === 'string' &&
    Object.prototype.hasOwnProperty.call(CATEGORY_LABELS, s['suggestedCategory']) &&
    typeof s['suggestedRebuttal'] === 'string' &&
    typeof s['promoted'] === 'boolean'
  );
}

/**
 * Moves an unparsable or wrong-shape store file aside, in the same directory
 * so the rename is atomic, so the next write cannot replace it and destroy the
 * only copy of the history. Never throws: detection must keep working.
 * Only the trusted per-user store is touched: a project-local file is
 * repo-controlled, so it is left as is (no write side effect in the checkout).
 */
function preserveCorruptFile(filePath: string): void {
  const trusted = getTrustedBase();
  if (trusted === null || path.resolve(path.dirname(filePath)) !== path.resolve(trusted)) return;
  const corruptPath = path.join(
    path.dirname(filePath),
    `${path.basename(filePath)}.corrupt-${Date.now()}.json`,
  );
  try {
    fs.renameSync(filePath, corruptPath);
    // Recovery can run before or after check's JSON match events. Keep this
    // diagnostic line-oriented JSON too, including when paths contain newlines.
    process.stderr.write(JSON.stringify({
      event: 'store_preserved',
      filePath,
      corruptPath,
    }) + '\n');
  } catch (err) {
    // Best effort; fall through to an empty store, but say so: the next write
    // will replace the unreadable file.
    const reason = err instanceof Error ? err.message : String(err);
    process.stderr.write(`rationguard: ${filePath} was not valid JSON and could not be moved aside to ${corruptPath}: ${reason}\n`);
  }
}

function loadStore(storePath: string): SightingsStore {
  let raw: string;
  try {
    raw = fs.readFileSync(storePath, 'utf-8');
  } catch {
    return { sightings: [] };
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      const sightings = (parsed as Record<string, unknown>)['sightings'];
      if (Array.isArray(sightings)) return { sightings: sightings.filter(isValidSighting) };
    }
  } catch {
    // Unparsable; handled below.
  }
  preserveCorruptFile(storePath);
  return { sightings: [] };
}

/**
 * Writes JSON to disk atomically: serialize to a temp file in the same
 * directory, then rename it over the destination. `rename(2)` is atomic on
 * POSIX filesystems, so a reader always sees either the fully-old or
 * fully-new file — never a partial write. Both sightings.json and
 * custom-excuses.json are written from `rationguard check` (one-shot) and
 * `rationguard watch`/`attach` (long-running) concurrently, so a bare
 * writeFileSync risks leaving a truncated file if the process is killed
 * mid-write; loadStore/loadCustomExcuses would then silently treat the
 * corrupted file as empty and discard all prior history. Lost updates
 * between concurrent read-modify-write cycles are prevented separately by
 * `withStoreLock`.
 *
 * The directory and files are created owner-only (0700/0600) rather than
 * umask-default. `~/.rationguard/custom-excuses.json` is the trusted store:
 * its entries are `source: 'user'` and therefore auto-send eligible, so
 * another local account that could write it could have its text typed into
 * the agent session. `rename(2)` preserves the temp file's mode, so the
 * final file is 0600 regardless of the process umask.
 *
 * If writeFileSync or renameSync fails, the temp file is removed before
 * rethrow, preventing repeated failed attempts from accumulating orphans.
 */
function writeJsonAtomic(filePath: string, data: unknown): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  const tmpPath = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`);
  try {
    fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    fs.rmSync(tmpPath, { force: true });
    throw err;
  }
}

function saveStore(storePath: string, store: SightingsStore): void {
  writeJsonAtomic(storePath, store);
}

const LOCK_FILE = '.sightings.lock';
const LOCK_MAX_WAIT_MS = 2000;
const LOCK_STALE_MS = 10_000;
const LOCK_RETRY_MIN_MS = 5;
const LOCK_RETRY_JITTER_MS = 15;

export interface StoreLockOptions {
  /** Give up waiting for a held lock after this long and run unlocked. */
  maxWaitMs?: number;
  /** A lock whose mtime is older than this is assumed abandoned and removed. */
  staleMs?: number;
}

type LockState = 'acquired' | 'held' | 'unavailable' | 'nested';

/** Re-entrancy depth per lock path, so nesting is only recognised for the same store dir. */
const lockDepths = new Map<string, number>();

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

interface LockResult {
  state: LockState;
  /** Token written into the lock file we created; only set when `state` is 'acquired'. */
  token?: string;
}

/**
 * Per-acquisition lock token. The pid alone is not enough to recognise our
 * own lock on release, and neither is the inode: Linux filesystems reuse a
 * freed inode number immediately, so a lock reclaimed and recreated by another
 * process can carry the same inode as the one we lost.
 */
function newLockToken(): string {
  return `${process.pid}:${process.hrtime.bigint()}:${Math.random().toString(36).slice(2)}`;
}

function tryAcquireLock(dir: string, lockPath: string): LockResult {
  try {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
    const token = newLockToken();
    fs.writeFileSync(lockPath, token, { flag: 'wx', mode: 0o600 });
    return { state: 'acquired', token };
  } catch (err) {
    return { state: (err as NodeJS.ErrnoException).code === 'EEXIST' ? 'held' : 'unavailable' };
  }
}

/**
 * Removes `lockPath` if its mtime is older than `staleMs`. The reclaim is
 * exclusive: the lock is first moved aside with an atomic rename to a
 * per-pid name, so of several waiters that all saw the same stale lock only
 * one can win the rename and remove it; the others find nothing to reclaim.
 * If the file we moved turns out to be a different (fresh) lock that another
 * waiter created in between, it is put back rather than removed.
 *
 * @internal Exported for tests.
 */
export function reclaimStaleLock(lockPath: string, staleMs: number): boolean {
  const st = fs.statSync(lockPath, { throwIfNoEntry: false });
  if (!st || Date.now() - st.mtimeMs <= staleMs) return false;
  const reclaimPath = `${lockPath}.reclaim.${process.pid}`;
  try {
    fs.renameSync(lockPath, reclaimPath);
  } catch {
    return false; // another waiter reclaimed it (or it was released) first
  }
  const moved = fs.statSync(reclaimPath, { throwIfNoEntry: false });
  if (moved && moved.ino === st.ino && Date.now() - moved.mtimeMs > staleMs) {
    fs.rmSync(reclaimPath, { force: true });
    return true;
  }
  // We grabbed a live lock created after our stat: restore it.
  try {
    fs.renameSync(reclaimPath, lockPath);
  } catch {
    fs.rmSync(reclaimPath, { force: true });
  }
  return false;
}

/**
 * Removes `lockPath` only if it is still the lock we created (its content is
 * `token`). A holder that stalled past the stale timeout may have had its lock
 * reclaimed and replaced by a live one; a blind remove would delete that live
 * lock. Ownership is checked in place first: a lock that does not carry our
 * token is never touched, because moving a live lock aside — even briefly —
 * empties the slot, lets a waiter create a new lock there, and the restoring
 * rename would then silently replace that new lock. Only a lock that reads as
 * ours is moved aside with an atomic rename, so the final token check and the
 * remove act on the same file; if a reclaim raced in between, the file we
 * moved is put back.
 *
 * @internal Exported for tests.
 */
export function releaseOwnLock(lockPath: string, token: string): void {
  let current: string | undefined;
  try {
    current = fs.readFileSync(lockPath, 'utf-8');
  } catch {
    return; // already reclaimed and released by someone else
  }
  if (current !== token) return; // reclaimed and replaced by a live holder: leave it alone
  const releasePath = `${lockPath}.release.${process.pid}`;
  try {
    fs.renameSync(lockPath, releasePath);
  } catch {
    return; // reclaimed between the read and the rename
  }
  let content: string | undefined;
  try {
    content = fs.readFileSync(releasePath, 'utf-8');
  } catch {
    content = undefined;
  }
  if (content === token) {
    fs.rmSync(releasePath, { force: true });
    return;
  }
  // We grabbed another process's live lock: restore it.
  try {
    fs.renameSync(releasePath, lockPath);
  } catch {
    fs.rmSync(releasePath, { force: true });
  }
}

function acquireLock(dir: string, lockPath: string, opts: StoreLockOptions): LockResult {
  const deadline = Date.now() + (opts.maxWaitMs ?? LOCK_MAX_WAIT_MS);
  const staleMs = opts.staleMs ?? LOCK_STALE_MS;
  let result = tryAcquireLock(dir, lockPath);
  while (result.state === 'held' && Date.now() < deadline) {
    reclaimStaleLock(lockPath, staleMs);
    sleepSync(LOCK_RETRY_MIN_MS + Math.random() * LOCK_RETRY_JITTER_MS);
    result = tryAcquireLock(dir, lockPath);
  }
  return result;
}

/**
 * Runs `fn` while holding an inter-process lock (`<dir>/.sightings.lock`,
 * created with O_EXCL) so concurrent `check`/`watch`/`add` processes
 * serialize their load → modify → save of the store files. `writeJsonAtomic`
 * alone only prevents torn writes; two writers that loaded the same prior
 * state would otherwise silently drop each other's update.
 *
 * Learning is best-effort, so the lock never makes things worse than the
 * unlocked behaviour: if the lock cannot be created for a non-contention
 * reason (unwritable/read-only store, EACCES, EROFS, ENOTDIR) or is still
 * held after `maxWaitMs`, `fn` runs unlocked and any write error surfaces
 * from `fn` itself exactly as before. A lock older than `staleMs` (crashed
 * holder) is reclaimed exclusively (see `reclaimStaleLock`).
 *
 * Nested calls in the same process are re-entrant per lock path: a nested
 * call for the *same* `dir` runs under the outer call's lock, while a nested
 * call for a different `dir` acquires that dir's lock independently. The one
 * lock file guards every store file in `dir` (sightings and custom excuses);
 * its name is kept as `.sightings.lock` for compatibility.
 *
 * Release is token-checked (see `releaseOwnLock`): a holder that stalled past
 * `staleMs` never deletes the live lock of the process that reclaimed it.
 */
export function withStoreLock<T>(dir: string, fn: () => T, opts: StoreLockOptions = {}): T {
  const lockPath = path.join(dir, LOCK_FILE);
  const depth = lockDepths.get(lockPath) ?? 0;
  const { state, token } = depth > 0 ? { state: 'nested' as LockState, token: undefined } : acquireLock(dir, lockPath, opts);
  lockDepths.set(lockPath, depth + 1);
  try {
    return fn();
  } finally {
    if (depth > 0) lockDepths.set(lockPath, depth);
    else lockDepths.delete(lockPath);
    if (state === 'acquired') releaseOwnLock(lockPath, token as string);
  }
}

function normalizeForDedup(text: string): string {
  // Unicode-aware: an ASCII-only class would reduce every non-Latin excuse to
  // '' and merge unrelated sightings into one counter.
  // NFKC folds decomposed/compatibility forms so the same visible excuse
  // typed via different IMEs lands on one key; \p{M} keeps combining marks
  // that have no precomposed form.
  const normalized = text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\s]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
  return normalized || text.toLowerCase().replace(/\s+/g, ' ').trim();
}

const CATEGORY_SIGNALS: Record<ExcuseCategory, string[]> = {
  'false-completion': ['done', 'complete', 'finished', 'no more', 'all good', 'nothing', 'steady'],
  'complexity-dodge': ['complex', 'difficult', 'hard', 'scope', 'approval', 'permission', 'cannot'],
  'deferral': ['later', 'next', 'wait', 'defer', 'postpone', 'tomorrow', 'eventually', 'soon'],
  'lane-confusion': ['not my', 'their', 'someone else', 'another', 'other team', 'other agent'],
  'partial-credit': ['partial', 'some', 'progress', 'started', 'probably', 'should be', 'most'],
};

function guessCategory(text: string): ExcuseCategory {
  const normalized = text.toLowerCase();
  let bestCategory: ExcuseCategory = 'deferral';
  let bestScore = 0;

  for (const [category, signals] of Object.entries(CATEGORY_SIGNALS)) {
    let score = 0;
    for (const signal of signals) {
      if (normalized.includes(signal)) score++;
    }
    if (score > bestScore) {
      bestScore = score;
      bestCategory = category as ExcuseCategory;
    }
  }

  return bestCategory;
}

function generateRebuttal(category: ExcuseCategory): string {
  const rebuttals: Record<ExcuseCategory, string> = {
    'false-completion': 'Verify by checking the actual task queue or issue list. Claim completion only with evidence.',
    'complexity-dodge': 'Break it into smaller pieces. A partial fix is better than no fix.',
    'deferral': 'Act now. If blocked, move to the next task. Deferral without a concrete blocker is procrastination.',
    'lane-confusion': 'Verify the other party is actually handling it. If not, you own it.',
    'partial-credit': 'Partial is not done. State what specifically remains and commit to finishing it.',
  };
  return rebuttals[category];
}

export interface RecordSightingOptions {
  /**
   * Whether reaching AUTO_ADD_THRESHOLD may promote the sighting into
   * custom-excuses.json. Defaults to true (explicit `rationguard add`).
   * Detection call sites pass false: a detection is, by construction, a
   * match on an excuse that already exists, so promoting its matchedText
   * (often a single builtin keyword such as "will") only writes a
   * degraded duplicate into the trusted store.
   */
  promote?: boolean;
}

export function recordSighting(
  text: string,
  category?: ExcuseCategory,
  rebuttal?: string,
  projectDir?: string,
  opts: RecordSightingOptions = {},
): { isNew: boolean; count: number; autoPromoted: boolean; promoted: boolean; promotedUpdated: boolean; excuse: Excuse | null } {
  rebuttal = rebuttal?.trim() || undefined;
  const promote = opts.promote ?? true;
  const storePath = getStorePath(projectDir);
  if (!storePath) {
    // No resolvable home directory — refuse to persist rather than writing
    // a "trusted" store into the untrusted working directory.
    return { isNew: false, count: 0, autoPromoted: false, promoted: false, promotedUpdated: false, excuse: null };
  }
  return withStoreLock(path.dirname(storePath), () => {
    const store = loadStore(storePath);
    const normalized = normalizeForDedup(text);
    const now = new Date().toISOString();

    let existing = store.sightings.find(s => normalizeForDedup(s.text) === normalized);

    if (existing) {
      existing.count++;
      existing.lastSeen = now;
      const categoryChanged = category !== undefined && category !== existing.suggestedCategory;
      let rebuttalRegenerated = false;
      if (categoryChanged && !rebuttal
          && existing.suggestedRebuttal === generateRebuttal(existing.suggestedCategory)) {
        existing.suggestedRebuttal = generateRebuttal(category);
        rebuttalRegenerated = true;
      }
      if (category) existing.suggestedCategory = category;
      if (rebuttal) existing.suggestedRebuttal = rebuttal;

      const alreadyPromoted = existing.promoted;
      let autoPromoted = false;
      let promotedUpdated = false;
      let excuse: Excuse | null = null;

      if (promote && existing.count >= AUTO_ADD_THRESHOLD && !existing.promoted) {
        existing.promoted = true;
        autoPromoted = true;
        excuse = promoteToExcuse(existing);
        addToCustomExcuses(excuse, projectDir);
      } else if (promote && alreadyPromoted && (categoryChanged || rebuttal)) {
        // Only an explicit `add` may edit the promoted excuse, and only the
        // fields it actually changed: the detection path (promote: false)
        // and an unchanged --category must not clobber a hand-edited
        // rebuttal in custom-excuses.json.
        const patch: Partial<Pick<Excuse, 'category' | 'rebuttal'>> = {};
        if (categoryChanged) patch.category = existing.suggestedCategory;
        if (rebuttal || rebuttalRegenerated) patch.rebuttal = existing.suggestedRebuttal;
        promotedUpdated = updateCustomExcuse(existing.text.toLowerCase(), patch, projectDir);
      }

      saveStore(storePath, store);
      return { isNew: false, count: existing.count, autoPromoted, promoted: existing.promoted, promotedUpdated, excuse };
    }

    const guessedCategory = category ?? guessCategory(text);
    const sighting: Sighting = {
      text,
      count: 1,
      firstSeen: now,
      lastSeen: now,
      suggestedCategory: guessedCategory,
      suggestedRebuttal: rebuttal ?? generateRebuttal(guessedCategory),
      promoted: false,
    };

    store.sightings.push(sighting);
    saveStore(storePath, store);

    return { isNew: true, count: 1, autoPromoted: false, promoted: false, promotedUpdated: false, excuse: null };
  });
}

// Contraction tails ("don't" -> "don", "that's" -> "that") are removed before
// the length/stopword filter so the remaining stem falls through to those
// filters instead of surviving as a 4+ character pseudo-keyword (#240).
const CONTRACTION_TAIL = /(n['\u2019]t|['\u2019](s|re|ll|ve|d|m))$/u;

function promoteToExcuse(sighting: Sighting): Excuse {
  const words = sighting.text
    .toLowerCase()
    .split(/\s+/)
    .map(w => w.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ''))
    .map(w => w.replace(CONTRACTION_TAIL, ''))
    .filter(w => w.length > 3 && !isStopWord(w));
  return {
    pattern: sighting.text.toLowerCase(),
    rebuttal: sighting.suggestedRebuttal,
    category: sighting.suggestedCategory,
    keywords: words.slice(0, 5),
  };
}

function getCustomExcusesPath(projectDir?: string): string | null {
  const base = getBaseDir(projectDir);
  return base ? path.join(base, 'custom-excuses.json') : null;
}

/**
 * Shape-validates a parsed excuse entry. The custom-excuses file in the
 * project working directory is untrusted (a cloned repository controls it),
 * and entries with the wrong shape would otherwise throw deep inside the
 * checker — killing `check`, `watch`, and `attach` and silently disabling
 * detection. Invalid entries are dropped instead.
 */
function isValidExcuse(value: unknown): value is Excuse {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const e = value as Record<string, unknown>;
  return (
    typeof e['pattern'] === 'string' &&
    e['pattern'].trim().length > 0 &&
    typeof e['rebuttal'] === 'string' &&
    typeof e['category'] === 'string' &&
    Object.prototype.hasOwnProperty.call(CATEGORY_LABELS, e['category']) &&
    Array.isArray(e['keywords']) &&
    e['keywords'].every(k => typeof k === 'string')
  );
}

export function loadCustomExcuses(projectDir?: string): Excuse[] {
  const filePath = getCustomExcusesPath(projectDir);
  if (!filePath) return [];
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf-8');
  } catch {
    return [];
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed.filter(isValidExcuse);
  } catch {
    // Unparsable; handled below.
  }
  preserveCorruptFile(filePath);
  return [];
}

function addToCustomExcuses(excuse: Excuse, projectDir?: string): void {
  const filePath = getCustomExcusesPath(projectDir);
  if (!filePath) return;
  withStoreLock(path.dirname(filePath), () => {
    const excuses = loadCustomExcuses(projectDir);
    excuses.push(excuse);
    writeJsonAtomic(filePath, excuses);
  });
}

/**
 * Updates the category/rebuttal of the entry `promoteToExcuse` wrote for this
 * sighting. Returns whether the file changed; a missing entry (deleted by the
 * user) is left alone rather than re-added.
 */
function updateCustomExcuse(
  pattern: string,
  patch: Partial<Pick<Excuse, 'category' | 'rebuttal'>>,
  projectDir?: string,
): boolean {
  const filePath = getCustomExcusesPath(projectDir);
  if (!filePath) return false;
  return withStoreLock(path.dirname(filePath), () => {
    const excuses = loadCustomExcuses(projectDir);
    const entry = excuses.find(e => e.pattern === pattern);
    if (!entry) return false;
    let changed = false;
    if (patch.category !== undefined && entry.category !== patch.category) {
      entry.category = patch.category;
      changed = true;
    }
    if (patch.rebuttal !== undefined && entry.rebuttal !== patch.rebuttal) {
      entry.rebuttal = patch.rebuttal;
      changed = true;
    }
    if (!changed) return false;
    writeJsonAtomic(filePath, excuses);
    return true;
  });
}

export function listSightings(projectDir?: string): Sighting[] {
  const storePath = getStorePath(projectDir);
  if (!storePath) return [];
  const store = loadStore(storePath);
  return store.sightings.sort((a, b) => b.count - a.count);
}

/**
 * The single gate deciding whether a detected match is eligible for
 * auto-learning. Call this instead of `recordSighting` directly from
 * detection call sites (`rationguard check`, `Watcher.flushBuffer`) so the
 * eligibility rule can't drift between them.
 *
 * Project-local excuses (`source === 'project'`) are excluded: their
 * patterns come from the (potentially untrusted) project working directory,
 * and `recordSighting` auto-promotes a pattern into the trusted
 * `~/.rationguard` store after `AUTO_ADD_THRESHOLD` sightings — letting an
 * untrusted pattern count toward auto-send-eligible status would defeat the
 * project/user trust boundary enforced elsewhere (see `source` on `Excuse`).
 *
 * Eligible matches are recorded count-only (`promote: false`). The text
 * being recorded is `matchedText` — the excuse pattern or, for keyword
 * matches, a single builtin keyword — so promotion could only ever add a
 * degraded duplicate of a known excuse to the trusted store, and that
 * duplicate would be `source: 'user'` and therefore auto-send eligible.
 * Only an explicit `rationguard add` may promote.
 */
export function recordSightingIfEligible(match: MatchResult): void {
  if (!match.excuse) return;
  if (match.excuse.source === 'project') return;
  if (match.confidence < AUTO_LEARN_CONFIDENCE_THRESHOLD) return;
  try {
    recordSighting(match.matchedText, match.excuse.category, undefined, undefined, { promote: false });
  } catch {
    // Learning is best-effort: an unwritable store (read-only HOME, sandboxed
    // hook) must never take down detection, output, or rebuttal delivery.
  }
}
