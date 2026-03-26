/**
 * @file scripts/migrate-memory-to-db.ts
 * Phase 2-B: agents/memory/ md 파일 → DB(agent_memories, agent_episodes) 마이그레이션
 *
 * 마이그레이션 대상:
 *   strategy-log.md          → agent_memories (scope=global, type=decision)
 *   experiment-log.md        → agent_episodes (agent_id=system, event_type=experiment)
 *   category-playbook/*.md   → agent_memories (scope=marketing, type=playbook)
 *
 * Usage:
 *   npx tsx scripts/migrate-memory-to-db.ts            # 실제 마이그레이션
 *   npx tsx scripts/migrate-memory-to-db.ts --dry-run  # 파싱 결과만 출력
 */

import 'dotenv/config';
import * as fs from 'fs';
import * as path from 'path';
import { eq } from 'drizzle-orm';
import { db } from '../src/db/index.js';
import { agentMemories, agentEpisodes, systemState } from '../src/db/schema.js';

const PROJECT_ROOT = path.resolve(__dirname, '..');
const MEMORY_DIR = path.join(PROJECT_ROOT, 'agents', 'memory');
const DRY_RUN = process.argv.includes('--dry-run');

const MIGRATION_KEY = 'memory_migration_v1';

// ─── 유틸 ───────────────────────────────────────────────────────────────────

function log(msg: string): void {
  console.log(msg);
}

function isTemplateOnly(content: string): boolean {
  // 실제 데이터가 없고 템플릿/주석만 있는지 판별
  const stripped = content
    .replace(/<!--[\s\S]*?-->/g, '')   // HTML 주석 제거
    .replace(/```[\s\S]*?```/g, '')    // 코드블록 제거
    .replace(/^#+\s.*/gm, '')          // 헤더 제거
    .replace(/\(데이터 축적 중\)/g, '')
    .replace(/\(초기 생성\)/g, '')
    .replace(/^\s*[-|]\s*$/gm, '')     // 빈 리스트/테이블 구분자
    .replace(/\s+/g, ' ')
    .trim();
  return stripped.length < 30;
}

// ─── 1. strategy-log.md → agent_memories ────────────────────────────────────

interface StrategyEntry {
  sectionTitle: string;
  content: string;
  date: string;
}

function parseStrategyLog(fileContent: string): StrategyEntry[] {
  const entries: StrategyEntry[] = [];

  // ## [YYYYMMDD] 또는 ## YYYY-MM-DD 형식의 섹션 분리
  // 헤더 패턴: ## [20260326] Directive 또는 ## 2026-03-25 또는 ### 2026-03-25
  const sectionRegex = /^#{2,3}\s+(?:\[(\d{4})(\d{2})(\d{2})\][^\n]*|(\d{4}-\d{2}-\d{2})[^\n]*)/gm;

  const positions: Array<{ index: number; title: string; date: string }> = [];
  let match: RegExpExecArray | null;

  while ((match = sectionRegex.exec(fileContent)) !== null) {
    let date = '';
    const title = match[0].replace(/^#+\s+/, '').trim();

    if (match[1] && match[2] && match[3]) {
      // [YYYYMMDD] 형식
      date = `${match[1]}-${match[2]}-${match[3]}`;
    } else if (match[4]) {
      // YYYY-MM-DD 형식
      date = match[4];
    }

    if (date) {
      positions.push({ index: match.index, title, date });
    }
  }

  for (let i = 0; i < positions.length; i++) {
    const start = positions[i].index;
    const end = positions[i + 1]?.index ?? fileContent.length;
    const sectionContent = fileContent.slice(start, end).trim();

    // 사용법/헤더 섹션 스킵
    if (positions[i].title.includes('사용 방법')) continue;
    // 내용이 너무 짧으면 스킵
    if (sectionContent.length < 20) continue;

    entries.push({
      sectionTitle: positions[i].title,
      content: sectionContent,
      date: positions[i].date,
    });
  }

  return entries;
}

async function migrateStrategyLog(dryRun: boolean): Promise<number> {
  const filePath = path.join(MEMORY_DIR, 'strategy-log.md');
  if (!fs.existsSync(filePath)) {
    log('  [1] strategy-log.md 없음, 스킵');
    return 0;
  }

  const content = fs.readFileSync(filePath, 'utf-8');
  const entries = parseStrategyLog(content);

  if (entries.length === 0) {
    log('  [1] strategy-log.md: 파싱된 섹션 없음');
    return 0;
  }

  log(`  [1] strategy-log.md: ${entries.length}개 섹션 파싱됨`);

  if (dryRun) {
    for (const e of entries) {
      log(`      [DRY-RUN] agent_memories <- ${e.sectionTitle} (${e.date})`);
    }
    return entries.length;
  }

  // 멱등성: 이미 같은 source로 삽입된 기록이 있으면 스킵
  const existingRows = await db
    .select({ source: agentMemories.source })
    .from(agentMemories)
    .where(eq(agentMemories.source, 'strategy-log-migration'));

  if (existingRows.length > 0) {
    log(`  [1] strategy-log-migration: 이미 ${existingRows.length}개 존재, 스킵`);
    return 0;
  }

  let inserted = 0;
  for (const entry of entries) {
    try {
      await db.insert(agentMemories).values({
        agent_id: 'minjun-ceo',
        scope: 'global',
        memory_type: 'decision',
        content: entry.content,
        importance: 0.8,
        source: 'strategy-log-migration',
      });
      inserted++;
      log(`      OK: ${entry.sectionTitle}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log(`      WARN: ${entry.sectionTitle} 삽입 실패 — ${msg}`);
    }
  }

  log(`  [1] agent_memories 삽입: ${inserted}/${entries.length}개`);
  return inserted;
}

// ─── 2. experiment-log.md → agent_episodes ──────────────────────────────────

interface ExperimentEntry {
  id: string;
  hypothesis: string;
  details: Record<string, unknown>;
}

function parseExperimentLog(fileContent: string): ExperimentEntry[] {
  const entries: ExperimentEntry[] = [];

  // ## EXP-YYYY-MM-DD-N 형식
  const expRegex = /^##\s+(EXP-\d{4}-\d{2}-\d{2}-\d+)\s*$/gm;
  const positions: Array<{ index: number; id: string }> = [];
  let match: RegExpExecArray | null;

  while ((match = expRegex.exec(fileContent)) !== null) {
    positions.push({ index: match.index, id: match[1] });
  }

  if (positions.length === 0) return entries;

  for (let i = 0; i < positions.length; i++) {
    const start = positions[i].index;
    const end = positions[i + 1]?.index ?? fileContent.length;
    const body = fileContent.slice(start, end);

    const hypothesisMatch = body.match(/###\s*가설\s*\n([\s\S]*?)(?=###|$)/);
    const variablesMatch = body.match(/###\s*변수\s*\n([\s\S]*?)(?=###|$)/);
    const resultMatch = body.match(/###\s*결과\s*\n([\s\S]*?)(?=###|$)/);
    const verdictMatch = body.match(/###\s*Verdict\s*\n([\s\S]*?)(?=###|$)/);

    const hypothesis = hypothesisMatch?.[1]?.trim() ?? '';
    if (!hypothesis) continue;

    const parseLines = (text: string): string[] =>
      text
        .split('\n')
        .map((l) => l.replace(/^[-*]\s*/, '').trim())
        .filter(Boolean);

    entries.push({
      id: positions[i].id,
      hypothesis,
      details: {
        experiment_id: positions[i].id,
        hypothesis,
        variables: parseLines(variablesMatch?.[1] ?? ''),
        results: parseLines(resultMatch?.[1] ?? ''),
        verdict: parseLines(verdictMatch?.[1] ?? ''),
        migrated_from: 'experiment-log.md',
      },
    });
  }

  return entries;
}

async function migrateExperimentLog(dryRun: boolean): Promise<number> {
  const filePath = path.join(MEMORY_DIR, 'experiment-log.md');
  if (!fs.existsSync(filePath)) {
    log('  [2] experiment-log.md 없음, 스킵');
    return 0;
  }

  const content = fs.readFileSync(filePath, 'utf-8');
  const entries = parseExperimentLog(content);

  if (entries.length === 0) {
    log('  [2] experiment-log.md: 기록된 실험 없음 (템플릿만 존재), 스킵');
    return 0;
  }

  log(`  [2] experiment-log.md: ${entries.length}개 실험 파싱됨`);

  if (dryRun) {
    for (const e of entries) {
      log(`      [DRY-RUN] agent_episodes <- ${e.id}: ${e.hypothesis.slice(0, 60)}`);
    }
    return entries.length;
  }

  // 멱등성 체크
  const existingRows = await db
    .select({ event_type: agentEpisodes.event_type })
    .from(agentEpisodes)
    .where(eq(agentEpisodes.agent_id, 'system'));

  const existingCount = existingRows.filter(
    (r) => r.event_type === 'experiment',
  ).length;

  if (existingCount >= entries.length) {
    log(`  [2] 이미 ${existingCount}개 존재, 스킵`);
    return 0;
  }

  let inserted = 0;
  for (const entry of entries) {
    try {
      await db.insert(agentEpisodes).values({
        agent_id: 'system',
        event_type: 'experiment',
        summary: `${entry.id}: ${entry.hypothesis}`,
        details: entry.details,
      });
      inserted++;
      log(`      OK: ${entry.id}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log(`      WARN: ${entry.id} 삽입 실패 — ${msg}`);
    }
  }

  log(`  [2] agent_episodes 삽입: ${inserted}/${entries.length}개`);
  return inserted;
}

// ─── 3. category-playbook/*.md → agent_memories ─────────────────────────────

const PLAYBOOK_AGENT_MAP: Record<string, { agentId: string; label: string }> = {
  'beauty.md':    { agentId: 'bini-beauty',       label: 'beauty' },
  'health.md':    { agentId: 'hana-health',        label: 'health' },
  'lifestyle.md': { agentId: 'sora-lifestyle',     label: 'lifestyle' },
  'diet.md':      { agentId: 'jiwoo-diet',         label: 'diet' },
};

async function migrateCategoryPlaybooks(dryRun: boolean): Promise<number> {
  const playbookDir = path.join(MEMORY_DIR, 'category-playbook');
  if (!fs.existsSync(playbookDir)) {
    log('  [3] category-playbook/ 없음, 스킵');
    return 0;
  }

  const files = fs.readdirSync(playbookDir).filter((f) => f.endsWith('.md'));
  let totalInserted = 0;

  for (const filename of files) {
    const info = PLAYBOOK_AGENT_MAP[filename];
    if (!info) {
      log(`  [3] ${filename}: 매핑 없음, 스킵`);
      continue;
    }

    const filePath = path.join(playbookDir, filename);
    const content = fs.readFileSync(filePath, 'utf-8');
    const source = `playbook-${info.label}-migration`;

    if (isTemplateOnly(content)) {
      log(`  [3] ${filename}: 빈 파일(템플릿만), 스킵`);
      continue;
    }

    log(`  [3] ${filename}: 데이터 있음 → 마이그레이션`);

    if (dryRun) {
      log(`      [DRY-RUN] agent_memories <- ${info.agentId} / scope=marketing / type=playbook`);
      totalInserted++;
      continue;
    }

    // 멱등성: 같은 source로 이미 삽입된 기록이 있으면 스킵
    const existing = await db
      .select({ id: agentMemories.id })
      .from(agentMemories)
      .where(eq(agentMemories.source, source));

    if (existing.length > 0) {
      log(`  [3] ${filename}: 이미 ${existing.length}개 존재(${source}), 스킵`);
      continue;
    }

    try {
      await db.insert(agentMemories).values({
        agent_id: info.agentId,
        scope: 'marketing',
        memory_type: 'playbook',
        content,
        importance: 0.7,
        source,
      });
      totalInserted++;
      log(`      OK: ${filename} → agent_memories (${info.agentId})`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log(`      WARN: ${filename} 삽입 실패 — ${msg}`);
    }
  }

  log(`  [3] category-playbook 삽입: ${totalInserted}개`);
  return totalInserted;
}

// ─── 4. system_state 마이그레이션 기록 ──────────────────────────────────────

async function checkAlreadyMigrated(): Promise<boolean> {
  try {
    const rows = await db
      .select({ value: systemState.value })
      .from(systemState)
      .where(eq(systemState.key, MIGRATION_KEY));
    return rows.length > 0;
  } catch {
    return false;
  }
}

async function recordMigration(
  filesMigrated: string[],
  recordsCreated: number,
): Promise<void> {
  const value = {
    completed_at: new Date().toISOString(),
    files_migrated: filesMigrated,
    records_created: recordsCreated,
  };

  try {
    await db
      .insert(systemState)
      .values({
        key: MIGRATION_KEY,
        value,
        updated_by: 'migrate-memory-to-db',
      })
      .onConflictDoUpdate({
        target: systemState.key,
        set: { value, updated_at: new Date(), updated_by: 'migrate-memory-to-db' },
      });
    log(`  [4] system_state['${MIGRATION_KEY}'] 기록 완료`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`  [4] system_state 기록 실패 — ${msg}`);
  }
}

// ─── 메인 ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  if (DRY_RUN) {
    log('=== [DRY-RUN] BiniLab 파일→DB 마이그레이션 (DB 쓰기 없음) ===\n');
  } else {
    log('=== BiniLab 파일→DB 마이그레이션 시작 ===\n');
  }

  if (!fs.existsSync(MEMORY_DIR)) {
    log(`ERROR: ${MEMORY_DIR} 디렉토리를 찾을 수 없습니다.`);
    process.exit(1);
  }

  // 중복 실행 방지
  if (!DRY_RUN) {
    const alreadyDone = await checkAlreadyMigrated();
    if (alreadyDone) {
      log(`이미 마이그레이션 완료됨 (system_state['${MIGRATION_KEY}'] 존재). 스킵.`);
      log('재실행하려면 system_state에서 해당 키를 삭제하세요.');
      process.exit(0);
    }
  }

  let totalInserted = 0;
  const filesMigrated: string[] = [];

  log('[1/3] strategy-log.md → agent_memories');
  const n1 = await migrateStrategyLog(DRY_RUN);
  if (n1 > 0) filesMigrated.push('strategy-log.md');
  totalInserted += n1;

  log('\n[2/3] experiment-log.md → agent_episodes');
  const n2 = await migrateExperimentLog(DRY_RUN);
  if (n2 > 0) filesMigrated.push('experiment-log.md');
  totalInserted += n2;

  log('\n[3/3] category-playbook/*.md → agent_memories');
  const n3 = await migrateCategoryPlaybooks(DRY_RUN);
  if (n3 > 0) filesMigrated.push('category-playbook/');
  totalInserted += n3;

  if (!DRY_RUN && totalInserted > 0) {
    log('\n[4] system_state 기록');
    await recordMigration(filesMigrated, totalInserted);
  }

  log(`\n=== 마이그레이션 ${DRY_RUN ? '[DRY-RUN] ' : ''}완료: 총 ${totalInserted}개 항목 처리 ===`);
  process.exit(0);
}

main().catch((err) => {
  console.error('마이그레이션 실패:', err);
  process.exit(1);
});
