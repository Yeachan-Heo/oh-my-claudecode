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
/** Whitespace/punctuation tokenizer; deterministic and locale-independent. */
export declare function tokenize(text: string): string[];
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
export declare function corpusStats(texts: readonly string[], nGramSize?: number): CorpusStats;
/**
 * Projection drift: token-level symmetric difference ratio between a composed
 * body and a committed projection body. 0 = no drift.
 */
export declare function projectionDrift(composed: string, committed: string): number;
export interface ReductionReport {
    baseline: CorpusStats;
    ssot: CorpusStats;
    /** (baseline.repeatedTokens - ssot.repeatedTokens) / baseline.repeatedTokens */
    repeatedTokenReduction: number;
    drift: number;
}
//# sourceMappingURL=metrics.d.ts.map