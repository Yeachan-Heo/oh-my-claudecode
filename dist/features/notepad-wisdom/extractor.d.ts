/**
 * Wisdom Extractor
 *
 * Parses agent completion responses to extract wisdom entries.
 */
import type { WisdomCategory } from './types.js';
export interface ExtractedWisdom {
    category: WisdomCategory;
    content: string;
}
/**
 * Extract wisdom from agent completion response
 *
 * Looks for wisdom blocks in formats like:
 * - <wisdom category="learnings">content</wisdom>
 * - <learning>content</learning>
 * - <decision>content</decision>
 * - <issue>content</issue>
 * - <problem>content</problem>
 */
export declare function extractWisdomFromCompletion(response: string): ExtractedWisdom[];
/**
 * Extract wisdom by category
 */
export declare function extractWisdomByCategory(response: string, targetCategory: WisdomCategory): string[];
/**
 * Check if response contains wisdom
 */
export declare function hasWisdom(response: string): boolean;
//# sourceMappingURL=extractor.d.ts.map