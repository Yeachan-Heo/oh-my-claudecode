import { db } from '../db/index.js';
import { sql } from 'drizzle-orm';

export interface RecycleCandidate {
  id: string;
  content_text: string;
  need_category: string;
  hook_type: string;
  post_views: number;
}

export async function getCandidates(limit = 5): Promise<RecycleCandidate[]> {
  const rows = await db.execute(sql`
    SELECT cl.id, cl.content_text, cl.need_category, cl.hook_type, ps.post_views
    FROM content_lifecycle cl
    JOIN LATERAL (
      SELECT post_views FROM post_snapshots WHERE post_id = cl.id ORDER BY snapshot_at DESC LIMIT 1
    ) ps ON true
    WHERE cl.posted_account_id = 'duribeon231'
      AND cl.posted_at < NOW() - INTERVAL '14 days'
      AND ps.post_views IS NOT NULL
    ORDER BY ps.post_views DESC
    LIMIT ${limit}
  `);
  return rows as unknown as RecycleCandidate[];
}

export interface VariationTemplate {
  original_id: string;
  topic: string;
  key_facts: string[];
  suggested_angle: string;
  suggested_hook_candidates: string[];
  suggested_pattern: string;
}

export function generateVariationTemplate(candidate: RecycleCandidate): VariationTemplate {
  // Extract topic from first line or first 50 chars
  const lines = candidate.content_text.split('\n').filter(l => l.trim());
  const topic = lines[0]?.slice(0, 50) || 'unknown';

  // Extract key facts (lines with numbers or specific info)
  const facts = lines.filter(l => /\d|원|개|%|ml|g/.test(l)).slice(0, 3);

  return {
    original_id: candidate.id,
    topic,
    key_facts: facts.length > 0 ? facts : [lines[0] || ''],
    suggested_angle: '(Claude Code가 JTBD 기반으로 새 앵글 제안)',
    suggested_hook_candidates: [
      '(훅 후보 1 — 반전형)',
      '(훅 후보 2 — 질문형)',
      '(훅 후보 3 — 숫자형)',
    ],
    suggested_pattern: candidate.hook_type === 'empathy' ? 'B(솔직후기)' : 'D(반전)',
  };
}

export function checkSimilarity(
  text1: string,
  text2: string
): { similar: boolean; score: number; message: string } {
  const getBigrams = (text: string): Set<string> => {
    const clean = text.replace(/\s+/g, ' ').trim().toLowerCase();
    const bigrams = new Set<string>();
    for (let i = 0; i < clean.length - 1; i++) {
      bigrams.add(clean.slice(i, i + 2));
    }
    return bigrams;
  };

  const a = getBigrams(text1);
  const b = getBigrams(text2);

  let intersection = 0;
  for (const gram of a) {
    if (b.has(gram)) intersection++;
  }

  const union = a.size + b.size - intersection;
  const score = union > 0 ? intersection / union : 0;
  const similar = score >= 0.7;

  return {
    similar,
    score: Math.round(score * 100) / 100,
    message: similar ? '너무 유사 — 앵글 변경 필요' : '충분히 다름 — 통과',
  };
}
