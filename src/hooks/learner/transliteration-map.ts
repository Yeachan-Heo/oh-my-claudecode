/**
 * Transliteration Map Module
 *
 * Provides static mappings from English trigger terms to their transliterated
 * equivalents in other languages. Used by bridge.ts to expand trigger words
 * at cache load time so that the existing `includes()` matching works
 * automatically for non-Latin input.
 *
 * Architecture:
 * - Each locale has its own mapping object (English key -> array of locale variants)
 * - Adding a new locale requires only adding a new map and registering it
 * - No changes to bridge.ts or matching logic needed for new locales
 *
 * @see https://github.com/Yeachan-Heo/oh-my-claudecode/issues/1820
 */

// =============================================================================
// Types
// =============================================================================

/** A mapping from lowercase English terms to their transliterated variants */
export type TransliterationMap = Record<string, string[]>;

/** Registry of all locale maps */
export interface LocaleRegistry {
  [locale: string]: TransliterationMap;
}

// =============================================================================
// Korean (ko) Transliteration Map
// =============================================================================

/**
 * Korean transliterations of common English terms used in skill triggers.
 *
 * Keys are lowercase English terms. Values are arrays of Korean variants
 * (including spacing variants, e.g., "딥다이브" and "딥 다이브").
 *
 * To add new entries: add the English term as key and Korean variants as values.
 */
const koMap: TransliterationMap = {
  // Development workflow terms
  "deep dive": ["딥다이브", "딥 다이브"],
  "deep-dive": ["딥다이브", "딥 다이브"],
  debug: ["디버그", "디버깅"],
  debugging: ["디버깅"],
  deploy: ["디플로이", "배포"],
  deployment: ["디플로이먼트", "배포"],
  refactor: ["리팩토링", "리팩터"],
  refactoring: ["리팩토링"],
  review: ["리뷰"],
  "code review": ["코드 리뷰", "코드리뷰"],
  commit: ["커밋"],
  merge: ["머지"],
  rollback: ["롤백"],
  hotfix: ["핫픽스"],
  release: ["릴리스", "릴리즈"],

  // Architecture & design
  architecture: ["아키텍처"],
  design: ["디자인"],
  "design pattern": ["디자인 패턴", "디자인패턴"],
  microservice: ["마이크로서비스"],
  monolith: ["모놀리스"],
  api: ["에이피아이"],
  endpoint: ["엔드포인트"],
  database: ["데이터베이스"],
  schema: ["스키마"],
  migration: ["마이그레이션"],

  // Testing
  test: ["테스트"],
  testing: ["테스팅"],
  "unit test": ["유닛 테스트", "유닛테스트", "단위 테스트"],
  "integration test": ["통합 테스트", "통합테스트", "인테그레이션 테스트"],
  benchmark: ["벤치마크"],
  coverage: ["커버리지"],

  // Analysis & investigation
  analyze: ["분석"],
  analysis: ["분석"],
  investigate: ["조사"],
  "investigate deeply": ["깊이 조사", "심층 분석"],
  trace: ["트레이스", "추적"],
  "trace and interview": ["트레이스 앤 인터뷰"],
  profile: ["프로파일"],
  profiling: ["프로파일링"],
  optimize: ["최적화", "옵티마이즈"],
  optimization: ["최적화", "옵티마이제이션"],
  performance: ["퍼포먼스", "성능"],

  // Infrastructure
  docker: ["도커"],
  kubernetes: ["쿠버네티스"],
  pipeline: ["파이프라인"],
  ci: ["씨아이"],
  cd: ["씨디"],
  monitoring: ["모니터링"],
  logging: ["로깅"],

  // General
  setup: ["셋업", "설정"],
  config: ["설정", "컨피그"],
  configuration: ["설정", "컨피규레이션"],
  scaffold: ["스캐폴드"],
  template: ["템플릿", "템플릿"],
  boilerplate: ["보일러플레이트"],
  documentation: ["문서화", "도큐멘테이션"],
  tutorial: ["튜토리얼"],
  explain: ["설명"],
  summarize: ["요약"],
  simplify: ["단순화", "심플리파이"],
};

// =============================================================================
// Locale Registry
// =============================================================================

/**
 * Registry of all available locale transliteration maps.
 *
 * To add a new locale:
 * 1. Create a new map (e.g., `jaMap` for Japanese) following the same pattern
 * 2. Add it to this registry with the appropriate locale key
 */
const localeRegistry: LocaleRegistry = {
  ko: koMap,
};

// =============================================================================
// Public API
// =============================================================================

/**
 * Expand an array of trigger strings with transliterated variants from all
 * registered locales.
 *
 * Given triggers like ["deep dive", "deep-dive"], returns an expanded array
 * that includes the originals plus any transliterated variants:
 * ["deep dive", "deep-dive", "딥다이브", "딥 다이브"]
 *
 * All returned strings are lowercase.
 *
 * @param triggersLower - Array of lowercase trigger strings
 * @returns Expanded array with original triggers + transliterated variants (deduped)
 */
export function expandTriggers(triggersLower: string[]): string[] {
  const expanded = new Set<string>(triggersLower);

  for (const localeMap of Object.values(localeRegistry)) {
    for (const trigger of triggersLower) {
      const variants = localeMap[trigger];
      if (variants) {
        for (const variant of variants) {
          expanded.add(variant.toLowerCase());
        }
      }
    }
  }

  return Array.from(expanded);
}

/**
 * Get the locale registry (for testing/inspection).
 */
export function getLocaleRegistry(): Readonly<LocaleRegistry> {
  return localeRegistry;
}
