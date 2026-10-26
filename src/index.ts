export { check, generatePromptBlock } from './checker.js';
export { recordSighting, loadCustomExcuses, listSightings } from './learner.js';
export { DEFAULT_EXCUSES } from './defaults.js';
export { getAllExcuses } from './excuses.js';
export { Watcher, createWatcher } from './watcher.js';
export type { WatcherDetection, WatcherOptions } from './watcher.js';
export type {
  Excuse,
  ExcuseCategory,
  MatchResult,
  CheckResult,
  RationguardConfig,
  RationguardEvent,
  CheckOptions,
} from './types.js';
export { CATEGORY_LABELS } from './types.js';
