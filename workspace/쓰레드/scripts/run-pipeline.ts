#!/usr/bin/env tsx
/**
 * run-pipeline.ts — P1 오케스트레이터
 *
 * 전체 분석 파이프라인을 순차 실행:
 *   normalize → researcher → needs-detector
 *
 * Usage:
 *   tsx scripts/run-pipeline.ts                  # 전체 파이프라인
 *   tsx scripts/run-pipeline.ts --research-only  # normalize + researcher만
 *   tsx scripts/run-pipeline.ts --prompt         # LLM 프롬프트도 생성
 *   tsx scripts/run-pipeline.ts --brief          # 사람 읽기용 브리핑 출력
 */

import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

const SCRIPTS_DIR = __dirname;
const BRIEFS_DIR = path.join(__dirname, '..', 'data', 'briefs');

function run(cmd: string, label: string): boolean {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`▶ ${label}`);
  console.log(`${'='.repeat(60)}`);
  try {
    const output = execSync(cmd, { cwd: path.join(__dirname, '..'), encoding: 'utf8', stdio: 'pipe' });
    console.log(output);
    return true;
  } catch (err) {
    console.error(`✗ ${label} failed:`);
    console.error((err as { stderr?: string; message: string }).stderr || (err as Error).message);
    return false;
  }
}

interface ResearchData {
  posts_analyzed: number;
  purchase_signals: unknown[];
  purchase_signals_non_affiliate?: unknown[];
  emerging_topics?: Array<{ keyword: string }>;
  declining_topics?: Array<{ keyword: string }>;
  engagement_summary: { views: { avg: number }; likes: { avg: number } };
  meta: { taxonomy_version: string; schema_version: string };
}

interface NeedsData {
  needs_map: Array<{
    category: string;
    problem: string;
    post_count: number;
    signal_strength: string | null;
    representative_expressions: string[];
  }>;
}

function generateBrief(today: string): void {
  const researchPath = path.join(BRIEFS_DIR, `${today}_research.json`);
  const needsPath = path.join(BRIEFS_DIR, `${today}_needs.json`);

  let research: ResearchData;
  let needs: NeedsData;
  try {
    research = JSON.parse(fs.readFileSync(researchPath, 'utf8'));
    needs = JSON.parse(fs.readFileSync(needsPath, 'utf8'));
  } catch {
    console.log('Cannot generate brief: missing research or needs data.');
    return;
  }

  const lines: string[] = [];
  lines.push(`[${today} 니즈 브리핑]\n`);

  lines.push('■ 오늘 뜨는 문제 TOP 5');
  lines.push('─'.repeat(40));
  const topNeeds = needs.needs_map.slice(0, 5);
  topNeeds.forEach((n, i) => {
    const trend = research.emerging_topics?.find(t => t.keyword.includes(n.category)) ? '↑' : '→';
    lines.push(`${i + 1}. ${n.category}: ${n.problem} (${n.post_count}건, ${n.signal_strength || 'N/A'}) ${trend}`);
    if (n.representative_expressions[0]) {
      lines.push(`   "${n.representative_expressions[0]}"`);
    }
  });

  lines.push('\n■ 주목할 구매 신호');
  lines.push('─'.repeat(40));
  const topSignals = (research.purchase_signals as Array<{ text: string; signal_level: string; post_id: string }>)
    .filter(s => ['L3', 'L4', 'L5'].includes(s.signal_level))
    .slice(0, 5);
  if (topSignals.length > 0) {
    for (const s of topSignals) {
      lines.push(`- "${s.text.slice(0, 80)}" (${s.signal_level}) [${s.post_id}]`);
    }
  } else {
    const anySignals = (research.purchase_signals as Array<{ text: string; signal_level: string; post_id: string }>).slice(0, 3);
    for (const s of anySignals) {
      lines.push(`- "${s.text.slice(0, 80)}" (${s.signal_level}) [${s.post_id}]`);
    }
  }

  const nonAffSignals = (research.purchase_signals_non_affiliate || []) as Array<{ text: string; signal_level: string; post_id: string }>;
  if (nonAffSignals.length > 0) {
    lines.push('\n■ 소비자 직접 구매 신호 (비광고)');
    lines.push('─'.repeat(40));
    for (const s of nonAffSignals.slice(0, 5)) {
      lines.push(`- "${s.text.slice(0, 80)}" (${s.signal_level}) [${s.post_id}]`);
    }
  }

  lines.push('\n■ 트렌드');
  lines.push('─'.repeat(40));
  const emerging = research.emerging_topics?.slice(0, 3) || [];
  const declining = research.declining_topics?.slice(0, 3) || [];
  if (emerging.length) lines.push(`  뜨는: ${emerging.map(t => t.keyword).join(', ')}`);
  if (declining.length) lines.push(`  지는: ${declining.map(t => t.keyword).join(', ')}`);

  lines.push('\n■ 메타');
  lines.push('─'.repeat(40));
  lines.push(`- 분석 포스트: ${research.posts_analyzed}개`);
  lines.push(`- 구매신호: ${research.purchase_signals.length}건 (비광고: ${nonAffSignals.length}건)`);
  lines.push(`- 니즈 카테고리: ${needs.needs_map.length}개`);
  lines.push(`- 참여도: 평균 조회 ${research.engagement_summary.views.avg}, 좋아요 ${research.engagement_summary.likes.avg}`);
  lines.push(`- taxonomy: v${research.meta.taxonomy_version}, schema: v${research.meta.schema_version}`);

  const briefText = lines.join('\n');

  const briefPath = path.join(BRIEFS_DIR, `${today}_brief.md`);
  fs.writeFileSync(briefPath, briefText, 'utf8');
  console.log(`\n${'='.repeat(60)}`);
  console.log(`📋 니즈 브리핑`);
  console.log(`${'='.repeat(60)}`);
  console.log(briefText);
  console.log(`\nSaved: ${briefPath}`);
}

function main(): void {
  const args = process.argv.slice(2);
  const researchOnly = args.includes('--research-only');
  const withPrompt = args.includes('--prompt');
  const withBrief = args.includes('--brief');

  const promptFlag = withPrompt ? ' --prompt' : '';
  const today = new Date().toISOString().slice(0, 10);

  console.log(`Pipeline start: ${new Date().toISOString()}`);

  // Step 1: Normalize
  const ok1 = run(
    `npx tsx ${path.join(SCRIPTS_DIR, 'normalize-posts.ts')}`,
    'Step 1: normalize-posts (raw → canonical)'
  );
  if (!ok1) { process.exit(1); }

  // Step 2: Researcher
  const ok2 = run(
    `npx tsx ${path.join(SCRIPTS_DIR, 'researcher.ts')}${promptFlag}`,
    'Step 2: researcher (canonical → research brief)'
  );
  if (!ok2) { process.exit(1); }

  if (researchOnly) {
    console.log('\n--research-only: stopping after researcher.');
    if (withBrief) generateBrief(today);
    process.exit(0);
  }

  // Step 3: Needs detector
  const ok3 = run(
    `npx tsx ${path.join(SCRIPTS_DIR, 'needs-detector.ts')}${promptFlag}`,
    'Step 3: needs-detector (research → needs map)'
  );
  if (!ok3) { process.exit(1); }

  if (withBrief) {
    generateBrief(today);
  }

  console.log(`\nPipeline complete: ${new Date().toISOString()}`);
  console.log(`\nOutputs:`);
  console.log(`  Canonical: data/canonical/posts.json`);
  console.log(`  Research:  data/briefs/${today}_research.json`);
  console.log(`  Needs:     data/briefs/${today}_needs.json`);
  if (withBrief) console.log(`  Brief:     data/briefs/${today}_brief.md`);
  if (withPrompt) {
    console.log(`  Prompts:   data/briefs/${today}_researcher_prompt.txt`);
    console.log(`             data/briefs/${today}_needs_prompt.txt`);
  }
}

main();
