#!/usr/bin/env tsx
/**
 * researcher.ts — P1-1 리서처 에이전트
 *
 * canonical posts를 분석하여 research brief JSON을 생성.
 * 규칙 기반 분석 (키워드 빈도, 구매신호 패턴, 참여도) + LLM 프롬프트 생성.
 *
 * Usage:
 *   tsx scripts/researcher.ts                           # 전체 분석
 *   tsx scripts/researcher.ts --input data/canonical/posts.json
 *   tsx scripts/researcher.ts --prompt                   # LLM 프롬프트도 생성
 */

import fs from 'fs';
import path from 'path';
import type { CanonicalPost, PurchaseSignal, Metrics, SignalLevel, TrendEntry } from './types.js';

const CANONICAL_PATH = path.join(__dirname, '..', 'data', 'canonical', 'posts.json');
const TAXONOMY_PATH = path.join(__dirname, '..', 'data', 'taxonomy.json');
const BRIEFS_DIR = path.join(__dirname, '..', 'data', 'briefs');
const LEARNINGS_PATH = path.join(__dirname, '..', 'data', 'learnings', 'latest.json');

// --- Purchase signal patterns (L1-L5) ---
interface SignalPatternDef {
  desc: string;
  patterns: RegExp[];
}

const SIGNAL_PATTERNS: Record<string, SignalPatternDef> = {
  L5: {
    desc: '후기탐색',
    patterns: [/후기\s*(있|알려|보여)/, /실사용\s*(어때|후기)/, /써\s*본\s*사람/, /사용\s*후기/, /리뷰\s*(좀|부탁)/],
  },
  L4: {
    desc: '구매의사',
    patterns: [/살까/, /지를까/, /지르고\s*싶/, /구매\s*(할까|하려|해야)/, /결제\s*(할까|하려)/, /장바구니/],
  },
  L3: {
    desc: '비교',
    patterns: [/vs/, /뭐가\s*나아/, /가성비/, /비교/, /어떤\s*게\s*(좋|나아|괜찮)/, /고민\s*(중|됨|된다)/],
  },
  L2: {
    desc: '탐색',
    patterns: [/어디서\s*(사|팔)/, /(제품|상품|물건).*추천/, /뭐\s*사야/, /뭐가\s*좋아/, /괜찮은\s*(제품|상품|거\s*추천)/],
  },
  L1: {
    desc: '관심',
    patterns: [/좋아\s*보인/, /탐난/, /갖고\s*싶/, /예쁘다/, /신기하/, /궁금/],
  },
};

// --- Korean morpheme-based keyword extraction (simple) ---
const STOP_WORDS = new Set([
  '이', '가', '은', '는', '을', '를', '에', '의', '로', '으로', '와', '과', '도', '만',
  '에서', '까지', '부터', '한테', '처럼', '보다', '라고', '하고', '이랑', '같이',
  '그', '저', '이런', '저런', '그런', '이거', '저거', '그거', '뭐', '어떤',
  '하다', '있다', '없다', '되다', '않다', '못하다', '이다', '아니다',
  '너무', '정말', '진짜', '약간', '좀', '많이', '아주', '매우', '되게',
  '그래서', '그런데', '그리고', '하지만', '근데', '그래', '네', '아',
  '합니다', '합니당', '했어요', '했다', '해요', '하는', '하면', '해서',
  '있어', '없어', '했는데', '이미', '제일', '나는', '내가',
  '인증된', '계정', '활동의', '일환으로', '수수료를', '제공받습니다',
  // 광고 보일러플레이트
  '포스팅은', '활동으로', '일정액의', '제공받습니다', '수수료를',
  '제품번호', '제품정보는', '남겨주시면', '보내드릴께요', '연결됩니다', '누르면',
  // 채널명/프로젝트명 노이즈
  '스하리', '명프로젝트', '프로젝트', '부부', '다들', '이렇게', '있는',
  'ㅋㅋ', 'ㅎㅎ', 'ㅠㅠ', 'ㅜㅜ',
]);
const URL_STOP = new Set([
  'com', 'www', 'http', 'https', 'link', 'net', 'org', 'coupang', 'coupa',
  'instagram', 'threads', 'naver', 'blog', 'smartstore',
  'open', 'kakao', 'kakaocdn', 'cdninstagram', 'scontent',
  // URL 해시/짧은 ID 조각
  'gkj', 'bit', 'ly', 'tinyurl', 'url',
]);

interface KeywordResult {
  keyword: string;
  count: number;
  post_ids: string[];
}

function extractKeywords(posts: CanonicalPost[]): KeywordResult[] {
  const freq: Record<string, number> = {};
  const postIndex: Record<string, string[]> = {};

  for (const post of posts) {
    const text = (post.text || '').toLowerCase();
    const tokens = text.match(/[가-힣]{2,}|[a-z]{3,}/g) || [];
    const seen = new Set<string>();

    for (const token of tokens) {
      if (STOP_WORDS.has(token) || URL_STOP.has(token) || token.length < 2) continue;
      if (!seen.has(token)) {
        seen.add(token);
        freq[token] = (freq[token] || 0) + 1;
        postIndex[token] = postIndex[token] || [];
        postIndex[token].push(post.post_id);
      }
    }
  }

  return Object.entries(freq)
    .filter(([, count]) => count >= 3)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 50)
    .map(([keyword, count]) => ({
      keyword,
      count,
      post_ids: postIndex[keyword].slice(0, 5),
    }));
}

function extractKeywordsConsumer(posts: CanonicalPost[]): KeywordResult[] {
  const nonAffiliate = posts.filter(p => p.tags?.primary !== 'affiliate');
  return extractKeywords(nonAffiliate);
}

// --- Purchase signal detection ---
interface DetectedSignal {
  post_id: string;
  channel_id: string;
  text: string;
  signal_level: SignalLevel;
  matched_pattern: string | undefined;
  metrics: Metrics | undefined;
}

function detectPurchaseSignals(posts: CanonicalPost[]): DetectedSignal[] {
  const signals: DetectedSignal[] = [];

  for (const post of posts) {
    const text = post.text || '';
    let bestLevel: string | null = null;
    let bestMatch: string | undefined;

    for (const [level, { patterns }] of Object.entries(SIGNAL_PATTERNS)) {
      for (const pattern of patterns) {
        if (pattern.test(text)) {
          bestLevel = level;
          bestMatch = text.match(pattern)?.[0];
          break;
        }
      }
      if (bestLevel) break;
    }

    if (bestLevel) {
      signals.push({
        post_id: post.post_id,
        channel_id: post.channel_id,
        text: text.slice(0, 200),
        signal_level: bestLevel as SignalLevel,
        matched_pattern: bestMatch,
        metrics: post.metrics,
      });
    }
  }

  const levelOrder: Record<string, number> = { L5: 0, L4: 1, L3: 2, L2: 3, L1: 4 };
  return signals.sort((a, b) => levelOrder[a.signal_level] - levelOrder[b.signal_level]);
}

// --- Engagement analysis ---
interface EngagementSummary {
  posts_total: number;
  views: { avg: number; median: number; max: number };
  likes: { avg: number; median: number; max: number };
  replies: { avg: number; median: number; max: number };
}

function analyzeEngagement(posts: CanonicalPost[]): EngagementSummary {
  const views = posts.map(p => p.metrics?.view_count || 0).filter(v => v > 0);
  const likes = posts.map(p => p.metrics?.like_count || 0);
  const replies = posts.map(p => p.metrics?.reply_count || 0);

  const avg = (arr: number[]) => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
  const median = (arr: number[]) => {
    if (!arr.length) return 0;
    const sorted = [...arr].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  };

  return {
    posts_total: posts.length,
    views: { avg: Math.round(avg(views)), median: median(views), max: Math.max(...views, 0) },
    likes: { avg: +avg(likes).toFixed(1), median: median(likes), max: Math.max(...likes, 0) },
    replies: { avg: +avg(replies).toFixed(1), median: median(replies), max: Math.max(...replies, 0) },
  };
}

// --- Channel breakdown ---
interface ChannelInfo {
  channel_id: string;
  post_count: number;
  category: string;
  follower_count: number;
  affiliate_count: number;
  avg_views: number;
}

function analyzeChannels(posts: CanonicalPost[]): ChannelInfo[] {
  const byChannel: Record<string, CanonicalPost[]> = {};
  for (const p of posts) {
    byChannel[p.channel_id] = byChannel[p.channel_id] || [];
    byChannel[p.channel_id].push(p);
  }

  return Object.entries(byChannel)
    .map(([ch, chPosts]) => ({
      channel_id: ch,
      post_count: chPosts.length,
      category: chPosts[0]?.channel_meta?.category || '기타',
      follower_count: chPosts[0]?.channel_meta?.follower_count || 0,
      affiliate_count: chPosts.filter(p => p.tags?.primary === 'affiliate').length,
      avg_views: Math.round(
        chPosts.reduce((s, p) => s + (p.metrics?.view_count || 0), 0) / chPosts.length
      ),
    }))
    .sort((a, b) => b.post_count - a.post_count);
}

// --- Emerging topic detection ---
function detectTrends(posts: CanonicalPost[]): { emerging: TrendEntry[]; declining: TrendEntry[] } {
  const sorted = [...posts].sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
  const mid = Math.floor(sorted.length / 2);
  const recent = sorted.slice(0, mid);
  const older = sorted.slice(mid);

  const countKeywords = (arr: CanonicalPost[]): Record<string, { count: number; post_ids: string[] }> => {
    const freq: Record<string, { count: number; post_ids: string[] }> = {};
    for (const p of arr) {
      const tokens = (p.text || '').match(/[가-힣]{2,}/g) || [];
      const seen = new Set<string>();
      for (const t of tokens) {
        if (!STOP_WORDS.has(t) && !seen.has(t)) {
          seen.add(t);
          if (!freq[t]) freq[t] = { count: 0, post_ids: [] };
          freq[t].count++;
          if (freq[t].post_ids.length < 5) freq[t].post_ids.push(p.post_id);
        }
      }
    }
    return freq;
  };

  const recentFreq = countKeywords(recent);
  const olderFreq = countKeywords(older);

  const emerging: TrendEntry[] = [];
  const declining: TrendEntry[] = [];

  for (const [kw, entry] of Object.entries(recentFreq)) {
    if (entry.count < 2) continue;
    const oldEntry = olderFreq[kw];
    const oldCount = oldEntry?.count || 0;
    if (oldCount === 0 && entry.count >= 3) {
      emerging.push({ keyword: kw, recent_count: entry.count, old_count: 0, trend: 'new', sample_post_ids: entry.post_ids });
    } else if (entry.count > oldCount * 2 && entry.count >= 3) {
      emerging.push({ keyword: kw, recent_count: entry.count, old_count: oldCount, trend: 'rising', sample_post_ids: entry.post_ids });
    }
  }

  for (const [kw, entry] of Object.entries(olderFreq)) {
    if (entry.count < 3) continue;
    const recentEntry = recentFreq[kw];
    const recentCount = recentEntry?.count || 0;
    if (recentCount < entry.count * 0.3) {
      declining.push({ keyword: kw, recent_count: recentCount, old_count: entry.count, trend: 'declining', sample_post_ids: entry.post_ids });
    }
  }

  return {
    emerging: emerging.sort((a, b) => b.recent_count - a.recent_count).slice(0, 10),
    declining: declining.sort((a, b) => b.old_count - a.recent_count).slice(0, 10),
  };
}

// --- Generate LLM prompt for deeper analysis ---
interface RuleBasedBrief {
  top_keywords: Array<{ keyword: string; count: number }>;
  purchase_signals: unknown[];
}

function generateLLMPrompt(posts: CanonicalPost[], ruleBasedBrief: RuleBasedBrief): string {
  const summaries = posts.slice(0, 100).map(p => ({
    id: p.post_id,
    ch: p.channel_id,
    text: (p.text || '').slice(0, 300),
    views: p.metrics?.view_count,
    likes: p.metrics?.like_count,
    replies: p.metrics?.reply_count,
    type: p.thread_type,
    link: p.link?.domain || null,
    reply_text: p.comments?.[0]?.text?.slice(0, 100) || null,
  }));

  return `당신은 Threads 소비자 리서치 전문가입니다. 아래 ${summaries.length}개 포스트를 분석하여 JSON으로 응답하세요.

## 분석 데이터
${JSON.stringify(summaries, null, 0)}

## 규칙 기반 사전 분석 (참고용)
- 상위 키워드: ${ruleBasedBrief.top_keywords.slice(0, 10).map(k => k.keyword + '(' + k.count + ')').join(', ')}
- 구매신호 감지: ${ruleBasedBrief.purchase_signals.length}건

## 요구 출력 (JSON)
{
  "top_keywords": [{"keyword": "...", "count": N, "signal_level": "L1-L5|null", "trend": "rising|steady|declining"}],
  "purchase_signals": [{"text": "원문 발췌", "post_id": "...", "signal_level": "L1-L5", "category_hint": "문제 카테고리"}],
  "question_posts": [{"post_id": "...", "question": "질문 요약", "topic": "주제"}],
  "emotional_posts": [{"post_id": "...", "emotion": "강한불만|강한만족|강한궁금", "text_excerpt": "..."}],
  "emerging_topics": [{"topic": "...", "evidence_count": N, "why_emerging": "이유"}],
  "declining_topics": [{"topic": "...", "why_declining": "이유"}],
  "meta_insights": "전체적인 인사이트 요약 (3-5문장)"
}

## 규칙
- 모든 주장에 post_id 근거 필수 (citation)
- 구매신호 레벨: L1(관심) < L2(탐색) < L3(비교) < L4(구매의사) < L5(후기탐색)
- category_hint: 불편해소|시간절약|돈절약|성과향상|외모건강|자기표현
- 최대 1000 토큰으로 응답`;
}

// --- Citation rate + evidence measurement (P1 task 3) ---
interface CitationMetrics {
  total_claims: number;
  cited_claims: number;
  citation_rate: number;
  avg_evidence_per_claim: number;
  target_met: { citation_rate: boolean; evidence: boolean };
}

function measureCitations(
  keywords: KeywordResult[],
  signals: DetectedSignal[],
  nonAffSignals: DetectedSignal[],
  trends: { emerging: TrendEntry[]; declining: TrendEntry[] },
): CitationMetrics {
  let totalClaims = 0;
  let citedClaims = 0;
  let totalEvidence = 0;

  // Keywords: each is a claim with sample_post_ids
  for (const k of keywords) {
    totalClaims++;
    if (k.post_ids.length > 0) { citedClaims++; totalEvidence += k.post_ids.length; }
  }
  // Purchase signals: each is a claim with 1 post_id
  for (const s of signals) {
    totalClaims++;
    citedClaims++; // always has post_id
    totalEvidence += 1;
  }
  // Non-affiliate signals
  for (const s of nonAffSignals) {
    totalClaims++;
    citedClaims++;
    totalEvidence += 1;
  }
  // Emerging topics
  for (const t of trends.emerging) {
    totalClaims++;
    if (t.sample_post_ids && t.sample_post_ids.length > 0) {
      citedClaims++;
      totalEvidence += t.sample_post_ids.length;
    }
  }
  // Declining topics
  for (const t of trends.declining) {
    totalClaims++;
    if (t.sample_post_ids && t.sample_post_ids.length > 0) {
      citedClaims++;
      totalEvidence += t.sample_post_ids.length;
    }
  }

  const citationRate = totalClaims > 0 ? +(citedClaims / totalClaims).toFixed(4) : 0;
  const avgEvidence = citedClaims > 0 ? +(totalEvidence / citedClaims).toFixed(1) : 0;

  return {
    total_claims: totalClaims,
    cited_claims: citedClaims,
    citation_rate: citationRate,
    avg_evidence_per_claim: avgEvidence,
    target_met: {
      citation_rate: citationRate >= 0.8,
      evidence: avgEvidence >= 2,
    },
  };
}

// --- Main ---
function main(): void {
  const args = process.argv.slice(2);
  const inputPath = args.includes('--input') ? args[args.indexOf('--input') + 1] : CANONICAL_PATH;
  const generatePrompt = args.includes('--prompt');

  // Load data
  const data = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
  const posts: CanonicalPost[] = data.posts;
  console.log(`Analyzing ${posts.length} posts...`);

  // Load previous learnings if available
  let learnings: unknown = null;
  try {
    learnings = JSON.parse(fs.readFileSync(LEARNINGS_PATH, 'utf8'));
    console.log(`  Loaded previous learnings`);
  } catch {
    console.log(`  No previous learnings found`);
  }

  // Run analyses
  const keywords = extractKeywords(posts);
  const signals = detectPurchaseSignals(posts);
  const engagement = analyzeEngagement(posts);
  const channels = analyzeChannels(posts);
  const trends = detectTrends(posts);

  // Non-affiliate posts for deeper signal analysis
  const nonAffiliate = posts.filter(p => p.tags?.primary !== 'affiliate');
  const nonAffSignals = detectPurchaseSignals(nonAffiliate);
  const consumerKeywords = extractKeywordsConsumer(posts);

  const today = new Date().toISOString().slice(0, 10);

  // Build research brief
  const brief = {
    date: today,
    posts_analyzed: posts.length,
    top_keywords: keywords.map(k => ({
      keyword: k.keyword,
      count: k.count,
      signal_level: null as string | null,
      trend: null as string | null,
      sample_post_ids: k.post_ids,
    })),
    top_keywords_consumer: consumerKeywords.map(k => ({
      keyword: k.keyword,
      count: k.count,
      sample_post_ids: k.post_ids,
    })),
    purchase_signals: signals.map(s => ({
      text: s.text,
      post_id: s.post_id,
      channel_id: s.channel_id,
      signal_level: s.signal_level,
      category_hint: null as string | null,
      engagement: s.metrics,
    })),
    purchase_signals_non_affiliate: nonAffSignals.map(s => ({
      text: s.text,
      post_id: s.post_id,
      signal_level: s.signal_level,
    })),
    question_posts: [] as unknown[],
    emotional_posts: [] as unknown[],
    emerging_topics: trends.emerging,
    declining_topics: trends.declining,
    engagement_summary: engagement,
    channel_breakdown: channels,
    meta: {
      taxonomy_version: data.meta.taxonomy_version as string,
      schema_version: data.meta.schema_version as string,
      analysis_type: 'rule-based',
      generated_at: new Date().toISOString(),
      previous_learnings: !!learnings,
    },
    citation_metrics: measureCitations(keywords, signals, nonAffSignals, trends),
  };

  // Write brief
  if (!fs.existsSync(BRIEFS_DIR)) fs.mkdirSync(BRIEFS_DIR, { recursive: true });
  const outPath = path.join(BRIEFS_DIR, `${today}_research.json`);
  const tmpPath = outPath + '.tmp';
  fs.writeFileSync(tmpPath, JSON.stringify(brief, null, 2), 'utf8');
  fs.renameSync(tmpPath, outPath);

  // Generate LLM prompt if requested
  if (generatePrompt) {
    const prompt = generateLLMPrompt(posts, brief);
    const promptPath = path.join(BRIEFS_DIR, `${today}_researcher_prompt.txt`);
    fs.writeFileSync(promptPath, prompt, 'utf8');
    console.log(`  LLM prompt: ${promptPath}`);
  }

  // Print summary
  console.log(`\nResearch brief: ${outPath}`);
  console.log(`\n--- Summary ---`);
  console.log(`Posts: ${posts.length} (affiliate: ${posts.length - nonAffiliate.length}, non-affiliate: ${nonAffiliate.length})`);
  console.log(`Top keywords: ${keywords.slice(0, 10).map(k => `${k.keyword}(${k.count})`).join(', ')}`);
  console.log(`Purchase signals: ${signals.length} total (${nonAffSignals.length} non-affiliate)`);

  const byLevel: Record<string, number> = {};
  for (const s of signals) byLevel[s.signal_level] = (byLevel[s.signal_level] || 0) + 1;
  console.log(`  By level: ${Object.entries(byLevel).map(([l, c]) => `${l}:${c}`).join(', ')}`);

  console.log(`Emerging: ${trends.emerging.slice(0, 5).map(t => t.keyword).join(', ') || 'none'}`);
  console.log(`Declining: ${trends.declining.slice(0, 5).map(t => t.keyword).join(', ') || 'none'}`);
  console.log(`Engagement: avg views=${engagement.views.avg}, avg likes=${engagement.likes.avg}`);

  // Citation metrics
  const cm = brief.citation_metrics;
  console.log(`\n--- Citation Metrics ---`);
  console.log(`  Claims: ${cm.cited_claims}/${cm.total_claims} cited (${(cm.citation_rate * 100).toFixed(1)}%)`);
  console.log(`  Avg evidence/claim: ${cm.avg_evidence_per_claim}`);
  console.log(`  Target met: citation_rate≥80%=${cm.target_met.citation_rate}, evidence≥2=${cm.target_met.evidence}`);
}

main();
