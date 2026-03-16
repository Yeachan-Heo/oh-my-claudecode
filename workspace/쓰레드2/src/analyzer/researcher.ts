import type {
  CanonicalPost,
  PurchaseSignal,
  KeywordEntry,
  TrendEntry,
} from '../types.js';
import { callLLM, loadAgentPrompt, parseJSON } from './llm.js';

export interface ResearchBrief {
  purchase_signals: PurchaseSignal[];
  purchase_signals_non_affiliate: PurchaseSignal[];
  top_keywords_consumer: KeywordEntry[];
  top_keywords_affiliate: KeywordEntry[];
  trends: TrendEntry[];
  meta: {
    total_posts_analyzed: number;
    consumer_posts: number;
    affiliate_posts: number;
    generated_at: string;
  };
}

export async function analyzeWithResearcher(posts: CanonicalPost[]): Promise<ResearchBrief> {
  const systemPrompt = loadAgentPrompt('researcher');

  const userMessage = JSON.stringify({
    instruction: 'Analyze these posts and produce a research brief in JSON format matching the ResearchBrief schema.',
    posts,
    expected_output_schema: {
      purchase_signals: 'PurchaseSignal[]',
      purchase_signals_non_affiliate: 'PurchaseSignal[]',
      top_keywords_consumer: 'KeywordEntry[]',
      top_keywords_affiliate: 'KeywordEntry[]',
      trends: 'TrendEntry[]',
      meta: '{ total_posts_analyzed, consumer_posts, affiliate_posts, generated_at }',
    },
  });

  const raw = await callLLM({
    model: 'claude-opus-4-20250514',
    systemPrompt,
    userMessage,
    maxTokens: 8192,
  });

  return parseJSON<ResearchBrief>(raw);
}
