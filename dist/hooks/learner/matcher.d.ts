export interface MatchResult {
    skillId: string;
    confidence: number;
    matchedTriggers: string[];
    matchType: 'exact' | 'fuzzy' | 'pattern' | 'semantic';
    context: MatchContext;
}
export interface MatchContext {
    detectedErrors: string[];
    detectedFiles: string[];
    detectedPatterns: string[];
}
interface SkillInput {
    id: string;
    triggers: string[];
    tags?: string[];
}
interface MatchOptions {
    threshold?: number;
    maxResults?: number;
}
/**
 * Match skills against a prompt using multiple matching strategies
 */
export declare function matchSkills(prompt: string, skills: SkillInput[], options?: MatchOptions): MatchResult[];
/**
 * Fuzzy string matching using Levenshtein distance
 * Returns confidence score 0-100
 */
export declare function fuzzyMatch(text: string, pattern: string): number;
/**
 * Extract contextual information from the prompt
 */
export declare function extractContext(prompt: string): MatchContext;
/**
 * Calculate confidence score based on match metrics
 */
export declare function calculateConfidence(matches: number, total: number, matchType: string): number;
export {};
//# sourceMappingURL=matcher.d.ts.map