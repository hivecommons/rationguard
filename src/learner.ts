import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_EXCUSES } from './defaults.js';
import type { Excuse, ExcuseCategory } from './types.js';

const SIGHTINGS_FILE = 'sightings.json';
const AUTO_ADD_THRESHOLD = 3;

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

function getStorePath(projectDir?: string): string {
  const base = projectDir
    ? path.join(projectDir, '.rationguard')
    : path.join(process.env['HOME'] ?? '.', '.rationguard');
  return path.join(base, SIGHTINGS_FILE);
}

function loadStore(storePath: string): SightingsStore {
  try {
    const raw = fs.readFileSync(storePath, 'utf-8');
    return JSON.parse(raw) as SightingsStore;
  } catch {
    return { sightings: [] };
  }
}

function saveStore(storePath: string, store: SightingsStore): void {
  const dir = path.dirname(storePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(storePath, JSON.stringify(store, null, 2) + '\n');
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

/**
 * True when the text is already covered by a known excuse — the pattern or a
 * keyword of a built-in, user-level, or project-local excuse. Recording (and
 * especially auto-promoting) such text is circular: high-confidence matches
 * report the known pattern/keyword as matchedText, so promotion would create
 * duplicate excuses or bare-keyword patterns that exact-match at confidence
 * 1.0 on innocuous output, feeding back into more sightings and rebuttals. It
 * would also let untrusted project-local excuse keywords be laundered into
 * the trusted user-level store.
 */
function isKnownExcuseText(normalized: string, projectDir?: string): boolean {
  const known = [...DEFAULT_EXCUSES, ...loadCustomExcuses(projectDir), ...loadCustomExcuses('.')];
  for (const excuse of known) {
    if (normalizeForDedup(excuse.pattern) === normalized) return true;
    for (const kw of excuse.keywords) {
      if (normalizeForDedup(kw) === normalized) return true;
    }
  }
  return false;
}

export function recordSighting(
  text: string,
  category?: ExcuseCategory,
  rebuttal?: string,
  projectDir?: string,
): { isNew: boolean; count: number; autoPromoted: boolean; excuse: Excuse | null; alreadyKnown?: boolean } {
  const storePath = getStorePath(projectDir);
  const store = loadStore(storePath);
  const normalized = normalizeForDedup(text);
  const now = new Date().toISOString();

  if (isKnownExcuseText(normalized, projectDir)) {
    return { isNew: false, count: 0, autoPromoted: false, excuse: null, alreadyKnown: true };
  }

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

function getCustomExcusesPath(projectDir?: string): string {
  const base = projectDir
    ? path.join(projectDir, '.rationguard')
    : path.join(process.env['HOME'] ?? '.', '.rationguard');
  return path.join(base, 'custom-excuses.json');
}

export function loadCustomExcuses(projectDir?: string): Excuse[] {
  const filePath = getCustomExcusesPath(projectDir);
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(raw) as Excuse[];
  } catch {
    return [];
  }
}

function addToCustomExcuses(excuse: Excuse, projectDir?: string): void {
  const excuses = loadCustomExcuses(projectDir);
  excuses.push(excuse);
  const filePath = getCustomExcusesPath(projectDir);
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(filePath, JSON.stringify(excuses, null, 2) + '\n');
}

export function listSightings(projectDir?: string): Sighting[] {
  const storePath = getStorePath(projectDir);
  const store = loadStore(storePath);
  return store.sightings.sort((a, b) => b.count - a.count);
}
