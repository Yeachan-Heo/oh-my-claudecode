/**
 * @file tone-validator.ts — 비전문가 톤 검증기
 *
 * 성분명/의학용어가 포함된 콘텐츠를 감지해 차단.
 * 규칙: 전문가 용어 직접 노출 금지. 비전문가 표현("피부가 촉촉해요")만 허용.
 *
 * 순수 함수 (DB 없음). gate5_brandSafety와 같은 패턴으로 구현.
 */

export interface ToneValidationResult {
  passed: boolean;
  violations: string[];
  reason?: string;
}

// ─── 금지 성분명/의학용어 목록 ────────────────────────────────

/** 한국어 성분명 */
const KO_INGREDIENTS = [
  '나이아신아마이드',
  '레티놀',
  '레티노이드',
  '레티노산',
  '히알루론산',
  '세라마이드',
  '아데노신',
  '펩타이드',
  '폴리펩타이드',
  '알부틴',
  '알파알부틴',
  '베타알부틴',
  '글루타치온',
  '코지산',
  '살리실산',
  '글리콜산',
  '아스코르브산',
  '아스코르빈산',
  '덱스판테놀',
  '판테놀',
  '알란토인',
  '마데카소사이드',
  '센텔라아시아티카',
  '트레티노인',
  '트레티노이드',
  'EGF',
  'bFGF',
  'AHA',
  'BHA',
  'PHA',
  'LHA',
];

/** 한국어 의학/피부과학 용어 */
const KO_MEDICAL = [
  '항산화',
  '색소침착',
  '각질세포',
  '멜라닌',
  '피부장벽',
  '피부장벽강화',
  '콜라겐합성',
  '표피',
  '진피',
  '항염',
  '항균',
  '세포재생',
  '피부재생',
  '활성산소',
  '혈액순환',
];

/** 영문 성분명 (대소문자 무시) */
const EN_INGREDIENTS = [
  'retinol',
  'retinoid',
  'retinoic acid',
  'niacinamide',
  'hyaluronic acid',
  'ceramide',
  'adenosine',
  'peptide',
  'salicylic acid',
  'glycolic acid',
  'ascorbic acid',
  'dexpanthenol',
  'allantoin',
  'madecassoside',
  'glutathione',
  'kojic acid',
  'arbutin',
  'alpha arbutin',
  'tretinoin',
  'bakuchiol',
];

// ─── 패턴 빌드 ────────────────────────────────────────────────

/** 단어 경계 없이 포함 여부 체크 (한국어는 단어 경계 개념 없음) */
function buildPattern(terms: string[], flags = ''): RegExp {
  const escaped = terms.map(t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return new RegExp(escaped.join('|'), flags);
}

const _KO_PATTERN = buildPattern([...KO_INGREDIENTS, ...KO_MEDICAL]);
const _EN_PATTERN = buildPattern(EN_INGREDIENTS, 'gi');

// ─── 핵심 함수 ────────────────────────────────────────────────

/**
 * 콘텐츠에서 성분명/의학용어를 감지해 결과 반환.
 *
 * @param content - 검사할 텍스트
 * @returns ToneValidationResult
 */
export function validateTone(content: string): ToneValidationResult {
  if (!content) {
    return { passed: true, violations: [] };
  }

  const found = new Set<string>();

  // 한국어 성분명 검사
  for (const term of [...KO_INGREDIENTS, ...KO_MEDICAL]) {
    if (content.includes(term)) {
      found.add(term);
    }
  }

  // 영문 성분명 검사 (대소문자 무시)
  const lower = content.toLowerCase();
  for (const term of EN_INGREDIENTS) {
    if (lower.includes(term.toLowerCase())) {
      found.add(term);
    }
  }

  const violations = Array.from(found);

  if (violations.length === 0) {
    return { passed: true, violations: [] };
  }

  return {
    passed: false,
    violations,
    reason: `전문가 용어 감지 (${violations.slice(0, 3).join(', ')}${violations.length > 3 ? ` 외 ${violations.length - 3}개` : ''}) — 비전문가 표현으로 바꿔주세요`,
  };
}

/** gates.ts와 동일한 GateResult 인터페이스 반환 버전 */
export function gate_toneCheck(content: string): {
  gate: string;
  passed: boolean;
  reason?: string;
  severity: 'block' | 'warn';
} {
  const result = validateTone(content);
  return {
    gate: 'gate_toneCheck',
    passed: result.passed,
    reason: result.reason,
    severity: 'block',
  };
}
