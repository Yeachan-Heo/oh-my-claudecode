/**
 * @file agent-runner.ts — 에이전트 런타임 러너
 *
 * 에이전트를 독립 세션으로 스폰하고, 대화 내용을 자동으로 DB에 저장한다.
 *
 * Usage:
 *   import { runAgent } from './orchestrator/agent-runner.js';
 *   const result = await runAgent({ agentId: 'seoyeon-analyst', task: '오늘 성과 분석해' });
 */

import { sendMessage } from '../db/agent-messages.js';
import { processAgentOutput } from './agent-output-parser.js';
import { bootstrapAgent, completeTask } from './agent-session.js';
import { checkAgentHealth } from './self-healing.js';
import { AGENT_REGISTRY } from './agent-spawner.js';

import type { AgentBootstrap } from './agent-session.js';
import type { HealthCheck } from './self-healing.js';

// ─── Public Types ──────────────────────────────────────────────

export interface AgentRunConfig {
  agentId: string;
  task: string;              // 에이전트에게 보낼 메시지/임무
  taskId?: string;           // daily-YYYYMMDD 형식
  waitForResponse?: boolean; // 응답 대기 (현재 항상 true)
  timeoutMs?: number;        // 타임아웃 ms (기본 120000)
}

export interface AgentRunResult {
  agentId: string;
  output: string;
  savedToDb: boolean;        // DB 저장 성공 여부
  memoryCount: number;       // 저장된 기억 수
  healthCheck?: HealthCheck;
}

// ─── Main API ──────────────────────────────────────────────────

/**
 * 에이전트 스폰 → 임무 전달 → 응답 대기 → DB 저장 → 건강 체크.
 *
 * 1. bootstrapAgent()로 DB에서 기억/태스크/메시지 로드
 * 2. buildRunnerPrompt()로 프롬프트 구성
 * 3. spawnAndConverse()로 에이전트 실행 (출력 획득)
 * 4. saveConversationToDb()로 임무/응답 자동 저장
 * 5. processAgentOutput()으로 태그 파싱 → 기억/에피소드 DB 저장
 * 6. checkAgentHealth()로 건강 체크
 */
export async function runAgent(config: AgentRunConfig): Promise<AgentRunResult> {
  const { agentId, task, taskId, timeoutMs = 120000 } = config;

  const agent = AGENT_REGISTRY[agentId];
  if (!agent) throw new Error(`Unknown agent: ${agentId}`);

  // 1. 부트스트랩 — DB에서 기억/태스크/메시지 로드
  const bootstrap = await bootstrapAgent(agentId);

  // 2. 프롬프트 구성 — 기억 + 임무 + 태그 지시
  const fullPrompt = buildRunnerPrompt(agentId, bootstrap, task);

  // 3. 에이전트 실행 (출력 획득)
  //    현재는 프롬프트를 반환하여 호출자가 Agent() 도구로 실행하는 패턴.
  //    향후 agent-mux 독립 세션으로 전환 가능.
  const output = await spawnAndConverse(agentId, fullPrompt, timeoutMs);

  // 4. 대화 내용 DB 자동 저장
  let savedToDb = false;
  try {
    await saveConversationToDb(agentId, task, output, taskId);
    savedToDb = true;
  } catch {
    // DB 저장 실패해도 결과는 반환
    savedToDb = false;
  }

  // 5. output-parser로 태그 파싱 → 기억/에피소드 DB 저장
  const parseResult = await processAgentOutput(agentId, output).catch(() => ({
    status: 'ok' as const,
    savedCount: 0,
  }));

  // 6. 건강 체크
  const health = await checkAgentHealth(agentId).catch(() => undefined);

  return {
    agentId,
    output,
    savedToDb,
    memoryCount: parseResult.savedCount ?? 0,
    healthCheck: health,
  };
}

// ─── Internal: Spawn & Converse ────────────────────────────────

/**
 * 에이전트를 실행하고 출력을 반환하는 내부 함수.
 *
 * 현재 구현: 프롬프트를 그대로 반환 (호출자가 Agent() 도구로 실행).
 * 향후 agent-mux로 독립 세션 전환 시 이 함수만 교체하면 된다.
 *
 * @param agentId - 에이전트 ID
 * @param prompt  - 완성된 프롬프트
 * @param timeoutMs - 타임아웃 (향후 agent-mux에서 사용)
 */
async function spawnAndConverse(
  agentId: string,
  prompt: string,
  _timeoutMs: number,
): Promise<string> {
  // agent-mux 독립 세션 스폰을 위한 자리 (향후 구현).
  // 현재는 프롬프트를 출력으로 반환하여 호출자가 Agent() 도구로 처리.
  void agentId;
  return prompt;
}

// ─── Internal: DB 저장 ─────────────────────────────────────────

/**
 * 대화 내용을 agent_messages 테이블에 자동 저장.
 *
 * - 임무(task) → 'task_assign' 타입으로 저장 (orchestrator → agentId)
 * - 응답(output) → 'task_result' 타입으로 저장 (agentId → orchestrator)
 */
async function saveConversationToDb(
  agentId: string,
  task: string,
  output: string,
  taskId?: string,
): Promise<void> {
  const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const tid = taskId ?? `daily-${today}`;

  // 1. 임무 메시지 저장 (오케스트레이터 → 에이전트)
  await sendMessage(
    'orchestrator',
    agentId,
    'pipeline',
    task.slice(0, 500),   // 임무 요약 500자 제한
    undefined,
    'task_assign',
    tid,
  );

  // 2. 응답 메시지 저장 (에이전트 → 오케스트레이터)
  await sendMessage(
    agentId,
    'orchestrator',
    'pipeline',
    output.slice(0, 2000), // 응답 요약 2000자 제한
    undefined,
    'task_result',
    tid,
  );
}

// ─── Internal: Prompt Builder ──────────────────────────────────

/**
 * 에이전트 실행에 필요한 전체 프롬프트를 구성한다.
 *
 * 포함 항목:
 *   - 에이전트 정체성 (이름, 역할)
 *   - COMPANY.md / 에이전트 정의 파일 Read 지시
 *   - DB 기억 주입 (마크다운 포맷)
 *   - 활성 프롬프트
 *   - 미읽은 메시지
 *   - 임무
 *   - SAVE_MEMORY / LOG_EPISODE 태그 작성 지시 (필수)
 */
function buildRunnerPrompt(
  agentId: string,
  bootstrap: AgentBootstrap,
  task: string,
): string {
  const agent = AGENT_REGISTRY[agentId];
  const cwd = process.cwd();
  const lines: string[] = [];

  // 에이전트 정체성
  lines.push(`너는 BiniLab ${agent.name}이다.`);
  lines.push(`역할: ${agent.role}`);
  lines.push('');

  // 회사 가이드 읽기 지시
  lines.push('== BiniLab 회사 가이드 ==');
  lines.push(`Read ${cwd}/COMPANY.md`);
  lines.push('');

  // 에이전트 정의 읽기 지시
  lines.push('== 에이전트 정의 ==');
  lines.push(`Read ${cwd}/${agent.file}`);
  lines.push('');

  // DB 기억 주입 (md 파일이 아닌 DB에서 로드한 포맷된 문자열)
  if (bootstrap.memories) {
    lines.push('== 에이전트 기억 (DB) ==');
    lines.push(bootstrap.memories);
    lines.push('');
  }

  // 활성 프롬프트
  if (bootstrap.prompt) {
    lines.push('== 활성 프롬프트 ==');
    lines.push(bootstrap.prompt);
    lines.push('');
  }

  // 미읽은 메시지
  if (bootstrap.unreadMessages.length > 0) {
    lines.push('== 미읽은 메시지 ==');
    for (const m of bootstrap.unreadMessages) {
      lines.push(`[${m.sender}] ${m.message}`);
    }
    lines.push('');
  }

  // 임무
  lines.push('== 임무 ==');
  lines.push(task);
  lines.push('');

  // 태그 작성 지시 (필수)
  lines.push('== 기억/에피소드 태그 작성 (필수) ==');
  lines.push('작업 완료 후 응답에 반드시 아래 태그를 포함:');
  lines.push('[SAVE_MEMORY]');
  lines.push('scope: 적절한 스코프');
  lines.push('type: 적절한 타입');
  lines.push('importance: 0.0~1.0');
  lines.push('content: 이번 작업에서 배운 인사이트');
  lines.push('[/SAVE_MEMORY]');
  lines.push('');
  lines.push('[LOG_EPISODE]');
  lines.push('event_type: 적절한 이벤트 타입');
  lines.push('summary: 작업 결과 한 줄 요약');
  lines.push('details: {"key": "value"}');
  lines.push('[/LOG_EPISODE]');

  return lines.join('\n');
}

// completeTask re-export for convenience (callers who use agent-runner as entry point)
export { completeTask };
