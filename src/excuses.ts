import { DEFAULT_EXCUSES } from './defaults.js';
import { loadCustomExcuses } from './learner.js';
import type { Excuse } from './types.js';

/**
 * Assembles the full excuse set: builtins, the user's trusted HOME store,
 * and the (potentially untrusted) project-local store — each tagged with
 * its `source` so callers can tell them apart.
 *
 * Project-local excuses are repo-controlled (untrusted): they are used for
 * detection/display, but their rebuttals must never be auto-sent back into
 * an agent session, and matches on them must never feed recordSighting
 * (which auto-promotes into the trusted HOME store — see cli.ts/watcher.ts).
 */
export function getAllExcuses(): Excuse[] {
  const custom = loadCustomExcuses().map((e): Excuse => ({ ...e, source: 'user' }));
  const projectCustom = loadCustomExcuses('.').map((e): Excuse => ({ ...e, source: 'project' }));
  return [...DEFAULT_EXCUSES, ...custom, ...projectCustom];
}
