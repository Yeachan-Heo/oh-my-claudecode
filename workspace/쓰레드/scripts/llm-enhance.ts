/**
 * llm-enhance.ts — LLM output validation utilities
 *
 * Validates LLM-generated JSON outputs against expected schemas.
 * Used by run-pipeline to load *_llm.json overlay files.
 */

import { clamp } from './product-matcher.js';

export interface LLMProductOutput {
  improved_matches: Array<{
    need_id: string;
    recommended_products: Array<{
      product_id: string;
      adjusted_scores: {
        naturalness: number;
        clarity: number;
        ad_smell: number;
        repeatability: number;
        story_potential: number;
      };
      content_angle: string;
      why_threads_fit: string;
    }>;
  }>;
  overall_strategy: string;
}

export interface LLMPositioningOutput {
  positioning_cards: Array<{
    product_id: string;
    product_name: string;
    need_id: string;
    positions: Array<{
      format: string;
      angle: string;
      tone: string;
      hook: string;
      avoid: string[];
      cta_style: string;
    }>;
  }>;
}

export function validateLLMProductOutput(data: unknown): LLMProductOutput {
  if (!data || typeof data !== 'object') throw new Error('LLM output: expected object');
  const d = data as Record<string, unknown>;
  if (!Array.isArray(d.improved_matches)) throw new Error('LLM output: missing improved_matches array');

  // Clamp all scores to 1-5
  for (const match of d.improved_matches as Array<Record<string, unknown>>) {
    const prods = match.recommended_products as Array<Record<string, unknown>> | undefined;
    if (!Array.isArray(prods)) continue;
    for (const prod of prods) {
      const scores = prod.adjusted_scores as Record<string, number> | undefined;
      if (scores) {
        for (const key of ['naturalness', 'clarity', 'ad_smell', 'repeatability', 'story_potential']) {
          if (typeof scores[key] === 'number') {
            scores[key] = clamp(scores[key], 1, 5);
          }
        }
      }
    }
  }

  return data as LLMProductOutput;
}

export function validateLLMPositioningOutput(data: unknown): LLMPositioningOutput {
  if (!data || typeof data !== 'object') throw new Error('LLM positioning: expected object');
  const d = data as Record<string, unknown>;
  if (!Array.isArray(d.positioning_cards)) throw new Error('LLM positioning: missing positioning_cards array');
  return data as LLMPositioningOutput;
}
