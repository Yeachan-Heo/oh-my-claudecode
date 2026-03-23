/**
 * Korean transliteration map for cross-script trigger matching.
 *
 * Maps lowercase English trigger phrases to their Korean equivalents.
 * Used at cache-load time to expand triggersLower arrays so that
 * promptLower.includes(triggerLower) matches Korean user input.
 *
 * SCOPE: Only foreign-loanword transliterations, not native Korean translations.
 * Only skills with explicit `triggers:` in YAML frontmatter,
 * limited to phrases specific enough to avoid false positives.
 * Built-in skills (autopilot, ralph, etc.) are handled by keyword-detector
 * regex patterns, NOT by this map.
 *
 * To add a new locale: create a new map file (e.g., japanese-map.ts)
 * and compose expandTriggers calls in bridge.ts.
 */
/**
 * Expand an array of lowercase English triggers to include Korean transliterations.
 * Returns a new array containing originals + all mapped Korean equivalents.
 * Deduplicates via Set.
 *
 * Note: The returned triggers are for triggersLower only (used in substring matching).
 * The original triggers array (used for display in MatchedSkill) is NOT expanded,
 * so Korean variants won't appear in user-facing trigger lists.
 *
 * @param triggersLower - pre-lowercased English triggers
 * @returns expanded array including Korean equivalents
 */
export declare function expandTriggers(triggersLower: string[]): string[];
//# sourceMappingURL=transliteration-map.d.ts.map