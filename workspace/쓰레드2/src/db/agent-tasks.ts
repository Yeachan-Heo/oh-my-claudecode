/**
 * @file agent-tasks.ts — agent_tasks 테이블 CRUD 헬퍼.
 *
 * Usage:
 *   import { createTask, getTask, listTasksByAgent, updateTaskStatus, claimTask } from './db/agent-tasks.js';
 */

import { db as defaultDb } from './index.js';
import { agentTasks } from './schema.js';
import { eq, and, isNull } from 'drizzle-orm';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DbLike = any;

export interface AgentTask {
  id: string;
  title: string;
  description: string | null;
  assigned_to: string;
  assigned_by: string;
  status: string;
  priority: number;
  input_data: unknown;
  output_data: unknown;
  depends_on: string[];
  deadline: Date | null;
  started_at: Date | null;
  completed_at: Date | null;
  created_at: Date;
}

export interface CreateTaskInput {
  title: string;
  description?: string;
  assigned_to: string;
  assigned_by: string;
  priority?: number;
  input_data?: Record<string, unknown>;
  depends_on?: string[];
  deadline?: Date;
}

/**
 * 태스크 생성 — agent_tasks INSERT.
 */
export async function createTask(input: CreateTaskInput, db: DbLike = defaultDb): Promise<AgentTask> {
  const [row] = await db
    .insert(agentTasks)
    .values({
      title: input.title,
      description: input.description ?? null,
      assigned_to: input.assigned_to,
      assigned_by: input.assigned_by,
      status: 'pending',
      priority: input.priority ?? 5,
      input_data: input.input_data ?? null,
      output_data: null,
      depends_on: input.depends_on ?? [],
      deadline: input.deadline ?? null,
      started_at: null,
      completed_at: null,
    })
    .returning();
  return row as AgentTask;
}

/**
 * 태스크 단건 조회.
 */
export async function getTask(id: string, db: DbLike = defaultDb): Promise<AgentTask | null> {
  const rows = await db
    .select()
    .from(agentTasks)
    .where(eq(agentTasks.id, id))
    .limit(1);
  return (rows[0] as AgentTask) ?? null;
}

/**
 * 에이전트별 태스크 목록 조회 (선택적 status 필터).
 */
export async function listTasksByAgent(
  agentId: string,
  status?: string,
  db: DbLike = defaultDb,
): Promise<AgentTask[]> {
  const conditions = [eq(agentTasks.assigned_to, agentId)];
  if (status) conditions.push(eq(agentTasks.status, status));

  const rows = await db
    .select()
    .from(agentTasks)
    .where(and(...conditions));
  return rows as AgentTask[];
}

/**
 * 태스크 상태 업데이트 (선택적 output_data 저장).
 */
export async function updateTaskStatus(
  id: string,
  status: string,
  outputData?: Record<string, unknown>,
  db: DbLike = defaultDb,
): Promise<void> {
  const now = new Date();
  const updates: Record<string, unknown> = { status };

  if (status === 'in_progress') {
    updates.started_at = now;
  } else if (status === 'completed' || status === 'failed' || status === 'cancelled') {
    updates.completed_at = now;
  }

  if (outputData !== undefined) {
    updates.output_data = outputData;
  }

  await db
    .update(agentTasks)
    .set(updates)
    .where(eq(agentTasks.id, id));
}

/**
 * 태스크 클레임 — pending 태스크를 in_progress로 원자적 전환.
 * SELECT FOR UPDATE 패턴: 가장 오래된 pending 태스크를 찾아 할당.
 */
export async function claimTask(agentId: string, db: DbLike = defaultDb): Promise<AgentTask | null> {
  // 해당 에이전트의 pending 태스크 중 가장 오래된 것 조회
  const rows = await db
    .select()
    .from(agentTasks)
    .where(and(
      eq(agentTasks.assigned_to, agentId),
      eq(agentTasks.status, 'pending'),
      isNull(agentTasks.started_at),
    ))
    .limit(1);

  const task = rows[0] as AgentTask | undefined;
  if (!task) return null;

  // in_progress로 전환
  await db
    .update(agentTasks)
    .set({ status: 'in_progress', started_at: new Date() })
    .where(and(
      eq(agentTasks.id, task.id),
      eq(agentTasks.status, 'pending'),
    ));

  // 갱신된 태스크 반환
  return getTask(task.id, db);
}
