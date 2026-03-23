/**
 * agent-spawner.ts — BiniLab 에이전트 스폰 프롬프트 빌더
 * /daily-run 스킬에서 각 Phase 에이전트를 Agent 도구로 스폰할 때 사용
 */

import { resolve } from 'path';

const PROJECT_ROOT = '/home/sihun92/projects/oh-my-claudecode/workspace/쓰레드2';

// ─── Agent Registry ─────────────────────────────────────

export interface AgentDefinition {
  id: string;
  name: string;           // Korean name
  file: string;           // .claude/agents/ path
  phase: number;          // which Phase this agent runs in
  role: 'collector' | 'analyst' | 'ceo' | 'editor' | 'qa' | 'engineer';
  persona?: string;       // souls/ file path (optional)
  ops: string[];          // ops/ docs to reference
  category?: string;      // for editors: 뷰티/건강/생활/다이어트
}

export const AGENT_REGISTRY: Record<string, AgentDefinition> = {
  'junho-researcher': {
    id: 'junho-researcher', name: '준호',
    file: '.claude/agents/junho-researcher.md',
    phase: 1, role: 'collector',
    ops: ['ops/naver-data-ops.md'],
  },
  'seoyeon-analyst': {
    id: 'seoyeon-analyst', name: '서연',
    file: '.claude/agents/seoyeon-analyst.md',
    phase: 2, role: 'analyst',
    ops: ['ops/performance-ops.md'],
  },
  'minjun-ceo': {
    id: 'minjun-ceo', name: '민준',
    file: '.claude/agents/minjun-ceo.md',
    phase: 3, role: 'ceo',
    ops: ['ops/daily-standup-ops.md', 'ops/weekly-retro-ops.md'],
  },
  'bini-beauty-editor': {
    id: 'bini-beauty-editor', name: '빈이',
    file: '.claude/agents/bini-beauty-editor.md',
    phase: 4, role: 'editor', category: '뷰티',
    persona: 'souls/bini-persona.md',
    ops: ['ops/content-creation-ops.md', 'ops/writing-guide-ops.md'],
  },
  'hana-health-editor': {
    id: 'hana-health-editor', name: '하나',
    file: '.claude/agents/hana-health-editor.md',
    phase: 4, role: 'editor', category: '건강',
    ops: ['ops/content-creation-ops.md', 'ops/writing-guide-ops.md'],
  },
  'sora-lifestyle-editor': {
    id: 'sora-lifestyle-editor', name: '소라',
    file: '.claude/agents/sora-lifestyle-editor.md',
    phase: 4, role: 'editor', category: '생활',
    ops: ['ops/content-creation-ops.md', 'ops/writing-guide-ops.md'],
  },
  'jiu-diet-editor': {
    id: 'jiu-diet-editor', name: '지우',
    file: '.claude/agents/jiu-diet-editor.md',
    phase: 4, role: 'editor', category: '다이어트',
    ops: ['ops/content-creation-ops.md', 'ops/writing-guide-ops.md'],
  },
  'doyun-qa': {
    id: 'doyun-qa', name: '도윤',
    file: '.claude/agents/doyun-qa.md',
    phase: 4, role: 'qa',
    ops: ['ops/debate-ops.md'],
  },
  'taeho-engineer': {
    id: 'taeho-engineer', name: '태호',
    file: '.claude/agents/taeho-engineer.md',
    phase: 0, role: 'engineer',
    ops: [],
  },
};

// ─── Category → Editor mapping ──────────────────────────

export const EDITOR_MAP: Record<string, string> = {
  '뷰티': 'bini-beauty-editor',
  '건강': 'hana-health-editor',
  '생활': 'sora-lifestyle-editor',
  '다이어트': 'jiu-diet-editor',
};

// ─── Phase → Ops docs ───────────────────────────────────

export const PHASE_OPS: Record<number, string[]> = {
  1: ['ops/naver-data-ops.md'],
  2: ['ops/performance-ops.md'],
  3: ['ops/daily-standup-ops.md'],
  4: ['ops/content-creation-ops.md', 'ops/debate-ops.md', 'ops/writing-guide-ops.md'],
  5: [],  // Safety gates — code execution, no ops doc needed
  6: ['ops/performance-ops.md'],
};

// ─── Prompt Builder ─────────────────────────────────────

export function buildAgentPrompt(agentId: string, mission: string, context?: string): string {
  const agent = AGENT_REGISTRY[agentId];
  if (!agent) throw new Error(`Unknown agent: ${agentId}`);

  const lines: string[] = [];

  // Identity
  lines.push(`너는 BiniLab의 ${agent.name}이다.`);
  lines.push(`역할: ${agent.role}`);
  lines.push('');

  // Read agent definition
  lines.push(`== 에이전트 정의 ==`);
  lines.push(`먼저 Read ${resolve(PROJECT_ROOT, agent.file)} 를 읽어서 너의 성격, 전문성, 도구 제한을 파악해.`);
  if (agent.persona) {
    lines.push(`페르소나: Read ${resolve(PROJECT_ROOT, agent.persona)} 도 읽어.`);
  }
  lines.push('');

  // Ops references
  if (agent.ops.length > 0) {
    lines.push(`== 참조 문서 ==`);
    for (const op of agent.ops) {
      lines.push(`- Read ${resolve(PROJECT_ROOT, op)}`);
    }
    lines.push('');
  }

  // Context from previous phases (agent_messages)
  if (context) {
    lines.push(`== 이전 Phase 결과 (agent_messages) ==`);
    lines.push(context);
    lines.push('');
  }

  // Mission
  lines.push(`== 임무 ==`);
  lines.push(mission);
  lines.push('');

  // agent_messages recording instruction
  lines.push(`== agent_messages 기록 (필수) ==`);
  lines.push(`작업 완료 후 반드시 아래 패턴으로 agent_messages에 기록해:`);
  lines.push('```bash');
  lines.push(`cat > ${PROJECT_ROOT}/_msg.ts << 'SCRIPT'`);
  lines.push(`import 'dotenv/config';`);
  lines.push(`import { sendMessage } from './src/db/agent-messages.js';`);
  lines.push(`async function main() {`);
  lines.push(`  await sendMessage('${agentId}', '{recipient}', 'pipeline', '{결과 메시지}');`);
  lines.push(`  process.exit(0);`);
  lines.push(`}`);
  lines.push(`main().catch(e => { console.error(e); process.exit(1); });`);
  lines.push('SCRIPT');
  lines.push(`cd ${PROJECT_ROOT} && npx tsx _msg.ts && rm _msg.ts`);
  lines.push('```');
  lines.push(`{recipient}과 {결과 메시지}를 실제 값으로 교체해서 실행할 것.`);

  return lines.join('\n');
}

// ─── Message Script Builder ─────────────────────────────

export function buildMessageScript(
  sender: string,
  recipient: string,
  channel: string,
  message: string,
): string {
  return `cat > ${PROJECT_ROOT}/_msg.ts << 'SCRIPT'
import 'dotenv/config';
import { sendMessage } from './src/db/agent-messages.js';
async function main() {
  await sendMessage('${sender}', '${recipient}', '${channel}', \`${message.replace(/`/g, '\\`')}\`);
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
SCRIPT
cd ${PROJECT_ROOT} && npx tsx _msg.ts && rm _msg.ts`;
}

// ─── Context Reader ─────────────────────────────────────

export function buildContextReaderScript(agentId: string): string {
  return `cat > ${PROJECT_ROOT}/_read-context.ts << 'SCRIPT'
import 'dotenv/config';
import { getUnreadMessages } from './src/db/agent-messages.js';
async function main() {
  const msgs = await getUnreadMessages('${agentId}');
  for (const m of msgs) {
    console.log(\`[\${m.sender}] \${m.message}\`);
  }
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
SCRIPT
cd ${PROJECT_ROOT} && npx tsx _read-context.ts && rm _read-context.ts`;
}
