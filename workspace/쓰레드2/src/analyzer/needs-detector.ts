import type { NeedsCategory, PurchaseLinkage, SignalLevel } from '../types.js';
import { db } from '../db/index.js';
import { needs } from '../db/schema.js';
import { generateId } from '../utils/id.js';
import { callLLM, loadAgentPrompt, parseJSON } from './llm.js';
import type { ResearchBrief } from './researcher.js';

export interface DetectedNeed {
  need_id: string;
  category: NeedsCategory;
  problem: string;
  representative_expressions: string[];
  signal_strength: SignalLevel;
  post_count: number;
  purchase_linkage: PurchaseLinkage;
  why_linkage: string;
  product_categories: string[];
  threads_fit: number;
  threads_fit_reason: string;
  sample_post_ids: string[];
}

interface LLMNeedOutput {
  category: NeedsCategory;
  problem: string;
  representative_expressions: string[];
  signal_strength: SignalLevel;
  post_count: number;
  purchase_linkage: PurchaseLinkage;
  why_linkage: string;
  product_categories: string[];
  threads_fit: number;
  threads_fit_reason: string;
  sample_post_ids: string[];
}

export async function detectNeeds(brief: ResearchBrief): Promise<DetectedNeed[]> {
  const systemPrompt = loadAgentPrompt('needs-detector');

  const userMessage = JSON.stringify({
    instruction: 'Analyze this research brief and extract needs. Return a JSON object with a "needs" array.',
    research_brief: brief,
    expected_output_schema: {
      needs: 'Array<{ category, problem, representative_expressions, signal_strength, post_count, purchase_linkage, why_linkage, product_categories, threads_fit, threads_fit_reason, sample_post_ids }>',
    },
  });

  const raw = await callLLM({
    model: 'claude-sonnet-4-6-20250715',
    systemPrompt,
    userMessage,
    maxTokens: 8192,
  });

  const rawParsed = parseJSON<Record<string, unknown>>(raw);

  // Handle different LLM response shapes: { needs: [...] }, { needs_map: [...] }, or direct array
  let needsArray: LLMNeedOutput[];
  if (Array.isArray(rawParsed)) {
    needsArray = rawParsed as unknown as LLMNeedOutput[];
  } else if (Array.isArray((rawParsed as any).needs)) {
    needsArray = (rawParsed as any).needs;
  } else if (Array.isArray((rawParsed as any).needs_map)) {
    needsArray = (rawParsed as any).needs_map;
  } else {
    // Try to find any array property
    const arrayProp = Object.values(rawParsed).find(v => Array.isArray(v));
    if (arrayProp) {
      needsArray = arrayProp as unknown as LLMNeedOutput[];
    } else {
      console.warn('[needs-detector] LLM returned unexpected shape:', Object.keys(rawParsed));
      needsArray = [];
    }
  }

  // Valid enum values for sanitization
  const validSignalLevels: SignalLevel[] = ['L1', 'L2', 'L3', 'L4', 'L5'];
  const validCategories: NeedsCategory[] = ['불편해소', '시간절약', '돈절약', '성과향상', '외모건강', '자기표현'];
  const validLinkages: PurchaseLinkage[] = ['상', '중', '하'];

  const detected: DetectedNeed[] = needsArray.map((n) => ({
    ...n,
    need_id: generateId('need'),
    // Sanitize LLM output: clamp to valid enum values
    signal_strength: validSignalLevels.includes(n.signal_strength) ? n.signal_strength : 'L1',
    category: validCategories.includes(n.category) ? n.category : '불편해소',
    purchase_linkage: validLinkages.includes(n.purchase_linkage) ? n.purchase_linkage : '하',
  }));

  for (const n of detected) {
    await db.insert(needs).values({
      need_id: n.need_id,
      category: n.category,
      problem: n.problem,
      representative_expressions: n.representative_expressions,
      signal_strength: n.signal_strength,
      post_count: n.post_count,
      purchase_linkage: n.purchase_linkage,
      why_linkage: n.why_linkage,
      product_categories: n.product_categories,
      threads_fit: n.threads_fit,
      threads_fit_reason: n.threads_fit_reason,
      sample_post_ids: n.sample_post_ids,
    });
  }

  return detected;
}
