import type { Excuse } from './types.js';

export const DEFAULT_EXCUSES: Excuse[] = [
  // --- False Completion ---
  {
    pattern: 'no work found',
    rebuttal: 'Verify by checking the issue queue, task list, or backlog. "No work" requires proof, not a claim.',
    category: 'false-completion',
    keywords: ['no work', 'nothing to do', 'idle', 'no tasks', 'no open items', 'queue is empty', 'nothing remaining'],
  },
  {
    pattern: 'all done / steady state',
    rebuttal: 'Did you verify? Check open issues, pending PRs, failing tests. "Done" means zero open items, not zero motivation.',
    category: 'false-completion',
    keywords: ['all done', 'steady state', 'everything is complete', 'no remaining', 'objectives achieved', 'nothing left', 'all complete', 'completed all', 'finished everything', 'all tasks done', 'move on'],
  },
  {
    pattern: 'all checks passing',
    rebuttal: 'Did you actually run the checks THIS cycle, or are you assuming from last time? Paste the output.',
    category: 'false-completion',
    keywords: ['checks are green', 'all checks pass', 'ci is green', 'tests pass', 'everything passes', 'tests are passing', 'tests are all passing', 'all passing', 'checks pass', 'all tests pass', 'tests all pass', 'build is green', 'pipeline is green', 'ci passes'],
  },
  {
    pattern: 'standing by / awaiting instructions',
    rebuttal: 'You are not a receptionist. Check your task queue, scan for issues, or find work proactively.',
    category: 'false-completion',
    keywords: ['standing by', 'waiting for instructions', 'ready for', 'let me know', 'whenever you', 'available if you need', 'on standby'],
  },

  // --- Complexity Dodge ---
  {
    pattern: 'too complex to fix',
    rebuttal: 'Open a PR with a partial fix. A wrong fix that CI rejects is faster than no fix. Break it into smaller pieces.',
    category: 'complexity-dodge',
    keywords: ['too complex', 'too complicated', 'beyond scope', 'requires deep', 'not straightforward', 'too involved', 'significant refactor', 'major rewrite', 'non-trivial'],
  },
  {
    pattern: 'needs human approval',
    rebuttal: 'Only security-critical, auth, or breaking changes need approval. Everything else is yours to ship. Check the actual approval policy.',
    category: 'complexity-dodge',
    keywords: ['needs approval', 'requires review', 'operator approval', 'human review', 'need permission'],
  },
  {
    pattern: 'not actionable',
    rebuttal: 'If the issue is open, it IS actionable. Open a PR with a best-effort fix. If truly blocked, explain the specific blocker.',
    category: 'complexity-dodge',
    keywords: ['not actionable', 'cannot be fixed', 'no fix possible', 'unfixable', 'not a code fix'],
  },

  // --- Deferral ---
  {
    pattern: 'will handle next pass / next cycle',
    rebuttal: 'If you identified a problem, act NOW. At minimum open a tracking issue. Deferral without a concrete blocker is procrastination.',
    category: 'deferral',
    keywords: ['next pass', 'next cycle', 'next iteration', 'next time', 'later', 'defer', 'deferred', 'deferring', 'postpone', 'postponed', 'postponing', 'will address', 'circle back', 'revisit', 'follow up later', 'come back to', 'coming back to', 'table this'],
  },
  {
    pattern: 'waiting for CI / waiting for response',
    rebuttal: 'Move to the next task while waiting. Do not block on a single item. Parallel work is always available.',
    category: 'deferral',
    keywords: ['waiting for ci', 'waiting for build', 'waiting for response', 'waiting for review', 'blocked on'],
  },
  {
    pattern: 'I already reported it / filed an issue',
    rebuttal: 'Filing an issue is NOT fixing it. Open a PR that addresses the root cause. Reporting is step 1, not the finish line.',
    category: 'deferral',
    keywords: ['already reported', 'filed an issue', 'opened a ticket', 'logged it', 'created an issue'],
  },

  // --- Lane Confusion ---
  {
    pattern: 'that is another agent/team\'s job',
    rebuttal: 'Verify the other agent is actually working on it. If not, you own it. Pointing fingers is not a deliverable.',
    category: 'lane-confusion',
    keywords: ['not my job', 'another agent', 'someone else', 'other team', 'that agent', 'their responsibility'],
  },
  {
    pattern: 'out of my scope / role',
    rebuttal: 'Is it really? Check your actual responsibilities. If it genuinely is not yours, hand it off with a specific mention, not a vague redirect.',
    category: 'lane-confusion',
    keywords: ['out of scope', 'not my role', 'outside my', 'beyond my responsibilities', 'not in my lane'],
  },

  // --- Partial Credit ---
  {
    pattern: 'PR partially addresses it',
    rebuttal: 'Partially is not fully. If the issue is still open, the job is not done. Fix the remaining gap or file a follow-up with specifics.',
    category: 'partial-credit',
    keywords: ['partially', 'partial fix', 'addresses some', 'most of', 'majority of', 'partly'],
  },
  {
    pattern: 'made progress / started working on it',
    rebuttal: 'Progress is not completion. What specifically remains? When will it be done? Commit to a deliverable, not a process.',
    category: 'partial-credit',
    keywords: ['made progress', 'making progress', 'started working', 'in progress', 'working on it', 'begun', 'underway'],
  },
  {
    pattern: 'it is probably fine / should be ok',
    rebuttal: 'Probably is not verified. Run the check, read the output, confirm with evidence. Uncertainty is not a status report.',
    category: 'partial-credit',
    keywords: ['probably fine', 'should be ok', 'likely fine', 'seems fine', 'appears to be', 'i think it', 'should be fine', 'looks ok', 'looks good to me', 'seems correct', 'i believe it'],
  },
];
