import type { PositionFormat } from '../types.js';
import { db } from '../db/index.js';
import { affContents, contentLifecycle } from '../db/schema.js';
import { generateId } from '../utils/id.js';
import { callLLM, loadAgentPrompt, parseJSON } from './llm.js';
import type { DetectedNeed } from './needs-detector.js';
import type { ProductMatch } from './product-matcher.js';

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

async function generatePositioning(
  match: ProductMatch,
  need: DetectedNeed,
  product: ProductInfo,
): Promise<PositioningResult> {
  const systemPrompt = loadAgentPrompt('positioning');

  const userMessage = JSON.stringify({
    instruction: 'Generate a positioning card for this product-need pair. Return a single JSON object.',
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

  // Validate and sanitize positioning result
  const validFormats: PositionFormat[] = ['문제공감형', '솔직후기형', '비교형', '입문추천형', '실수방지형', '비추천형'];
  const format = validFormats.includes(parsed.format as PositionFormat)
    ? (parsed.format as PositionFormat)
    : '문제공감형';

  return {
    format,
    angle: (parsed.angle as string) || '일반적 관점',
    tone: (parsed.tone as string) || '공감+솔직',
    hook: (parsed.hook as string) || `${product.name} 써봤는데...`,
    avoid: Array.isArray(parsed.avoid) ? (parsed.avoid as string[]) : [],
    cta_style: (parsed.cta_style as string) || '프로필 링크 유도',
  };
}

export async function generateContent(
  match: ProductMatch,
  need: DetectedNeed,
  product: ProductInfo,
): Promise<GeneratedContent> {
  const positioning = await generatePositioning(match, need, product);

  const systemPrompt = loadAgentPrompt('content');

  const userMessage = JSON.stringify({
    instruction: 'Generate Threads post content based on the positioning. Return JSON with hook, bodies (3 variations), hooks (5 variations), and self_comments (2).',
    positioning: {
      format: positioning.format,
      angle: positioning.angle,
      tone: positioning.tone,
      hook: positioning.hook,
      avoid: positioning.avoid,
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
    expected_output_schema: {
      hook: 'string',
      bodies: 'string[] (3 variations)',
      hooks: 'string[] (5 variations)',
      self_comments: 'string[] (2)',
    },
  });

  const raw = await callLLM({
    model: 'claude-sonnet-4-20250514',
    systemPrompt,
    userMessage,
    maxTokens: 4096,
  });

  const rawContent = parseJSON<Record<string, unknown>>(raw);

  // Sanitize content output — ensure required fields have defaults
  const contentOutput: LLMContentOutput = {
    hook: (rawContent.hook as string) || positioning.hook || `${product.name} 써봤는데...`,
    bodies: Array.isArray(rawContent.bodies) ? (rawContent.bodies as string[]) : [(rawContent.body as string) || positioning.hook],
    hooks: Array.isArray(rawContent.hooks) ? (rawContent.hooks as string[]) : [positioning.hook],
    self_comments: Array.isArray(rawContent.self_comments)
      ? (rawContent.self_comments as string[])
      : Array.isArray(rawContent.selfComments)
        ? (rawContent.selfComments as string[])
        : ['좋은 정보 감사합니다!'],
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
