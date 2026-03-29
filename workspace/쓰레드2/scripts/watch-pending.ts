#!/usr/bin/env npx tsx
/**
 * BiniLab PENDING_RESPONSE Watcher v2
 *
 * DB를 5초마다 polling하여 PENDING_RESPONSE 마커를 감지하고,
 * tmux의 에이전트 세션에 프롬프트를 전달한다.
 *
 * v2 변경: 에이전트가 _respond.ts로 직접 DB에 응답을 저장한다.
 * watcher는 프롬프트 전달 후 즉시 마커를 processed로 마킹.
 * (log parsing 제거 — ANSI escape 코드 파싱 불안정 해소)
 *
 * 사용법:
 *   npx tsx scripts/watch-pending.ts
 *   npm run watch:pending
 *
 * 전제:
 *   - tmux 세션 'binilab'이 실행 중 (agent-mux create_project)
 *   - 에이전트가 스폰되어 있음 (agent-mux spawn_agent)
 */
import 'dotenv/config';
import { execSync } from 'child_process';
import { writeFileSync, mkdirSync, renameSync } from 'fs';
import { db } from '../src/db/index.js';
import { agentMessages } from '../src/db/schema.js';
import { eq, and, like } from 'drizzle-orm';
import { AGENT_REGISTRY } from '../src/orchestrator/agent-spawner.js';
import { processOneResponse, markAsProcessed } from '../src/orchestrator/response-processor.js';
import type { PendingResponse } from '../src/orchestrator/response-processor.js';

const POLL_INTERVAL = 5_000; // 5초
const TMUX_SESSION = 'binilab';
const PROJECT_ROOT = process.cwd();
const PROMPT_DIR = `/tmp/binilab-prompts`;

// ─── tmux helpers ────────────────────────────────────────

function resolveWindowName(agentId: string): string | null {
  try {
    const out = execSync(
      `tmux list-windows -t ${TMUX_SESSION} -F "#{window_name}" 2>/dev/null`,
      { encoding: 'utf-8' },
    );
    const windows = out.trim().split('\n');
    return windows.find(w => w === agentId)
      ?? windows.find(w => agentId.includes(w) || w.includes(agentId.split('-')[0]))
      ?? null;
  } catch { return null; }
}

function isAgentAlive(name: string): boolean {
  return resolveWindowName(name) !== null;
}

function sendToAgent(name: string, promptFile: string): void {
  const windowName = resolveWindowName(name) ?? name;
  const shortCmd = `Read ${promptFile} and follow the instructions inside.`;
  const escaped = shortCmd.replace(/'/g, "'\\''");
  execSync(`tmux send-keys -t "${TMUX_SESSION}:${windowName}" '${escaped}' Enter`, { stdio: 'pipe' });
}

// ─── DB polling ──────────────────────────────────────────

async function getPendings(): Promise<PendingResponse[]> {
  const rows = await db.select()
    .from(agentMessages)
    .where(
      and(
        eq(agentMessages.message_type, 'task_assign'),
        like(agentMessages.message, '[PENDING_RESPONSE]%'),
      ),
    );

  return rows.map(r => {
    const roomMatch = r.message?.match(/room=([\w-]+)/);
    const dbPayload = (r.payload ?? {}) as Record<string, unknown>;
    return {
      id: r.id,
      recipient: r.recipient ?? 'minjun-ceo',
      payload: {
        roomId: (dbPayload.roomId as string) ?? roomMatch?.[1] ?? '',
        originalMessage: (dbPayload.originalMessage as string) ?? '',
        sender: (dbPayload.sender as string) ?? r.sender ?? 'sihun-owner',
        ...(dbPayload.meetingId ? { meetingId: dbPayload.meetingId } : {}),
        ...(dbPayload.reportFrom ? { reportFrom: dbPayload.reportFrom } : {}),
      },
    } as PendingResponse;
  });
}

// ─── Main processor ──────────────────────────────────────

async function processOne(pending: PendingResponse): Promise<boolean> {
  const agentId = pending.recipient;
  const agent = AGENT_REGISTRY[agentId];
  if (!agent) {
    console.log(`[watcher] 알 수 없는 에이전트: ${agentId} — 스킵`);
    await markAsProcessed(pending.id);
    return false;
  }

  console.log(`[watcher] ${agent.name}(${agentId}) 처리 시작...`);

  if (!isAgentAlive(agentId)) {
    console.log(`[watcher] ${agentId} 세션 없음 — 스킵 (먼저 spawn_agent 필요)`);
    return false;
  }

  const basePrompt = await processOneResponse(pending);
  if (!basePrompt) {
    await markAsProcessed(pending.id);
    return false;
  }

  const respondCmd = `npx tsx ${PROJECT_ROOT}/_respond.ts '${pending.payload.roomId}' '${agent.id}'`;
  const prompt = [
    basePrompt,
    '',
    '== 응답 저장 (필수) ==',
    '응답을 생성한 후, 반드시 아래 Bash 명령으로 DB에 저장하세요:',
    '```bash',
    `${respondCmd} '여기에 응답 텍스트'`,
    '```',
    '- Bash 도구로 위 명령 실행.',
    '- 응답 텍스트는 작은따옴표(\')로 감싸세요. 텍스트 안에 작은따옴표가 있으면 \'\\\'\'로 이스케이프.',
    '- 이 명령을 실행하지 않으면 사용자가 응답을 볼 수 없습니다.',
  ].join('\n');

  mkdirSync(PROMPT_DIR, { recursive: true });
  const promptFile = `${PROMPT_DIR}/${agentId}.md`;
  writeFileSync(promptFile, prompt, 'utf-8');

  console.log(`[watcher] → ${agentId} 프롬프트 전달`);
  sendToAgent(agentId, promptFile);

  // 프롬프트 파일 rename — 에이전트가 읽을 시간(30초) 확보 후 비동기 rename
  const doneFile = `${PROMPT_DIR}/${agentId}.done.md`;
  setTimeout(() => {
    try {
      renameSync(promptFile, doneFile);
    } catch {
      // rename 실패해도 처리 자체는 계속 진행
    }
  }, 30_000);

  await markAsProcessed(pending.id);
  console.log(`[watcher] ✓ ${agent.name} 프롬프트 전달 완료 (응답은 에이전트가 직접 저장)`);

  return true;
}

// ─── Polling loop ────────────────────────────────────────

async function loop() {
  console.log(`[watcher] BiniLab PENDING_RESPONSE Watcher v2 시작 (${POLL_INTERVAL / 1000}초 주기)`);
  console.log(`[watcher] tmux session: ${TMUX_SESSION}`);

  while (true) {
    try {
      const pendings = await getPendings();
      if (pendings.length > 0) {
        console.log(`[watcher] ${pendings.length}건 감지`);
        for (const p of pendings) {
          await processOne(p);
        }
      }
    } catch (e) {
      console.error('[watcher] 에러:', e);
    }

    await new Promise(r => setTimeout(r, POLL_INTERVAL));
  }
}

loop().catch(e => { console.error(e); process.exit(1); });
