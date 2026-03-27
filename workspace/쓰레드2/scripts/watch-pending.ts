#!/usr/bin/env npx tsx
/**
 * BiniLab PENDING_RESPONSE Watcher
 *
 * DB를 5초마다 polling하여 PENDING_RESPONSE 마커를 감지하고,
 * tmux의 에이전트 세션에 메시지를 전달하여 실시간 응답을 생성한다.
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
import { writeFileSync, mkdirSync } from 'fs';
import { db } from '../src/db/index.js';
import { agentMessages } from '../src/db/schema.js';
import { eq, and, like } from 'drizzle-orm';
import { AGENT_REGISTRY } from '../src/orchestrator/agent-spawner.js';
import { processOneResponse } from '../src/orchestrator/response-processor.js';
import { saveResponseToRoom, markAsProcessed } from '../src/orchestrator/response-processor.js';
import { processAgentOutput } from '../src/orchestrator/agent-output-parser.js';
import type { PendingResponse } from '../src/orchestrator/response-processor.js';

const POLL_INTERVAL = 5_000; // 5초
const RESPONSE_WAIT = 20_000; // 응답 대기 최대 20초
const TMUX_SESSION = 'binilab';
const LOG_DIR = `${process.cwd()}/.ccx/projects/binilab/logs`;

// ─── tmux helpers ────────────────────────────────────────

// agent-mux는 윈도우 이름을 짧게 할 수 있음. 부분 매칭 사용.
function resolveWindowName(agentId: string): string | null {
  try {
    const out = execSync(
      `tmux list-windows -t ${TMUX_SESSION} -F "#{window_name}" 2>/dev/null`,
      { encoding: 'utf-8' },
    );
    const windows = out.trim().split('\n');
    // 정확 매칭 → 부분 매칭 (minjun-ceo → ceo, seoyeon-analyst → seoyeon)
    return windows.find(w => w === agentId)
      ?? windows.find(w => agentId.includes(w) || w.includes(agentId.split('-')[0]))
      ?? null;
  } catch { return null; }
}

function isAgentAlive(name: string): boolean {
  return resolveWindowName(name) !== null;
}

const PROMPT_DIR = `/tmp/binilab-prompts`;

function sendToAgent(name: string, message: string): void {
  const windowName = resolveWindowName(name) ?? name;

  // 긴 프롬프트를 파일에 저장하고, 짧은 Read 명령만 tmux로 전달
  mkdirSync(PROMPT_DIR, { recursive: true });
  const promptFile = `${PROMPT_DIR}/${name}.md`;
  writeFileSync(promptFile, message, 'utf-8');

  const shortCmd = `Read ${promptFile} and follow the instructions inside. Respond in Korean, 1-3 sentences, casual tone.`;
  const escaped = shortCmd.replace(/'/g, "'\\''");
  execSync(`tmux send-keys -t "${TMUX_SESSION}:${windowName}" '${escaped}' Enter`, { stdio: 'pipe' });
}

function findLogFile(name: string): string {
  // 정확 매칭 → 부분 매칭
  try {
    const out = execSync(`ls "${LOG_DIR}"/*.log 2>/dev/null`, { encoding: 'utf-8' });
    const files = out.trim().split('\n');
    return files.find(f => f.includes(name))
      ?? files.find(f => name.split('-').some(part => f.includes(part)))
      ?? `${LOG_DIR}/${name}.log`;
  } catch { return `${LOG_DIR}/${name}.log`; }
}

function getLogLineCount(name: string): number {
  try {
    const logFile = findLogFile(name);
    const out = execSync(`wc -l < "${logFile}" 2>/dev/null`, { encoding: 'utf-8' });
    return parseInt(out.trim()) || 0;
  } catch { return 0; }
}

function getNewLogLines(name: string, afterLine: number): string {
  try {
    const logFile = findLogFile(name);
    const out = execSync(`tail -n +${afterLine + 1} "${logFile}" 2>/dev/null`, { encoding: 'utf-8' });
    return out;
  } catch { return ''; }
}

function extractResponse(rawOutput: string): string {
  // Claude Code 출력에서 실제 응답 추출
  // "● " 뒤의 텍스트가 실제 응답
  const lines = rawOutput.split('\n');
  const responseLines: string[] = [];
  let capturing = false;

  for (const line of lines) {
    const cleaned = line.replace(/\x1b\[[0-9;]*m/g, '').trim();
    if (cleaned.startsWith('●') || cleaned.startsWith('⏺')) {
      capturing = true;
      responseLines.push(cleaned.replace(/^[●⏺]\s*/, ''));
    } else if (capturing && cleaned && !cleaned.startsWith('❯') && !cleaned.startsWith('─') && !cleaned.startsWith('[OMC')) {
      responseLines.push(cleaned);
    } else if (capturing && (cleaned.startsWith('❯') || cleaned.startsWith('─'))) {
      capturing = false;
    }
  }

  return responseLines.join('\n').trim();
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
    const roomMatch = r.message?.match(/room=([a-f0-9-]+)/);
    return {
      id: r.id,
      recipient: r.recipient ?? 'minjun-ceo',
      payload: {
        roomId: roomMatch?.[1] ?? '',
        originalMessage: '',
        sender: r.sender ?? 'sihun-owner',
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

  // 1. 에이전트 tmux 세션 확인
  if (!isAgentAlive(agentId)) {
    console.log(`[watcher] ${agentId} 세션 없음 — 스킵 (먼저 spawn_agent 필요)`);
    return false;
  }

  // 2. 프롬프트 생성
  const prompt = await processOneResponse(pending);
  if (!prompt) {
    await markAsProcessed(pending.id);
    return false;
  }

  // 3. 현재 로그 줄 수 기록 (응답 시작점)
  const beforeLines = getLogLineCount(agentId);

  // 4. tmux로 전달
  console.log(`[watcher] → ${agentId} 메시지 전달 중...`);
  sendToAgent(agentId, prompt);

  // 5. 응답 대기 (polling)
  const startTime = Date.now();
  let response = '';

  while (Date.now() - startTime < RESPONSE_WAIT) {
    await new Promise(r => setTimeout(r, 3000));
    const newOutput = getNewLogLines(agentId, beforeLines);
    response = extractResponse(newOutput);
    if (response.length > 10) break; // 응답 감지
  }

  if (!response) {
    console.log(`[watcher] ${agentId} 응답 타임아웃 (${RESPONSE_WAIT / 1000}초)`);
    await markAsProcessed(pending.id);
    return false;
  }

  console.log(`[watcher] ← ${agent.name}: "${response.substring(0, 80)}..."`);

  // 6. DB 저장
  await saveResponseToRoom(agentId, pending.payload.roomId, response);

  // 7. output-parser로 태그 파싱
  await processAgentOutput(agentId, response).catch(() => {});

  // 8. 마커 처리 완료
  await markAsProcessed(pending.id);
  console.log(`[watcher] ✓ ${agent.name} 처리 완료`);

  return true;
}

// ─── Polling loop ────────────────────────────────────────

async function loop() {
  console.log(`[watcher] BiniLab PENDING_RESPONSE Watcher 시작 (${POLL_INTERVAL / 1000}초 주기)`);
  console.log(`[watcher] tmux session: ${TMUX_SESSION}, log dir: ${LOG_DIR}`);

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
