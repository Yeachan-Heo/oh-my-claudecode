/**
 * Prompt SSOT metrics — epic #3698 / issue #3704.
 *
 * Deterministic, dependency-free tokenization and duplication measurement.
 * Used by scripts/measure-prompt-ssot.mts to report:
 * - total tokens, unique n-grams, repeated-clause ratio per corpus
 * - duplicate-clause token reduction: legacy sources vs SSOT sources
 * - projection drift: composed vs committed projection bodies
 *
 * Targets (plan §6.2/§7): 35-50% fewer repeated policy tokens, <5% drift.
 */

import { normalizePromptText } from './digest.js';

/** Whitespace/punctuation tokenizer; deterministic and locale-independent. */
export function tokenize(text: string): string[] {
  return normalizePromptText(text)
    .toLowerCase()
    .split(/[^a-z0-9/_-]+/)
    .filter((t) => t.length > 0);
}

export interface CorpusStats {
  totalTokens: number;
  uniqueTokens: number;
  uniqueNGrams: number;
  /**
   * Share of tokens that belong to n-grams occurring more than once within
   * the corpus. 1.0 means every token is part of a repeated clause.
   */
  repeatedClauseRatio: number;
  /** Tokens attributable to n-gram occurrences beyond the first. */
  repeatedTokens: number;
}

export function corpusStats(texts: readonly string[], nGramSize = 8): CorpusStats {
  const tokens = texts.flatMap((t) => tokenize(t));
  const ngramCounts = new Map<string, number>();
  for (let i = 0; i + nGramSize <= tokens.length; i++) {
    const gram = tokens.slice(i, i + nGramSize).join(' ');
    ngramCounts.set(gram, (ngramCounts.get(gram) ?? 0) + 1);
  }
  let repeatedPositions = 0;
  let extraOccurrences = 0;
  for (const count of ngramCounts.values()) {
    if (count > 1) {
      repeatedPositions += count * nGramSize;
      extraOccurrences += (count - 1) * nGramSize;
    }
  }
  return {
    totalTokens: tokens.length,
    uniqueTokens: new Set(tokens).size,
    uniqueNGrams: ngramCounts.size,
    repeatedClauseRatio: tokens.length === 0 ? 0 : repeatedPositions / tokens.length,
    repeatedTokens: extraOccurrences,
  };
}

/**
 * Projection drift: token-level symmetric difference ratio between a composed
 * body and a committed projection body. 0 = no drift.
 */
export function projectionDrift(composed: string, committed: string): number {
  const a = tokenize(composed);
  const b = tokenize(committed);
  if (a.length === 0 && b.length === 0) return 0;
  const counts = new Map<string, number>();
  for (const t of a) counts.set(t, (counts.get(t) ?? 0) + 1);
  let common = 0;
  for (const t of b) {
    const c = counts.get(t) ?? 0;
    if (c > 0) {
      counts.set(t, c - 1);
      common++;
    }
  }
  const union = a.length + b.length - common;
  return union === 0 ? 0 : 1 - common / union;
}

export interface ReductionReport {
  baseline: CorpusStats;
  ssot: CorpusStats;
  /** (baseline.repeatedTokens - ssot.repeatedTokens) / baseline.repeatedTokens */
  repeatedTokenReduction: number;
  drift: number;
}
