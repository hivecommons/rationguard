export interface Excuse {
  pattern: string;
  rebuttal: string;
  category: ExcuseCategory;
  keywords: string[];
  /**
   * Where this excuse was loaded from. Excuses from the project working
   * directory ('project') are untrusted: a cloned repository controls their
   * contents, so their rebuttals must never be auto-typed into an agent
   * session (detection/logging only).
   */
  source?: 'builtin' | 'user' | 'project';
}

export type ExcuseCategory =
  | 'false-completion'
  | 'complexity-dodge'
  | 'deferral'
  | 'lane-confusion'
  | 'partial-credit';

export interface MatchResult {
  matched: boolean;
  excuse: Excuse | null;
  confidence: number;
  matchedText: string;
}

export interface CheckResult {
  input: string;
  matches: MatchResult[];
  clean: boolean;
}

export interface RationguardConfig {
  excuses: Excuse[];
}

export const CATEGORY_LABELS: Record<ExcuseCategory, string> = {
  'false-completion': 'False Completion',
  'complexity-dodge': 'Complexity Dodge',
  'deferral': 'Deferral',
  'lane-confusion': 'Lane Confusion',
  'partial-credit': 'Partial Credit',
};
