/**
 * @file scripts/migrate-memory-to-db.ts
 * S-1.5: 파일 기반 기억 → DB 마이그레이션
 *
 * 마이그레이션 대상:
 * 1. agents/memory/strategy-log.md       → agent_episodes (event_type='decision')
 * 2. agents/memory/experiment-log.md     → experiments 테이블 보강
 * 3. agents/memory/category-playbook/*.md → agent_memories (scope='marketing', type='pattern')
 * 4. agents/memory/weekly-insights.md   → agent_memories (scope='global', type='insight')
 *
 * 완료 후: agents/memory/ → agents/memory-archive/ 리네임
 */

import 'dotenv/config';
import * as fs from 'fs';
import * as path from 'path';
import { db } from '../src/db/index.js';
import { agentEpisodes, agentMemories } from '../src/db/schema.js';

const MEMORY_DIR = path.join(__dirname, '..', 'agents', 'memory');
const ARCHIVE_DIR = path.join(__dirname, '..', 'agents', 'memory-archive');

// ─── 1. strategy-log.md → agent_episodes ───────────────────────────────────

function parseStrategyLog(content: string): Array<{
  summary: string;
  details: Record<string, unknown>;
  occurred_at: Date;
}> {
  const entries: Array<{ summary: string; details: Record<string, unknown>; occurred_at: Date }> = [];

  // 각 날짜 블록 파싱: ## YYYY-MM-DD 로 시작
  const dateBlockRegex = /^#{1,3}\s+(\d{4}-\d{2}-\d{2})\s*$/gm;
  const blocks = content.split(dateBlockRegex);

  // split 결과: [before, date1, content1, date2, content2, ...]
  for (let i = 1; i < blocks.length; i += 2) {
    const dateStr = blocks[i]?.trim();
    const body = blocks[i + 1] ?? '';

    if (!dateStr || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) continue;

    const date = new Date(dateStr + 'T09:00:00+09:00');
    if (isNaN(date.getTime())) continue;

    // 결정 섹션 추출
    const decisionMatch = body.match(/###\s*결정\s*\n([\s\S]*?)(?=###|$)/);
    const resultMatch = body.match(/###\s*결과[^#]*\n([\s\S]*?)(?=###|$)/);
    const memoMatch = body.match(/###\s*메모\s*\n([\s\S]*?)(?=###|$)/);

    const decision = decisionMatch?.[1]?.trim() ?? '';
    const result = resultMatch?.[1]?.trim() ?? '';
    const memo = memoMatch?.[1]?.trim() ?? '';

    if (!decision && !body.trim()) continue;

    // 불릿 포인트 파싱 (간단히)
    const parseLines = (text: string) =>
      text
        .split('\n')
        .map((l) => l.replace(/^[-*]\s*/, '').trim())
        .filter(Boolean);

    const summary = `[${dateStr}] CEO 결정: ${parseLines(decision)[0] ?? '기록 없음'}`;

    entries.push({
      summary,
      details: {
        date: dateStr,
        decisions: parseLines(decision),
        results: parseLines(result),
        memo: parseLines(memo),
        migrated_from: 'strategy-log.md',
      },
      occurred_at: date,
    });
  }

  return entries;
}

async function migrateStrategyLog(): Promise<number> {
  const filePath = path.join(MEMORY_DIR, 'strategy-log.md');
  if (!fs.existsSync(filePath)) {
    console.log('  strategy-log.md 없음, 스킵');
    return 0;
  }

  const content = fs.readFileSync(filePath, 'utf-8');
  const entries = parseStrategyLog(content);

  if (entries.length === 0) {
    console.log('  strategy-log.md: 파싱된 항목 없음');
    return 0;
  }

  let inserted = 0;
  for (const entry of entries) {
    try {
      await db.insert(agentEpisodes).values({
        agent_id: 'minjun-ceo',
        event_type: 'decision',
        summary: entry.summary,
        details: entry.details,
        occurred_at: entry.occurred_at,
      });
      inserted++;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`  strategy-log 항목 삽입 실패: ${msg}`);
    }
  }

  console.log(`  strategy-log.md → agent_episodes: ${inserted}/${entries.length}개 삽입`);
  return inserted;
}

// ─── 2. experiment-log.md → experiments (보강) ─────────────────────────────
// 현재 실험 데이터 없음 — 파일 구조 확인 후 스킵 (빈 템플릿)

async function migrateExperimentLog(): Promise<number> {
  const filePath = path.join(MEMORY_DIR, 'experiment-log.md');
  if (!fs.existsSync(filePath)) {
    console.log('  experiment-log.md 없음, 스킵');
    return 0;
  }

  const content = fs.readFileSync(filePath, 'utf-8');

  // EXP-YYYY-MM-DD-N 형식의 실험 블록 찾기
  const expBlockRegex = /^##\s+(EXP-\d{4}-\d{2}-\d{2}-\d+)\s*$/gm;
  const expIds = [...content.matchAll(expBlockRegex)].map((m) => m[1]);

  if (expIds.length === 0) {
    console.log('  experiment-log.md: 기록된 실험 없음 (템플릿만 존재)');
    return 0;
  }

  // 실제 실험 항목이 있는 경우 에피소드로 기록
  let inserted = 0;
  for (const expId of expIds) {
    try {
      await db.insert(agentEpisodes).values({
        agent_id: 'minjun-ceo',
        event_type: 'experiment',
        summary: `실험 기록 마이그레이션: ${expId}`,
        details: { experiment_id: expId, migrated_from: 'experiment-log.md' },
      });
      inserted++;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`  experiment-log 항목 삽입 실패: ${msg}`);
    }
  }

  console.log(`  experiment-log.md → agent_episodes: ${inserted}/${expIds.length}개 삽입`);
  return inserted;
}

// ─── 3. category-playbook/*.md → agent_memories ────────────────────────────

const CATEGORY_AGENT_MAP: Record<string, string> = {
  'beauty.md': 'bini-beauty-creator',
  'health.md': 'hana-health-editor',
  'lifestyle.md': 'sora-lifestyle-curator',
  'diet.md': 'jiwoo-diet-coach',
};

function parseCategoryPlaybook(
  content: string,
  filename: string,
): Array<{ content: string; importance: number }> {
  const memories: Array<{ content: string; importance: number }> = [];

  // "잘 되는 패턴" 섹션 추출
  const goodPatternMatch = content.match(/##\s*잘 되는 패턴([\s\S]*?)(?=##|$)/);
  if (goodPatternMatch?.[1]) {
    const section = goodPatternMatch[1].trim();
    // 테이블 행에서 실제 데이터 추출 (헤더 제외, "데이터 축적 중" 제외)
    const tableRows = section
      .split('\n')
      .filter((l) => l.startsWith('|') && !l.includes('---') && !l.includes('데이터 축적'))
      .slice(1); // 헤더 행 제외

    for (const row of tableRows) {
      const cells = row.split('|').map((c) => c.trim()).filter(Boolean);
      if (cells.length >= 2 && cells[0] && !cells[0].includes('---')) {
        memories.push({
          content: `[${filename.replace('.md', '')} 플레이북] 잘 되는 패턴: ${cells.join(' — ')}`,
          importance: 0.7,
        });
      }
    }
  }

  // "안 되는 패턴" 섹션 추출
  const badPatternMatch = content.match(/##\s*안 되는 패턴([\s\S]*?)(?=##|$)/);
  if (badPatternMatch?.[1]) {
    const section = badPatternMatch[1].trim();
    const tableRows = section
      .split('\n')
      .filter((l) => l.startsWith('|') && !l.includes('---') && !l.includes('데이터 축적'))
      .slice(1);

    for (const row of tableRows) {
      const cells = row.split('|').map((c) => c.trim()).filter(Boolean);
      if (cells.length >= 2 && cells[0] && !cells[0].includes('---')) {
        memories.push({
          content: `[${filename.replace('.md', '')} 플레이북] 안 되는 패턴: ${cells.join(' — ')}`,
          importance: 0.6,
        });
      }
    }
  }

  return memories;
}

async function migrateCategoryPlaybooks(): Promise<number> {
  const playbookDir = path.join(MEMORY_DIR, 'category-playbook');
  if (!fs.existsSync(playbookDir)) {
    console.log('  category-playbook/ 없음, 스킵');
    return 0;
  }

  const files = fs.readdirSync(playbookDir).filter((f) => f.endsWith('.md'));
  let inserted = 0;

  for (const filename of files) {
    const content = fs.readFileSync(path.join(playbookDir, filename), 'utf-8');
    const memories = parseCategoryPlaybook(content, filename);
    const agentId = CATEGORY_AGENT_MAP[filename] ?? 'system';

    if (memories.length === 0) {
      console.log(`  ${filename}: 파싱된 패턴 없음 (데이터 축적 중)`);
      continue;
    }

    for (const mem of memories) {
      try {
        await db.insert(agentMemories).values({
          agent_id: agentId,
          scope: 'marketing',
          memory_type: 'pattern',
          content: mem.content,
          importance: mem.importance,
          source: `category-playbook/${filename}`,
        });
        inserted++;
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`  ${filename} 패턴 삽입 실패: ${msg}`);
      }
    }

    console.log(`  ${filename} → agent_memories: ${memories.length}개 삽입`);
  }

  return inserted;
}

// ─── 4. weekly-insights.md → agent_memories ────────────────────────────────

function parseWeeklyInsights(
  content: string,
): Array<{ content: string; importance: number; occurred_at?: Date }> {
  const insights: Array<{ content: string; importance: number; occurred_at?: Date }> = [];

  // ## YYYY-WW 블록 파싱
  const weekBlockRegex = /^##\s+(\d{4}-\d{2})\s+\([^)]+\)/gm;
  const blocks = content.split(weekBlockRegex);

  for (let i = 1; i < blocks.length; i += 2) {
    const weekId = blocks[i]?.trim();
    const body = blocks[i + 1] ?? '';

    // 전략 제안 섹션
    const strategyMatch = body.match(/###\s*다음\s*주\s*전략\s*제안([\s\S]*?)(?=###|$)/);
    if (strategyMatch?.[1]) {
      const lines = strategyMatch[1]
        .split('\n')
        .map((l) => l.replace(/^[-*\d.]\s*/, '').trim())
        .filter((l) => l && !l.includes('데이터 축적'));

      for (const line of lines) {
        insights.push({
          content: `[주간 인사이트 ${weekId}] 전략: ${line}`,
          importance: 0.75,
        });
      }
    }

    // 패턴 분석 섹션
    const patternMatch = body.match(/###\s*패턴\s*분석([\s\S]*?)(?=###|$)/);
    if (patternMatch?.[1]) {
      const lines = patternMatch[1]
        .split('\n')
        .map((l) => l.replace(/^[-*]\s*/, '').trim())
        .filter((l) => l && !l.includes('데이터 축적'));

      for (const line of lines) {
        insights.push({
          content: `[주간 인사이트 ${weekId}] 패턴: ${line}`,
          importance: 0.65,
        });
      }
    }
  }

  return insights;
}

async function migrateWeeklyInsights(): Promise<number> {
  const filePath = path.join(MEMORY_DIR, 'weekly-insights.md');
  if (!fs.existsSync(filePath)) {
    console.log('  weekly-insights.md 없음, 스킵');
    return 0;
  }

  const content = fs.readFileSync(filePath, 'utf-8');
  const insights = parseWeeklyInsights(content);

  if (insights.length === 0) {
    console.log('  weekly-insights.md: 파싱된 인사이트 없음 (데이터 축적 중)');
    return 0;
  }

  let inserted = 0;
  for (const insight of insights) {
    try {
      await db.insert(agentMemories).values({
        agent_id: 'seoyeon-analyst',
        scope: 'global',
        memory_type: 'insight',
        content: insight.content,
        importance: insight.importance,
        source: 'weekly-insights.md',
      });
      inserted++;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`  weekly-insights 항목 삽입 실패: ${msg}`);
    }
  }

  console.log(`  weekly-insights.md → agent_memories: ${inserted}/${insights.length}개 삽입`);
  return inserted;
}

// ─── 5. agents/memory/ → agents/memory-archive/ 리네임 ────────────────────

function archiveMemoryDir(): void {
  if (!fs.existsSync(MEMORY_DIR)) {
    console.log('  agents/memory/ 없음, 스킵');
    return;
  }

  if (fs.existsSync(ARCHIVE_DIR)) {
    console.log('  agents/memory-archive/ 이미 존재, 스킵');
    return;
  }

  fs.renameSync(MEMORY_DIR, ARCHIVE_DIR);
  console.log('  agents/memory/ → agents/memory-archive/ 리네임 완료');
}

// ─── 메인 ──────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('=== BiniLab 파일→DB 마이그레이션 시작 ===\n');

  if (!fs.existsSync(MEMORY_DIR)) {
    console.error(`ERROR: ${MEMORY_DIR} 디렉토리를 찾을 수 없습니다.`);
    process.exit(1);
  }

  let totalInserted = 0;

  console.log('[1/4] strategy-log.md → agent_episodes');
  totalInserted += await migrateStrategyLog();

  console.log('\n[2/4] experiment-log.md → agent_episodes');
  totalInserted += await migrateExperimentLog();

  console.log('\n[3/4] category-playbook/*.md → agent_memories');
  totalInserted += await migrateCategoryPlaybooks();

  console.log('\n[4/4] weekly-insights.md → agent_memories');
  totalInserted += await migrateWeeklyInsights();

  console.log('\n[5/5] agents/memory/ → agents/memory-archive/');
  archiveMemoryDir();

  console.log(`\n=== 마이그레이션 완료: 총 ${totalInserted}개 항목 삽입 ===`);
  process.exit(0);
}

main().catch((err) => {
  console.error('마이그레이션 실패:', err);
  process.exit(1);
});
