/**
 * @file Content generator — 포맷 다양화 + 셀프댓글 품질 개선 + 훅 품질 강화.
 *
 * Phase 3 개선:
 *   1. 포맷 다양화: 6가지 포맷 라운드로빈 + 니즈 성격 기반 선택
 *   2. 셀프댓글: 워밍업(post_count < 20)이면 생략, 이후 자연스러운 후기 톤
 *   3. 훅: 제품명 직접 노출 금지, 니즈/공감 중심
 */

import type { PositionFormat } from '../types.js';
import { db } from '../db/index.js';
import { affContents, contentLifecycle, accounts } from '../db/schema.js';
import { generateId } from '../utils/id.js';
import { callLLM, loadAgentPrompt, parseJSON } from './llm.js';
import type { DetectedNeed } from './needs-detector.js';
import type { ProductMatch } from './product-matcher.js';

// ─── Types ──────────────────────────────────────────────

interface ProductInfo {
  product_id: string;
  name: string;
  category: string;
  price_range: string;
  description: string;
  affiliate_link: string | null;
}

interface PositioningResult {
  format: PositionFormat;
  angle: string;
  tone: string;
  hook: string;
  avoid: string[];
  cta_style: string;
}

export interface GeneratedContent {
  id: string;
  product_id: string;
  product_name: string;
  need_id: string;
  format: PositionFormat;
  hook: string;
  bodies: string[];
  hooks: string[];
  self_comments: string[];
  positioning: {
    angle: string;
    tone: string;
    avoid: string[];
    cta_style: string;
  };
}

interface LLMContentOutput {
  hook: string;
  bodies: string[];
  hooks: string[];
  self_comments: string[];
}

// ─── Format Selection ───────────────────────────────────

const ALL_FORMATS: PositionFormat[] = [
  '문제공감형',
  '솔직후기형',
  '비교형',
  '입문추천형',
  '실수방지형',
  '비추천형',
];

/** 라운드로빈 인덱스 — 프로세스 단위로 유지 */
let formatRoundRobinIndex = 0;

/**
 * 니즈 성격에 따라 적합한 포맷을 선택한다.
 * 기본은 라운드로빈이지만, 특정 니즈 패턴에는 가중치를 부여한다.
 */
function selectFormat(need: DetectedNeed): PositionFormat {
  // 니즈 카테고리별 적합 포맷 매핑
  const categoryFormatMap: Record<string, PositionFormat[]> = {
    '불편해소': ['문제공감형', '실수방지형', '솔직후기형'],
    '시간절약': ['비교형', '솔직후기형', '입문추천형'],
    '돈절약': ['비교형', '비추천형', '솔직후기형'],
    '성과향상': ['솔직후기형', '입문추천형', '비교형'],
    '외모건강': ['문제공감형', '솔직후기형', '비추천형'],
    '자기표현': ['입문추천형', '솔직후기형', '문제공감형'],
  };

  const preferredFormats = categoryFormatMap[need.category];

  // purchase_linkage가 '상'이면 적합 포맷에서 우선 선택
  if (need.purchase_linkage === '상' && preferredFormats && preferredFormats.length > 0) {
    const idx = formatRoundRobinIndex % preferredFormats.length;
    formatRoundRobinIndex++;
    return preferredFormats[idx];
  }

  // 기본 라운드로빈
  const format = ALL_FORMATS[formatRoundRobinIndex % ALL_FORMATS.length];
  formatRoundRobinIndex++;
  return format;
}

// ─── Warmup Detection ───────────────────────────────────

/**
 * 현재 계정들의 총 포스트 수를 확인하여 워밍업 모드인지 판단한다.
 * 워밍업: 전체 post_count 합 < 20
 */
async function isWarmupMode(): Promise<boolean> {
  try {
    const accountRows = await db.select().from(accounts);
    if (accountRows.length === 0) {
      // 계정이 없으면 워밍업으로 간주
      return true;
    }
    const totalPosts = accountRows.reduce((sum, a) => sum + a.post_count, 0);
    return totalPosts < 20;
  } catch {
    // DB 오류 시 안전하게 워밍업으로 간주
    return true;
  }
}

// ─── Positioning ────────────────────────────────────────

async function generatePositioning(
  match: ProductMatch,
  need: DetectedNeed,
  product: ProductInfo,
  selectedFormat: PositionFormat,
): Promise<PositioningResult> {
  const systemPrompt = loadAgentPrompt('positioning');

  const userMessage = JSON.stringify({
    instruction: `Generate a positioning card for this product-need pair. The format MUST be "${selectedFormat}". You MUST respond with ONLY a valid JSON object. No explanations, no prose, no markdown — just raw JSON.`,
    need: {
      need_id: need.need_id,
      category: need.category,
      problem: need.problem,
      purchase_linkage: need.purchase_linkage,
      threads_fit: need.threads_fit,
    },
    product: {
      product_id: product.product_id,
      name: product.name,
      category: product.category,
      price_range: product.price_range,
      description: product.description,
    },
    match: {
      match_score: match.match_score,
      competition: match.competition,
    },
    required_format: selectedFormat,
    expected_output_schema: {
      format: 'PositionFormat',
      angle: 'string',
      tone: 'string',
      hook: 'string',
      avoid: 'string[]',
      cta_style: 'string',
    },
  });

  const raw = await callLLM({
    model: 'claude-sonnet-4-20250514',
    systemPrompt,
    userMessage,
    maxTokens: 2048,
  });

  const parsed = parseJSON<Record<string, unknown>>(raw);

  // 포맷 강제 적용 — LLM이 다른 포맷을 반환해도 선택된 포맷으로 오버라이드
  return {
    format: selectedFormat,
    angle: (parsed.angle as string) || '일반적 관점',
    tone: (parsed.tone as string) || '공감+솔직',
    hook: (parsed.hook as string) || '',
    avoid: Array.isArray(parsed.avoid) ? (parsed.avoid as string[]) : [],
    cta_style: (parsed.cta_style as string) || '프로필 링크 유도',
  };
}

// ─── Content Generation ─────────────────────────────────

export async function generateContent(
  match: ProductMatch,
  need: DetectedNeed,
  product: ProductInfo,
): Promise<GeneratedContent> {
  // 포맷 선택 (라운드로빈 + 니즈 기반)
  const selectedFormat = selectFormat(need);

  // 워밍업 모드 체크
  const warmup = await isWarmupMode();

  const positioning = await generatePositioning(match, need, product, selectedFormat);

  const systemPrompt = loadAgentPrompt('content');

  // 워밍업 모드에 따른 지시사항 분기
  const selfCommentInstruction = warmup
    ? 'self_comments: 빈 배열 [] 반환 (워밍업 모드 — 첫 20개 포스트는 셀프댓글 없이 순수 콘텐츠만 발행)'
    : `self_comments: 자연스러운 후기 톤의 셀프댓글 2개 생성.
      - 댓글 1: 대화 유도형 (비슷한 경험 공유 요청, 궁금증 유발)
      - 댓글 2: 정보 보충형 (가격대, 사용 기간, 프로필 유도)
      - 절대 금지: "좋은 정보 감사합니다", "잘 읽었습니다" 등 무의미한 댓글
      - 제휴링크 자리를 자연스럽게 포함할 수 있음`;

  const hookInstruction = `훅(hook) 생성 규칙:
    - 제품명(${product.name}) 직접 노출 절대 금지
    - 니즈/공감/호기심 중심으로 작성
    - 30자 이내
    - 예시: "이거 나만 모르고 있었나?" (O), "${product.name} 써봤는데" (X)`;

  const userMessage = JSON.stringify({
    instruction: `Generate Threads post content based on the positioning.
Format: ${selectedFormat}
${hookInstruction}
${selfCommentInstruction}
You MUST respond with ONLY a valid JSON object containing: hook, bodies (3 variations), hooks (5 variations), and self_comments. No explanations, no prose, no markdown — just raw JSON.`,
    positioning: {
      format: positioning.format,
      angle: positioning.angle,
      tone: positioning.tone,
      hook: positioning.hook,
      avoid: [...positioning.avoid, `제품명 "${product.name}" 직접 노출`],
      cta_style: positioning.cta_style,
    },
    need: {
      category: need.category,
      problem: need.problem,
      representative_expressions: need.representative_expressions,
    },
    product: {
      name: product.name,
      category: product.category,
      price_range: product.price_range,
      description: product.description,
    },
    warmup_mode: warmup,
    expected_output_schema: {
      hook: 'string (제품명 노출 금지, 니즈/공감 중심, 30자 이내)',
      bodies: 'string[] (3 variations, 각각 다른 전략: 공감형/스토리형/호기심형)',
      hooks: 'string[] (5 variations: 질문형/반전형/공감형/숫자형/고백형)',
      self_comments: warmup ? '[] (워밍업 모드)' : 'string[] (2개, 자연스러운 후기 톤)',
    },
  });

  const raw = await callLLM({
    model: 'claude-sonnet-4-20250514',
    systemPrompt,
    userMessage,
    maxTokens: 4096,
  });

  const rawContent = parseJSON<Record<string, unknown>>(raw);

  // Sanitize content output
  const contentOutput: LLMContentOutput = {
    hook: sanitizeHook((rawContent.hook as string) || positioning.hook, product.name),
    bodies: Array.isArray(rawContent.bodies) ? (rawContent.bodies as string[]) : [(rawContent.body as string) || positioning.hook],
    hooks: sanitizeHooks(
      Array.isArray(rawContent.hooks) ? (rawContent.hooks as string[]) : [positioning.hook],
      product.name,
    ),
    self_comments: warmup
      ? [] // 워밍업 모드: 셀프댓글 생략
      : sanitizeSelfComments(
          Array.isArray(rawContent.self_comments)
            ? (rawContent.self_comments as string[])
            : Array.isArray(rawContent.selfComments)
              ? (rawContent.selfComments as string[])
              : [],
        ),
  };

  const contentId = generateId('afc');

  const generated: GeneratedContent = {
    id: contentId,
    product_id: product.product_id,
    product_name: product.name,
    need_id: need.need_id,
    format: positioning.format,
    hook: contentOutput.hook,
    bodies: contentOutput.bodies,
    hooks: contentOutput.hooks,
    self_comments: contentOutput.self_comments,
    positioning: {
      angle: positioning.angle,
      tone: positioning.tone,
      avoid: positioning.avoid,
      cta_style: positioning.cta_style,
    },
  };

  await db.insert(affContents).values({
    id: generated.id,
    product_id: generated.product_id,
    product_name: generated.product_name,
    need_id: generated.need_id,
    format: generated.format,
    hook: generated.hook,
    bodies: generated.bodies,
    hooks: generated.hooks,
    self_comments: generated.self_comments,
    positioning: generated.positioning,
    competition: match.competition,
    match_priority: match.priority,
    match_why: match.match_why,
  });

  // Lifecycle tracking is supplementary — don't fail content generation if it errors
  try {
    const lifecycleId = generateId('lc');
    await db.insert(contentLifecycle).values({
      id: lifecycleId,
      source_post_id: need.sample_post_ids[0] ?? 'unknown',
      source_channel_id: 'analyzer',
      source_engagement: 0,
      source_relevance: 0,
      extracted_need: need.problem,
      need_category: need.category,
      need_confidence: need.threads_fit / 5,
      matched_product_id: product.product_id,
      match_relevance: match.match_score / 100,
      content_text: generated.bodies[0] ?? '',
      content_style: generated.format,
      hook_type: generated.hook,
      posted_account_id: 'pending',
    });
  } catch (lcErr) {
    const cause = (lcErr as any)?.cause?.message ?? (lcErr as Error).message;
    console.warn(`[content-generator] Lifecycle insert failed (non-critical): ${cause}`);
  }

  return generated;
}

// ─── Sanitization Helpers ───────────────────────────────

/**
 * 훅에서 제품명이 직접 노출되면 제거한다.
 */
function sanitizeHook(hook: string, productName: string): string {
  if (!hook) return '';
  // 제품명이 포함되어 있으면 제거
  if (hook.includes(productName)) {
    return hook.replace(new RegExp(escapeRegex(productName), 'g'), '이거');
  }
  return hook;
}

/**
 * 훅 배열에서 제품명 직접 노출을 제거한다.
 */
function sanitizeHooks(hooks: string[], productName: string): string[] {
  return hooks.map((h) => sanitizeHook(h, productName));
}

/**
 * 셀프댓글에서 무의미한 패턴을 필터링한다.
 */
function sanitizeSelfComments(comments: string[]): string[] {
  const bannedPatterns = [
    '좋은 정보 감사',
    '잘 읽었습니다',
    '감사합니다',
    '좋은 글',
    '유익한 정보',
    '잘 보고 갑니다',
    '공감합니다',
    '도움이 됐습니다',
  ];

  return comments.filter((comment) => {
    const lower = comment.toLowerCase();
    return !bannedPatterns.some((pattern) => lower.includes(pattern));
  });
}

/**
 * 정규식 특수문자 이스케이프
 */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
