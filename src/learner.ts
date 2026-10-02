import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CATEGORY_LABELS } from './types.js';
import type { Excuse, ExcuseCategory, MatchResult } from './types.js';

const SIGHTINGS_FILE = 'sightings.json';
const AUTO_ADD_THRESHOLD = 3;

/**
 * Minimum confidence for a match to be eligible for auto-learning. Shared by
 * every call site that decides whether to call `recordSighting` so the
 * threshold can't drift between them (see `recordSightingIfEligible`).
 */
export const AUTO_LEARN_CONFIDENCE_THRESHOLD = 0.7;

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
function getTrustedBase(): string | null {
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

function loadStore(storePath: string): SightingsStore {
  try {
    const raw = fs.readFileSync(storePath, 'utf-8');
    return JSON.parse(raw) as SightingsStore;
  } catch {
    return { sightings: [] };
  }
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
 * corrupted file as empty and discard all prior history.
 */
function writeJsonAtomic(filePath: string, data: unknown): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const tmpPath = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2) + '\n');
  fs.renameSync(tmpPath, filePath);
}

function saveStore(storePath: string, store: SightingsStore): void {
  writeJsonAtomic(storePath, store);
}

function normalizeForDedup(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
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

export function recordSighting(
  text: string,
  category?: ExcuseCategory,
  rebuttal?: string,
  projectDir?: string,
): { isNew: boolean; count: number; autoPromoted: boolean; excuse: Excuse | null } {
  const storePath = getStorePath(projectDir);
  if (!storePath) {
    // No resolvable home directory — refuse to persist rather than writing
    // a "trusted" store into the untrusted working directory.
    return { isNew: false, count: 0, autoPromoted: false, excuse: null };
  }
  const store = loadStore(storePath);
  const normalized = normalizeForDedup(text);
  const now = new Date().toISOString();

  let existing = store.sightings.find(s => normalizeForDedup(s.text) === normalized);

  if (existing) {
    existing.count++;
    existing.lastSeen = now;
    if (category) existing.suggestedCategory = category;
    if (rebuttal) existing.suggestedRebuttal = rebuttal;

    let autoPromoted = false;
    let excuse: Excuse | null = null;

    if (existing.count >= AUTO_ADD_THRESHOLD && !existing.promoted) {
      existing.promoted = true;
      autoPromoted = true;
      excuse = promoteToExcuse(existing);
      addToCustomExcuses(excuse, projectDir);
    }

    saveStore(storePath, store);
    return { isNew: false, count: existing.count, autoPromoted, excuse };
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

  return { isNew: true, count: 1, autoPromoted: false, excuse: null };
}

function promoteToExcuse(sighting: Sighting): Excuse {
  const words = sighting.text.toLowerCase().split(/\s+/).filter(w => w.length > 3);
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
    e['category'] in CATEGORY_LABELS &&
    Array.isArray(e['keywords']) &&
    e['keywords'].every(k => typeof k === 'string')
  );
}

export function loadCustomExcuses(projectDir?: string): Excuse[] {
  const filePath = getCustomExcusesPath(projectDir);
  if (!filePath) return [];
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isValidExcuse);
  } catch {
    return [];
  }
}

function addToCustomExcuses(excuse: Excuse, projectDir?: string): void {
  const filePath = getCustomExcusesPath(projectDir);
  if (!filePath) return;
  const excuses = loadCustomExcuses(projectDir);
  excuses.push(excuse);
  writeJsonAtomic(filePath, excuses);
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
 */
export function recordSightingIfEligible(match: MatchResult): void {
  if (!match.excuse) return;
  if (match.excuse.source === 'project') return;
  if (match.confidence < AUTO_LEARN_CONFIDENCE_THRESHOLD) return;
  recordSighting(match.matchedText, match.excuse.category);
}
