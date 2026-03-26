/**
 * @file prompt-versions.ts — agent_prompt_versions 테이블 CRUD 헬퍼.
 *
 * Usage:
 *   import { createPromptVersion, getActivePrompt, activateVersion, evaluateVersion } from './db/prompt-versions.js';
 */

import { db as defaultDb } from './index.js';
import { agentPromptVersions } from './schema.js';
import { eq, and, desc } from 'drizzle-orm';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DbLike = any;

export interface CreatePromptVersionInput {
  agent_id: string;
  version: number;
  prompt_text: string;
  is_active?: boolean;
}

/**
 * 프롬프트 버전 생성 — agent_prompt_versions INSERT.
 */
export async function createPromptVersion(
  input: CreatePromptVersionInput,
  db: DbLike = defaultDb,
): Promise<void> {
  await db
    .insert(agentPromptVersions)
    .values({
      agent_id: input.agent_id,
      version: input.version,
      prompt_text: input.prompt_text,
      performance_score: null,
      eval_data: null,
      is_active: input.is_active ?? false,
    });
}

/**
 * 활성 프롬프트 텍스트 조회 — is_active=true인 최신 버전.
 * 없으면 null 반환.
 */
export async function getActivePrompt(agentId: string, db: DbLike = defaultDb): Promise<string | null> {
  const rows = await db
    .select({ prompt_text: agentPromptVersions.prompt_text })
    .from(agentPromptVersions)
    .where(and(
      eq(agentPromptVersions.agent_id, agentId),
      eq(agentPromptVersions.is_active, true),
    ))
    .orderBy(desc(agentPromptVersions.version))
    .limit(1);

  return (rows[0]?.prompt_text as string) ?? null;
}

/**
 * 버전 활성화 — 기존 is_active=false → 새 버전 is_active=true.
 * 트랜잭션 없이 순차 실행 (Drizzle 트랜잭션 지원 시 대체 가능).
 */
export async function activateVersion(
  agentId: string,
  version: number,
  db: DbLike = defaultDb,
): Promise<void> {
  // 기존 활성 버전 비활성화
  await db
    .update(agentPromptVersions)
    .set({ is_active: false })
    .where(and(
      eq(agentPromptVersions.agent_id, agentId),
      eq(agentPromptVersions.is_active, true),
    ));

  // 새 버전 활성화
  await db
    .update(agentPromptVersions)
    .set({ is_active: true })
    .where(and(
      eq(agentPromptVersions.agent_id, agentId),
      eq(agentPromptVersions.version, version),
    ));
}

/**
 * 버전 평가 결과 기록 — performance_score + eval_data 업데이트.
 */
export async function evaluateVersion(
  id: string,
  score: number,
  evalData: Record<string, unknown>,
  db: DbLike = defaultDb,
): Promise<void> {
  await db
    .update(agentPromptVersions)
    .set({
      performance_score: score,
      eval_data: evalData,
    })
    .where(eq(agentPromptVersions.id, id));
}
