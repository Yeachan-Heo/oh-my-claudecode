/**
 * Korean transliteration map for cross-script trigger matching.
 *
 * Maps lowercase English trigger phrases to their Korean equivalents.
 * Used at cache-load time to expand triggersLower arrays so that
 * promptLower.includes(triggerLower) matches Korean user input.
 *
 * SCOPE: Only skills with explicit `triggers:` in YAML frontmatter.
 * Built-in skills (autopilot, ralph, etc.) are handled by keyword-detector
 * regex patterns, NOT by this map.
 *
 * To add a new locale: create a new map file (e.g., japanese-map.ts)
 * and compose expandTriggers calls in bridge.ts.
 */

/** English trigger -> Korean transliterations */
const KOREAN_MAP: Record<string, string[]> = {
  // === deep-dive skill ===
  "deep dive": ["딥다이브", "딥 다이브"],
  "deep-dive": ["딥다이브"],
  "trace and interview": ["트레이스 앤 인터뷰", "추적 인터뷰"],
  "investigate deeply": ["깊이 조사", "심층 조사"],

  // === deep-pipeline skill ===
  "deep-pipeline": ["딥파이프라인", "딥 파이프라인"],
  "deep-pipe": ["딥파이프"],
  "pipeline-cycle": ["파이프라인 사이클"],
  "dev-pipeline": ["개발 파이프라인"],
  "dev-cycle": ["개발 사이클"],

  // === configure-notifications skill ===
  "configure notifications": ["알림 설정", "노티 설정"],
  "setup notifications": ["알림 설정"],
  "configure telegram": ["텔레그램 설정"],
  "setup telegram": ["텔레그램 설정"],
  "telegram bot": ["텔레그램 봇"],
  "configure discord": ["디스코드 설정"],
  "setup discord": ["디스코드 설정"],
  "discord webhook": ["디스코드 웹훅"],
  "configure slack": ["슬랙 설정"],
  "setup slack": ["슬랙 설정"],
  "slack webhook": ["슬랙 웹훅"],
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
export function expandTriggers(triggersLower: string[]): string[] {
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
