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
/** English trigger -> Korean transliterations (loanwords only, no native Korean translations) */
const KOREAN_MAP = {
    // === deep-dive skill ===
    "deep dive": ["딥다이브", "딥 다이브"],
    "deep-dive": ["딥다이브"],
    "trace and interview": ["트레이스 앤 인터뷰"],
    // === deep-pipeline skill ===
    "deep-pipeline": ["딥파이프라인", "딥 파이프라인"],
    "deep-pipe": ["딥파이프"],
};
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
export function expandTriggers(triggersLower) {
    const expanded = new Set(triggersLower);
    for (const trigger of triggersLower) {
        const koreanVariants = KOREAN_MAP[trigger];
        if (koreanVariants) {
            for (const variant of koreanVariants) {
                expanded.add(variant);
            }
        }
    }
    return Array.from(expanded);
}
//# sourceMappingURL=transliteration-map.js.map