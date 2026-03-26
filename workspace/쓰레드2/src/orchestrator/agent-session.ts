/**
 * @file agent-session.ts — 에이전트 세션 부트스트랩 프로토콜
 *
 * 에이전트가 독립 세션에서 시작할 때 DB에서 전체 컨텍스트를 로드한다.
 *
 * Usage:
 *   import { bootstrapAgent, pollNextTask, completeTask } from './orchestrator/agent-session.js';
 */

import { getActivePrompt } from '../db/prompt-versions.js';
import { loadAgentContext, formatMemoryForPrompt, logEpisode } from '../db/memory.js';
import { listTasksByAgent, claimTask, updateTaskStatus } from '../db/agent-tasks.js';
import { getUnreadMessages } from '../db/agent-messages.js';
import { getState } from '../db/system-state.js';
import { AGENT_REGISTRY } from './agent-spawner.js';

export type { AgentTask } from '../db/agent-tasks.js';

// Re-export type for convenience
type AgentTask = import('../db/agent-tasks.js').AgentTask;

// ─── Return type for getUnreadMessages ───────────────────

type AgentMessage = Awaited<ReturnType<typeof getUnreadMessages>>[number];

// ─── Bootstrap Interface ─────────────────────────────────

export interface AgentBootstrap {
  agentId: string;
  prompt: string | null;         // 활성 프롬프트
  memories: string;              // 포맷된 기억 (마크다운)
  pendingTasks: AgentTask[];     // 대기 중 업무
  unreadMessages: AgentMessage[];// 미읽은 메시지
  systemUpdates: string[];       // 시스템 변경 알림
}

// ─── Bootstrap ───────────────────────────────────────────

/**
 * 에이전트 세션 부트스트랩 — DB에서 모든 컨텍스트 로드.
 *
 * 각 DB 호출은 독립적으로 try-catch 처리 — 하나 실패해도 나머지는 동작.
 */
export async function bootstrapAgent(agentId: string): Promise<AgentBootstrap> {
  const systemUpdates: string[] = [];

  // department 조회 — registry에 없으면 'general' fallback
  const agentDef = AGENT_REGISTRY[agentId];
  const department = agentDef?.department ?? 'general';

  // 1. system_state 체크 — guides_version 변경 감지
  let guidesVersion: string | null = null;
  try {
    guidesVersion = await getState('guides_version');
    if (guidesVersion) {
      systemUpdates.push(`guides_version 업데이트: ${guidesVersion}`);
    }
  } catch {
    // system_state 접근 실패 시 무시
  }

  // 2~5: 병렬 로드
  const [prompt, memCtx, pendingTasks, unreadMessages] = await Promise.all([
    // 2. 활성 프롬프트 로드
    getActivePrompt(agentId).catch(() => null),

    // 3. 기억 로드
    loadAgentContext(agentId, department).catch(() => ({
      global: [],
      department: [],
      private: [],
      episodes: [],
      strategy: null,
      pendingDecisions: [],
      pendingApprovals: [],
    })),

    // 4. 대기 업무
    listTasksByAgent(agentId, 'pending').catch(() => [] as AgentTask[]),

    // 5. 미읽은 메시지
    getUnreadMessages(agentId).catch(() => [] as AgentMessage[]),
  ]);

  // 기억 포맷
  const memories = formatMemoryForPrompt(memCtx);

  return {
    agentId,
    prompt,
    memories,
    pendingTasks,
    unreadMessages,
    systemUpdates,
  };
}

// ─── Task Poll ───────────────────────────────────────────

/**
 * 에이전트 task poll 루프 — 다음 pending task를 가져와 in_progress로 전환.
 * 없으면 null 반환.
 */
export async function pollNextTask(agentId: string): Promise<AgentTask | null> {
  return claimTask(agentId);
}

// ─── Task Complete ───────────────────────────────────────

/**
 * task 완료 보고 — status 업데이트 + output_data 저장 + episode 기록.
 */
export async function completeTask(
  taskId: string,
  outputData: Record<string, unknown>,
  learnings?: string,
): Promise<void> {
  // status → completed + output_data 저장
  await updateTaskStatus(taskId, 'completed', outputData);

  // episode 기록 (learnings 있을 때만)
  if (learnings) {
    // task의 assigned_to를 알기 위해 output_data에서 agentId 추출 시도
    // 호출자가 agentId를 outputData.agentId로 전달하는 컨벤션 지원
    const agentId = (outputData.agentId as string | undefined) ?? 'unknown';
    await logEpisode({
      agentId,
      eventType: 'decision',
      summary: `Task ${taskId} 완료`,
      details: { taskId, outputData, learnings },
    }).catch(() => {
      // episode 기록 실패 시 태스크 완료 자체는 성공으로 처리
    });
  }
}
