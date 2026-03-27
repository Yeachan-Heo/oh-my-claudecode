/**
 * @file memory.ts — AI Company v2 메모리 헬퍼.
 *
 * 랭킹 공식: composite = recency(0.4) × max(0, 1 - age_days/30)
 *                      + importance(0.4) × importance
 *                      + scope_match(0.2) × scope_match
 *
 * Usage:
 *   import { loadAgentContext, saveMemory, logEpisode, formatMemoryForPrompt } from './db/memory.js';
 */

import { db as defaultDb } from './index.js';
import { agentMemories, agentEpisodes, strategyArchive, pendingApprovals } from './schema.js';
import { eq, desc, and } from 'drizzle-orm';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DbLike = any;

// ─── Types ───────────────────────────────────────────────

export interface SaveMemoryInput {
  agentId: string;
  scope: string;         // 'global' | 'marketing' | 'analysis' | 'private'
  memoryType: string;    // 'pattern' | 'insight' | 'rule' | 'fact'
  content: string;
  importance?: number;   // 0-1, default 0.5
  source?: string;
  expiresAt?: Date;
}

export interface LogEpisodeInput {
  agentId: string;
  eventType: string;     // 'decision' | 'experiment' | 'meeting' | 'post' | 'error' | 'pipeline_run'
  summary: string;
  details?: Record<string, unknown>;
}

export interface AgentContext {
  global: unknown[];
  department: unknown[];
  private: unknown[];
  episodes: unknown[];
  strategy: unknown | null;
  pendingDecisions: unknown[];
  pendingApprovals: unknown[];
}

// ─── Core helpers ────────────────────────────────────────

/**
 * 기억 저장 — agent_memories 테이블에 INSERT.
 */
export async function saveMemory(input: SaveMemoryInput, db: DbLike = defaultDb) {
  const [row] = await db
    .insert(agentMemories)
    .values({
      id: crypto.randomUUID(),
      agent_id: input.agentId,
      scope: input.scope,
      memory_type: input.memoryType,
      content: input.content,
      importance: input.importance ?? 0.5,
      source: input.source ?? null,
      expires_at: input.expiresAt ?? null,
    })
    .returning();
  return row;
}

/**
 * 에피소드 기록 — agent_episodes 테이블에 INSERT.
 */
export async function logEpisode(input: LogEpisodeInput, db: DbLike = defaultDb) {
  const [row] = await db
    .insert(agentEpisodes)
    .values({
      id: crypto.randomUUID(),
      agent_id: input.agentId,
      event_type: input.eventType,
      summary: input.summary,
      details: input.details ?? null,
    })
    .returning();
  return row;
}

// ─── Phase Memory ────────────────────────────────────────

/** Phase별 기본 importance 값. */
const PHASE_IMPORTANCE: Record<number, number> = {
  0: 0.3,
  1: 0.5,
  2: 0.7,
  3: 0.9,
  4: 0.6,
  5: 0.8,
};

/**
 * Phase 완료 후 자동 기억 저장.
 * claude-memory-mcp의 memory_store 패턴 차용:
 * - 자동 요약 (content 200자 제한)
 * - importance 스코어링 (Phase별 기본값)
 * - source 태깅 ("phase-{N}-auto")
 */
export async function savePhaseMemory(
  phase: number,
  summary: string,
  details: Record<string, unknown>,
  db: DbLike = defaultDb,
): Promise<void> {
  const detailsStr = JSON.stringify(details);
  const fullContent = `${summary} | ${detailsStr}`;
  const truncatedContent = fullContent.length > 200
    ? fullContent.slice(0, 197) + '...'
    : fullContent;

  await saveMemory({
    agentId: 'system-orchestrator',
    scope: 'global',
    memoryType: 'insight',
    content: truncatedContent,
    importance: PHASE_IMPORTANCE[phase] ?? 0.5,
    source: `phase-${phase}-auto`,
  }, db);
}

// ─── Sub-query helpers ────────────────────────────────────

/**
 * top-K 기억 조회 — 랭킹 공식 적용.
 * composite = recency×0.4 + importance×0.4 + scope_match×0.2
 */
async function getTopKMemories(
  scope: string,
  agentId: string | null,
  k: number,
  db: DbLike,
  options?: { memoryType?: string },
): Promise<unknown[]> {
  const conditions = [eq(agentMemories.scope, scope)];
  if (agentId) conditions.push(eq(agentMemories.agent_id, agentId));
  if (options?.memoryType) conditions.push(eq(agentMemories.memory_type, options.memoryType));

  const rows = await db
    .select()
    .from(agentMemories)
    .where(conditions.length === 1 ? conditions[0] : and(...conditions))
    .orderBy(desc(agentMemories.importance))
    .limit(k);

  // Apply ranking formula (sort in-memory after fetch)
  const now = Date.now();
  return rows
    .map((r: { importance: number; created_at: Date }) => {
      const ageDays = (now - new Date(r.created_at).getTime()) / (1000 * 60 * 60 * 24);
      const recency = Math.max(0, 1 - ageDays / 30);
      const composite = recency * 0.4 + r.importance * 0.4 + 0.2; // scope_match=1 since filtered
      return { ...r, _composite: composite };
    })
    .sort((a: { _composite: number }, b: { _composite: number }) => b._composite - a._composite)
    .slice(0, k);
}

/**
 * 최근 에피소드 조회 (agent_id 기준).
 */
async function getRecentEpisodes(agentId: string, limit: number, db: DbLike): Promise<unknown[]> {
  return db
    .select()
    .from(agentEpisodes)
    .where(eq(agentEpisodes.agent_id, agentId))
    .orderBy(desc(agentEpisodes.occurred_at))
    .limit(limit);
}

/**
 * 활성 전략 조회 (strategy_archive.status = 'active').
 */
async function getActiveStrategy(db: DbLike): Promise<unknown | null> {
  const rows = await db
    .select()
    .from(strategyArchive)
    .where(eq(strategyArchive.status, 'active'))
    .orderBy(desc(strategyArchive.created_at))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * 읽지 않은 결정 메시지 조회 (directive type, recipient = agentId).
 * agent_messages 의존을 피하기 위해 dynamic import 사용.
 */
async function getUnreadDecisions(agentId: string, db: DbLike): Promise<unknown[]> {
  // Import lazily to avoid circular dependency
  const { getUnreadMessages } = await import('./agent-messages.js');
  const all = await getUnreadMessages(agentId, db);
  return (all as Array<{ message_type?: string }>).filter(m => m.message_type === 'directive');
}

/**
 * 승인 대기 항목 조회 (pending_approvals.status = 'pending').
 */
async function getPendingApprovals(db: DbLike): Promise<unknown[]> {
  return db
    .select()
    .from(pendingApprovals)
    .where(eq(pendingApprovals.status, 'pending'))
    .orderBy(desc(pendingApprovals.created_at))
    .limit(10);
}

// ─── Main API ────────────────────────────────────────────

/**
 * 에이전트 컨텍스트 로드 — 7개 하위 쿼리, 각각 try-catch + 빈 배열 fallback.
 */
export async function loadAgentContext(
  agentId: string,
  department: string,
  db: DbLike = defaultDb,
): Promise<AgentContext> {
  const [global, dept, priv, episodes, strategy, pendingDecisions, pendingApprovalsResult] =
    await Promise.all([
      getTopKMemories('global', null, 10, db).catch(() => []),
      getTopKMemories(department, null, 10, db).catch(() => []),
      getTopKMemories('private', agentId, 10, db).catch(() => []),
      getRecentEpisodes(agentId, 3, db).catch(() => []),
      getActiveStrategy(db).catch(() => null),
      getUnreadDecisions(agentId, db).catch(() => []),
      getPendingApprovals(db).catch(() => []),
    ]);

  return {
    global,
    department: dept,
    private: priv,
    episodes,
    strategy,
    pendingDecisions,
    pendingApprovals: pendingApprovalsResult,
  };
}

// ─── Prompt Formatter ────────────────────────────────────

const TOKEN_CAP = 3000;
const CHARS_PER_TOKEN = 4; // conservative estimate
const CHAR_CAP = TOKEN_CAP * CHARS_PER_TOKEN;

function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars - 3) + '...';
}

/**
 * AgentContext → 프롬프트용 마크다운 문자열 변환.
 * 총 3000 토큰 이하로 truncate.
 */
export function formatMemoryForPrompt(ctx: AgentContext): string {
  const sections: string[] = [];

  // Global memories
  if (ctx.global.length > 0) {
    const lines = (ctx.global as Array<{ content: string; memory_type?: string }>)
      .map(m => `- [${m.memory_type ?? 'memory'}] ${m.content}`)
      .join('\n');
    sections.push(`## 공유 기억 (Global)\n${lines}`);
  }

  // Department memories
  if (ctx.department.length > 0) {
    const lines = (ctx.department as Array<{ content: string; memory_type?: string }>)
      .map(m => `- [${m.memory_type ?? 'memory'}] ${m.content}`)
      .join('\n');
    sections.push(`## 팀 기억 (Department)\n${lines}`);
  }

  // Private memories
  if (ctx.private.length > 0) {
    const lines = (ctx.private as Array<{ content: string; memory_type?: string }>)
      .map(m => `- [${m.memory_type ?? 'memory'}] ${m.content}`)
      .join('\n');
    sections.push(`## 개인 기억 (Private)\n${lines}`);
  }

  // Recent episodes
  if (ctx.episodes.length > 0) {
    const lines = (ctx.episodes as Array<{ summary: string; event_type?: string }>)
      .map(e => `- [${e.event_type ?? 'episode'}] ${e.summary}`)
      .join('\n');
    sections.push(`## 최근 에피소드\n${lines}`);
  }

  // Active strategy
  if (ctx.strategy) {
    const s = ctx.strategy as { version?: string; strategy?: unknown };
    sections.push(`## 현재 전략 (${s.version ?? 'active'})\n${JSON.stringify(s.strategy, null, 2)}`);
  }

  // Pending decisions
  if (ctx.pendingDecisions.length > 0) {
    const lines = (ctx.pendingDecisions as Array<{ message?: string }>)
      .map(d => `- ${d.message ?? String(d)}`)
      .join('\n');
    sections.push(`## 미결 지시사항\n${lines}`);
  }

  // Pending approvals
  if (ctx.pendingApprovals.length > 0) {
    const lines = (ctx.pendingApprovals as Array<{ description?: string; approval_type?: string }>)
      .map(a => `- [${a.approval_type ?? 'approval'}] ${a.description ?? ''}`)
      .join('\n');
    sections.push(`## 승인 대기\n${lines}`);
  }

  if (sections.length === 0) return '';

  const full = sections.join('\n\n');
  return truncate(full, CHAR_CAP);
}
