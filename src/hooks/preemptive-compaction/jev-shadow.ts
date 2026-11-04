/**
 * Jev shadow judgment: "context-pruning" (judgment point 5).
 *
 * In shadow/off mode the heuristic (analyzeContextUsage -> action) decides;
 * Jev's staleness Score is requested asynchronously (blocking: false) and
 * recorded in the shadow log for later comparison. In active mode the score
 * is mapped to an action (see mapAnswer below). With no key configured this
 * is a no-op: zero HTTP calls, no log.
 *
 * The point declaration (questions, blocking flag) lives in the jev registry
 * (hooks/jev/points.ts); this module keeps the call-specific state shape.
 */

import { getJudgmentPoint, recordJudgment } from '../jev/index.js';
import type { JevAnswer, ResolveResult } from '../jev/index.js';

export const CONTEXT_PRUNING_POINT = 'context-pruning';

/** Staleness labels in the order of the point's score criteria (low to high). */
function readStalenessLabels(): string[] {
  const questions = getJudgmentPoint(CONTEXT_PRUNING_POINT).questions[0];
  const resolved = typeof questions === 'function' ? questions() : questions;
  return Object.keys(resolved.staleness?.criteria ?? {});
}

const STALENESS_LABELS = readStalenessLabels();

/**
 * Staleness label from a Jev answer. Only a score answer counts; another
 * answer type yields no label, even when it carries a `choice`. A score answer
 * carries only `score` (0 = fresh ... 3 = stale), so it is rounded to the
 * nearest label; a score outside 0..3 or a non-number yields no label. A
 * string `choice` that names one of the labels (case-insensitively) wins.
 */
export function stalenessLabelOf(answer: JevAnswer): string | undefined {
  if (answer.type !== 'score') return undefined;
  const choice = typeof answer.choice === 'string' ? answer.choice.toLowerCase() : undefined;
  if (choice !== undefined && STALENESS_LABELS.includes(choice)) return choice;
  const { score } = answer;
  if (typeof score !== 'number' || !Number.isFinite(score)) return undefined;
  if (score < 0 || score > STALENESS_LABELS.length - 1) return undefined;
  return STALENESS_LABELS[Math.round(score)];
}

/** Metadata-only summary of one pruning candidate (a tool result). */
export interface PruningCandidate {
  /** Tool that produced the result, e.g. "read". */
  tool: string;
  /** Estimated token size of the result. */
  tokens: number;
  /** First-line excerpt of the result; bounded before send by the resolver. */
  excerpt: string;
}

/**
 * Record one shadow comparison for the context-pruning point.
 *
 * The twin is the heuristic's own action ('none' | 'warn' | 'compact'); in
 * shadow/off mode the twin is returned immediately (blocking: false) and the
 * Jev comparison is logged when it settles. In active mode, Jev's Score
 * answer is mapped to an action and returned immediately. Never rejects on
 * the Jev path. One call per compaction run with a summary state — never one
 * call per candidate.
 */
export function recordContextPruningShadow(args: {
  /** Heuristic twin decision for this run. */
  action: 'none' | 'warn' | 'compact';
  /** Cumulative session token estimate at decision time. */
  totalTokens: number;
  /** Candidate summaries: metadata and bounded excerpts only. */
  candidates: PruningCandidate[];
  /** Test hook: injected transport. */
  fetchFn?: typeof fetch;
}): Promise<ResolveResult<string>> {
  return recordJudgment<string>(CONTEXT_PRUNING_POINT, {
    state: {
      action: args.action,
      totalTokens: args.totalTokens,
      candidateCount: args.candidates.length,
      candidates: args.candidates.map((candidate) => ({
        tool: candidate.tool,
        tokens: candidate.tokens,
        excerpt: candidate.excerpt,
      })),
    },
    twin: () => args.action,
    mapHeuristic: (result, questionSet) => result,
    mapAnswer: (answer: JevAnswer) => {
      const label = stalenessLabelOf(answer);
      // Map staleness to action: fresh/recent -> none, aging -> warn, stale -> compact
      if (label === 'fresh' || label === 'recent') return 'none';
      if (label === 'aging') return 'warn';
      if (label === 'stale') return 'compact';
      return args.action; // No usable answer: keep the heuristic action
    },
    fetchFn: args.fetchFn,
  });
}
