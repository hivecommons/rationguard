import { DEFAULT_EXCUSES } from './defaults.js';
import type { Excuse, MatchResult, CheckResult, RationguardConfig } from './types.js';

const MIN_KEYWORD_CONFIDENCE = 0.3;
const EXACT_MATCH_CONFIDENCE = 1.0;
const KEYWORD_WEIGHT = 0.15;

const FILLER_WORDS = /\b(is|are|was|were|been|being|has|have|had|do|does|did|will|would|shall|should|can|could|may|might|must|the|a|an|so|just|very|really|quite|all|also|still)\b/g;
const VERB_SUFFIXES = /\b(\w+?)(ing|ed|s)\b/g;

function normalizeText(text: string): string {
  return text.toLowerCase().replace(/['']/g, "'").replace(/\s+/g, ' ').trim();
}

function reduceText(text: string): string {
  return normalizeText(text)
    .replace(FILLER_WORDS, '')
    .replace(VERB_SUFFIXES, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

function scoreExcuse(text: string, excuse: Excuse): MatchResult {
  const normalized = normalizeText(text);
  const patternNorm = normalizeText(excuse.pattern);

  if (normalized.includes(patternNorm)) {
    return {
      matched: true,
      excuse,
      confidence: EXACT_MATCH_CONFIDENCE,
      matchedText: excuse.pattern,
    };
  }

  const reduced = reduceText(text);
  let keywordHits = 0;
  let bestMatch = '';
  for (const kw of excuse.keywords) {
    const kwNorm = normalizeText(kw);
    if (kwNorm.length === 0) continue;
    // A keyword made only of filler words ("will", "just", "should") reduces
    // to '', and '' is a substring of every string — never let an empty
    // reduced form count as a hit.
    const kwReduced = reduceText(kw);
    if (normalized.includes(kwNorm) || (kwReduced.length > 0 && reduced.includes(kwReduced))) {
      keywordHits++;
      if (kw.length > bestMatch.length) bestMatch = kw;
    }
  }

  if (keywordHits === 0) {
    return { matched: false, excuse: null, confidence: 0, matchedText: '' };
  }

  const confidence = Math.min(EXACT_MATCH_CONFIDENCE, keywordHits * KEYWORD_WEIGHT + MIN_KEYWORD_CONFIDENCE);
  return {
    // keywordHits > 0 here, so confidence is always >= the single-hit floor.
    matched: true,
    excuse,
    confidence,
    matchedText: bestMatch,
  };
}

export function check(text: string, config?: RationguardConfig): CheckResult {
  const excuses = config?.excuses ?? DEFAULT_EXCUSES;
  const matches: MatchResult[] = [];

  for (const excuse of excuses) {
    const result = scoreExcuse(text, excuse);
    if (result.matched) {
      matches.push(result);
    }
  }

  matches.sort((a, b) => b.confidence - a.confidence);

  return {
    input: text,
    matches,
    clean: matches.length === 0,
  };
}

export function generatePromptBlock(config?: RationguardConfig): string {
  const excuses = config?.excuses ?? DEFAULT_EXCUSES;
  const lines: string[] = [
    '## Rationalization Defense — Known Excuses',
    '',
    'Before responding, check your output against these patterns. If you catch yourself producing any of them, apply the rebuttal instead.',
    '',
    '| Excuse Pattern | Rebuttal |',
    '|----------------|----------|',
  ];

  for (const excuse of excuses) {
    const escapedPattern = excuse.pattern.replace(/\|/g, '\\|');
    const escapedRebuttal = excuse.rebuttal.replace(/\|/g, '\\|');
    lines.push(`| ${escapedPattern} | ${escapedRebuttal} |`);
  }

  lines.push('');
  lines.push('If none of the above match but your response contains no concrete deliverable (PR, commit, fix, file change, specific finding), you are likely rationalizing. Rewrite with a specific action.');

  return lines.join('\n');
}
