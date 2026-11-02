import fs from 'node:fs';
import path from 'node:path';

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
