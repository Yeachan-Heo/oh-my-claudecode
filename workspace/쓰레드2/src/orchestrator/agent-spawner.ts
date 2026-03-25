/**
 * agent-spawner.ts — BiniLab 에이전트 스폰 프롬프트 빌더
 * /daily-run 스킬에서 각 Phase 에이전트를 Agent 도구로 스폰할 때 사용
 */

import { resolve } from 'path';
import { readFileSync } from 'fs';
import { loadAgentContext, formatMemoryForPrompt } from '../db/memory.js';

const PROJECT_ROOT = '/home/sihun92/projects/oh-my-claudecode/workspace/쓰레드2';

// ─── Agent Registry ─────────────────────────────────────

export interface AgentDefinition {
  id: string;
  name: string;           // Korean name
  file: string;           // .claude/agents/ path
  phase: number;          // which Phase this agent runs in
  role: 'collector' | 'analyst' | 'ceo' | 'editor' | 'qa' | 'engineer';
  department: string;     // for memory scoping: 'executive'|'marketing'|'analysis'|'qa'|'engineering'
  persona?: string;       // souls/ file path (optional)
  ops: string[];          // ops/ docs to reference
  category?: string;      // for editors: 뷰티/건강/생활/다이어트
}

export const AGENT_REGISTRY: Record<string, AgentDefinition> = {
  'junho-researcher': {
    id: 'junho-researcher', name: '준호',
    file: '.claude/agents/junho-researcher.md',
    phase: 1, role: 'collector', department: 'analysis',
    ops: ['ops/naver-data-ops.md'],
  },
  'seoyeon-analyst': {
    id: 'seoyeon-analyst', name: '서연',
    file: '.claude/agents/seoyeon-analyst.md',
    phase: 2, role: 'analyst', department: 'analysis',
    ops: ['ops/performance-ops.md'],
  },
  'minjun-ceo': {
    id: 'minjun-ceo', name: '민준',
    file: '.claude/agents/minjun-ceo.md',
    phase: 3, role: 'ceo', department: 'executive',
    ops: ['ops/daily-standup-ops.md', 'ops/weekly-retro-ops.md'],
  },
  'bini-beauty-editor': {
    id: 'bini-beauty-editor', name: '빈이',
    file: '.claude/agents/bini-beauty-editor.md',
    phase: 4, role: 'editor', department: 'marketing', category: '뷰티',
    persona: 'souls/bini-persona.md',
    ops: ['ops/content-creation-ops.md', 'ops/writing-guide-ops.md'],
  },
  'hana-health-editor': {
    id: 'hana-health-editor', name: '하나',
    file: '.claude/agents/hana-health-editor.md',
    phase: 4, role: 'editor', department: 'marketing', category: '건강',
    ops: ['ops/content-creation-ops.md', 'ops/writing-guide-ops.md'],
  },
  'sora-lifestyle-editor': {
    id: 'sora-lifestyle-editor', name: '소라',
    file: '.claude/agents/sora-lifestyle-editor.md',
    phase: 4, role: 'editor', department: 'marketing', category: '생활',
    ops: ['ops/content-creation-ops.md', 'ops/writing-guide-ops.md'],
  },
  'jiu-diet-editor': {
    id: 'jiu-diet-editor', name: '지우',
    file: '.claude/agents/jiu-diet-editor.md',
    phase: 4, role: 'editor', department: 'marketing', category: '다이어트',
    ops: ['ops/content-creation-ops.md', 'ops/writing-guide-ops.md'],
  },
  'doyun-qa': {
    id: 'doyun-qa', name: '도윤',
    file: '.claude/agents/doyun-qa.md',
    phase: 4, role: 'qa', department: 'qa',
    ops: ['ops/debate-ops.md'],
  },
  'taeho-engineer': {
    id: 'taeho-engineer', name: '태호',
    file: '.claude/agents/taeho-engineer.md',
    phase: 0, role: 'engineer', department: 'engineering',
    ops: [],
  },
};

export function getAgentRegistry(): Record<string, AgentDefinition> {
  return AGENT_REGISTRY;
}

// ─── Category → Editor mapping ──────────────────────────

export const EDITOR_MAP: Record<string, string> = {
  '뷰티': 'bini-beauty-editor',
  '건강': 'hana-health-editor',
  '생활': 'sora-lifestyle-editor',
  '다이어트': 'jiu-diet-editor',
};

// ─── Editor Self-Check ──────────────────────────────────

const EDITOR_SELF_CHECK = `
== 자가 검증 (초안 완성 후 반드시 확인) ==
아래 항목을 하나씩 확인하고, 실패 항목이 있으면 스스로 수정한 뒤 최종본을 제출해.

1. 첫 문장 20자 이내인가?
2. 구체적 팩트/숫자/제품명이 있는가? ("그래서 뭐?" 테스트)
3. AI 말투 없는가? ("~합니다", "여러분", "추천드립니다", "효과적" 금지)
4. 이모지 2개 이하인가?
5. 구어체인가? (ㅋㅋ, ㅜ, ~거든, ~임)
6. 글자수 120자 이내인가?
7. 전문가 톤 아닌가? (성분명/의학용어 직접 노출 금지. "담즙 분비 촉진"→"소화를 방해한다더라")
8. CTA가 구체적인가? ("댓글 좀" X → "먹어봐"/"적어줘" O)

위 8개 전부 통과한 최종본만 agent_messages로 전달할 것.
`;

// ─── Tool Registry ───────────────────────────────────────

const TOOL_REGISTRY: Record<string, string> = {
  collector: `== 사용 가능 도구 ==
- collect.ts <channel> 50 --since 24: Threads 채널 수집 (CDP)
- collect-by-keyword.ts --keywords "키워드": 키워드 검색 (CDP)
- collect-youtube-comments.ts --db --days 1: YouTube 댓글 (API)
- collect-naver-cafe.ts / collect-theqoo.ts / collect-instiz.ts: 커뮤니티
- discover-youtube-channels.py search --category 뷰티: 채널 발굴
- research-brands.ts: 브랜드 이벤트 리서치 (Exa)
- run-trend-pipeline.ts --dry-run: X 트렌드 수집+필터
- naver-keyword-search/search.py "키워드" --no-expand: 검색량
- naver-keyword-search/trend.py "키워드" --period 30: 트렌드
새 스크립트 만들지 마. 위 도구만 사용.`,

  analyst: `== 사용 가능 도구 ==
- topic-classifier.ts: TAG_MAP 카테고리 분류 (npx tsx src/analyzer/topic-classifier.ts)
- DB SELECT 쿼리 (임시 스크립트)
- naver-keyword-search/search.py: 검색량 조회
새 스크립트 만들지 마.`,

  ceo: `== 사용 가능 도구 ==
- agents/memory/strategy-log.md: 전략 기록 (append)
- agents/memory/experiment-log.md: 실험 기록
- agents/memory/category-playbook/*.md: 카테고리별 학습
- DB SELECT 쿼리 (임시 스크립트)
새 스크립트 만들지 마.`,

  editor: `== 사용 가능 도구 ==
- Read 도구만 (Write/Edit/Bash 금지)
- ops/content-creation-ops.md: 6단계 CoT
- src/agents/post-writing-guide.md: 글쓰기 지침
- souls/bini-persona.md: 빈이 페르소나 (뷰티 전용)`,

  qa: `== 사용 가능 도구 ==
- Read/Grep/Glob만 (Write/Edit/Bash 금지)
- ops/debate-ops.md: 체크리스트 10항목 + K1~K4`,

  engineer: `== 사용 가능 도구 ==
- 모든 도구 사용 가능 (유일한 코드 수정 권한)
- tsc --noEmit + npm test 통과 필수`,
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

export async function buildAgentPrompt(agentId: string, mission: string, context?: string): Promise<string> {
  const registry = getAgentRegistry();
  const agent = registry[agentId];
  if (!agent) throw new Error(`Unknown agent: ${agentId}`);

  const lines: string[] = [];

  // ── v2: COMPANY.md 주입 (에이전트가 모를 수 없게) ──────────
  try {
    const companyMd = readFileSync(resolve(PROJECT_ROOT, 'COMPANY.md'), 'utf-8');
    lines.push('== BiniLab AI Company 가이드 ==');
    lines.push(companyMd);
    lines.push('');
  } catch {
    // COMPANY.md 없으면 스킵
  }

  // ── v2: 기억 주입 (loadAgentContext + formatMemoryForPrompt) ──
  try {
    const memCtx = await loadAgentContext(agentId, agent.department);
    const memStr = formatMemoryForPrompt(memCtx);
    if (memStr) {
      lines.push('== 에이전트 기억 및 컨텍스트 ==');
      lines.push(memStr);
      lines.push('');
    }
  } catch {
    // 기억 로드 실패 시 스킵 (DB 미연결 등)
  }

  // Identity
  lines.push(`너는 BiniLab의 ${agent.name}이다.`);
  lines.push(`역할: ${agent.role}`);
  lines.push('');

  // Tool registry (role-based)
  const toolDocs = TOOL_REGISTRY[agent.role];
  if (toolDocs) {
    lines.push(toolDocs);
    lines.push('');
  }

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

  // Editor: playbook injection
  if (agent.role === 'editor' && agent.category) {
    const playbookFile = getCategoryFileName(agent.category);
    lines.push(`== 카테고리 플레이북 ==`);
    lines.push(`Read ${resolve(PROJECT_ROOT, `agents/memory/category-playbook/${playbookFile}.md`)} 를 읽어서 이 카테고리의 학습 내용을 파악해. (파일이 없으면 무시)`);
    lines.push('');
  }

  // CEO: strategy-log injection
  if (agent.role === 'ceo') {
    lines.push(`== 전략 로그 ==`);
    lines.push(`Read ${resolve(PROJECT_ROOT, 'agents/memory/strategy-log.md')} 를 읽어서 최근 전략 방향을 파악해. (파일이 없으면 무시)`);
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

  // Editor: self-check
  if (agent.role === 'editor') {
    lines.push(EDITOR_SELF_CHECK);
    lines.push('');
  }

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

// ─── Phase Context Query ─────────────────────────────────

export function buildPhaseContextQuery(agentId: string): string {
  return `cat > ${PROJECT_ROOT}/_phase-context.ts << 'SCRIPT'
import 'dotenv/config';
import { getUnreadMessages } from './src/db/agent-messages.js';
async function main() {
  const msgs = await getUnreadMessages('${agentId}');
  for (const m of msgs) {
    console.log(\`[\${m.sender} → \${m.recipient}] \${m.message}\`);
  }
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
SCRIPT
cd ${PROJECT_ROOT} && npx tsx _phase-context.ts && rm _phase-context.ts`;
}

// ─── Category File Name Helper ───────────────────────────

export function getCategoryFileName(category: string): string {
  const map: Record<string, string> = {
    '뷰티': 'beauty',
    '건강': 'health',
    '생활': 'lifestyle',
    '다이어트': 'diet',
  };
  return map[category] ?? category.toLowerCase();
}
