/**
 * Complexity Signal Extraction
 *
 * Extracts complexity signals from task prompts to inform routing decisions.
 * Signals are categorized into lexical, structural, and context types.
 */
import type { LexicalSignals, StructuralSignals, ContextSignals, ComplexitySignals, RoutingContext } from './types.js';
/**
 * Extract lexical signals from task prompt
 * These are fast, regex-based extractions that don't require model calls
 */
export declare function extractLexicalSignals(prompt: string): LexicalSignals;
/**
 * Extract structural signals from task prompt
 * These require more sophisticated parsing
 */
export declare function extractStructuralSignals(prompt: string): StructuralSignals;
/**
 * Extract context signals from routing context
 */
export declare function extractContextSignals(context: RoutingContext): ContextSignals;
/**
 * Extract all complexity signals
 */
export declare function extractAllSignals(prompt: string, context: RoutingContext): ComplexitySignals;
//# sourceMappingURL=signals.d.ts.map