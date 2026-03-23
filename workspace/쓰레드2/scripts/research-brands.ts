#!/usr/bin/env tsx
/**
 * research-brands.ts — 브랜드 리서치 배치 관리
 *
 * DB에서 브랜드 목록을 읽어 리서치할 배치를 출력.
 * 실제 웹 검색/이벤트 추출은 Claude Code 에이전트(brand-researcher.md)가 수행.
 *
 * Usage:
 *   npm run research:brands -- --dry-run
 *   npm run research:brands -- --category 뷰티
 *   npm run research:brands -- --category 건강 --max-per-category 80
 *   npm run research:brands -- --seeds               # brand-seeds.json에서 미등록 브랜드 추가
 *   npm run research:brands -- --seeds --dry-run     # 추가될 브랜드만 미리 확인
 *   npm run research:brands -- --brand brand_anua    # 특정 브랜드만
 */

import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { db } from '../src/db/index.js';
import { brands } from '../src/db/schema.js';
import { eq, and, isNull, lt, or, sql } from 'drizzle-orm';

// ─── Constants ───────────────────────────────────────────

const SEEDS_PATH = path.join(process.cwd(), 'data', 'brand-seeds.json');
const BATCH_SIZE = 5;
const DEFAULT_MAX_PER_CATEGORY = 80;

const VALID_CATEGORIES = ['뷰티', '건강', '생활', '다이어트'] as const;
type Category = typeof VALID_CATEGORIES[number];

// ─── Types ───────────────────────────────────────────────

interface CliOptions {
  category: Category | null;
  maxPerCategory: number;
  brandId: string | null;
  seeds: boolean;
  dryRun: boolean;
}

interface BrandRow {
  brand_id: string;
  name: string;
  category: string;
  last_researched_at: Date | null;
  last_research_status: string | null;
  is_active: boolean;
}

// ─── Logging ─────────────────────────────────────────────

function log(msg: string): void {
  console.log(msg);
}

// ─── CLI ─────────────────────────────────────────────────

function parseCliArgs(): CliOptions {
  const args = process.argv.slice(2);
  let category: Category | null = null;
  let maxPerCategory = DEFAULT_MAX_PER_CATEGORY;
  let brandId: string | null = null;
  let seeds = false;
  let dryRun = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--category' && args[i + 1]) {
      const cat = args[i + 1] as Category;
      if (!VALID_CATEGORIES.includes(cat)) {
        console.error(`오류: 유효하지 않은 카테고리 "${cat}". 가능한 값: ${VALID_CATEGORIES.join(', ')}`);
        process.exit(1);
      }
      category = cat;
      i++;
    } else if (args[i] === '--max-per-category' && args[i + 1]) {
      maxPerCategory = parseInt(args[i + 1], 10) || DEFAULT_MAX_PER_CATEGORY;
      i++;
    } else if (args[i] === '--brand' && args[i + 1]) {
      brandId = args[i + 1];
      i++;
    } else if (args[i] === '--seeds') {
      seeds = true;
    } else if (args[i] === '--dry-run') {
      dryRun = true;
    }
  }

  return { category, maxPerCategory, brandId, seeds, dryRun };
}

// ─── Brand ID Generation ──────────────────────────────────

function makeBrandId(name: string): string {
  // 한글→로마자 간단 변환 (핵심 단어만)
  const romanMap: Record<string, string> = {
    '이니스프리': 'innisfree', '에뛰드': 'etude', '미샤': 'missha', '토니모리': 'tonymoly',
    '라네즈': 'laneige', '설화수': 'sulwhasoo', '헤라': 'hera', '더페이스샵': 'thefaceshop',
    '네이처리퍼블릭': 'naturepublic', '에스티로더': 'esteelauder', '시세이도': 'shiseido',
    '맥': 'mac', '바비브라운': 'bobbibrown', '클리니크': 'clinique', '키엘': 'kiehl',
    '아이오페': 'iope', 'AHC': 'ahc', '닥터지': 'drg', '코스알엑스': 'cosrx',
    '라운드랩': 'roundlab', '아누아': 'anua', '토리든': 'torriden', '넘버즈인': 'numbersin',
    '달바': 'dalba', 'VT': 'vt', '메디힐': 'mediheal', 'JM솔루션': 'jmsolution',
    '셀퓨전씨': 'cellfusionc', 'CNP': 'cnp', '피지오겔': 'physiogel',
    '종근당': 'jongkwang', '일동제약': 'ildong', '뉴트리원': 'nutrione', 'GNC': 'gnc',
    '마이프로틴': 'myprotein', '얼라이브': 'alive', '센트룸': 'centrum', '솔가': 'solgar',
    '네이처메이드': 'naturemade', '닥터린': 'doctorlin', '한미약품': 'hanmi',
    '대웅제약': 'daewoong', '유한양행': 'yuhan', '동국제약': 'dongkook',
    'JW중외제약': 'jwjungwae', '녹십자': 'greencross', '안국약품': 'ankook',
    '경남제약': 'gyeongnam', '고려은단': 'koryeoeundan', '비타민하우스': 'vitaminhouse',
    '다이슨': 'dyson', '샤오미': 'xiaomi', 'LG생활건강': 'lghhc', '애경': 'aekyung',
    '피죤': 'pigeon', '무인양품': 'muji', '이케아': 'ikea', '다이소': 'daiso',
    '락앤락': 'locknlock', '코렐': 'corelle', '글래드': 'glad', '3M': '3m',
    '한샘': 'hanssem', '오늘의집': 'ohouse', '크리넥스': 'kleenex', '좋은느낌': 'joeunnukim',
    '쏘피': 'sofy', '깨끗한나라': 'cleanara', '테팔': 'tefal', '필립스': 'philips',
    '랭킹닭컴': 'rankingdak', '맛있닭': 'masitdak', '아임닭': 'imdak',
    '교촌닭가슴살': 'kyochon', 'CJ비비고': 'bibigo', '풀무원': 'pulmuone',
    '올가니카': 'organica', '곤약팜': 'konjakfarm', '프로틴킹': 'proteinkg',
    '바디닭': 'bodydak', '더미식': 'themisik', '밀스': 'mills', '다노': 'dano',
    '파이토웨이': 'phytowei', 'GNM자연의품격': 'gnm', '닥터유': 'dru',
    '뉴트리디데이': 'nutridday', '칼로바이': 'calorbie', '몸신': 'momshin', '잇메이트': 'eatmate',
  };

  const slug = romanMap[name] || name
    .toLowerCase()
    .replace(/[^a-z0-9가-힣]/g, '')
    .replace(/\s+/g, '_')
    .slice(0, 20);

  return `brand_${slug}`;
}

// ─── Seeds: Add Missing Brands ───────────────────────────

async function addSeedBrands(opts: CliOptions): Promise<number> {
  if (!fs.existsSync(SEEDS_PATH)) {
    log(`[SEEDS] brand-seeds.json 없음: ${SEEDS_PATH}`);
    return 0;
  }

  const seeds: Record<string, string[]> = JSON.parse(fs.readFileSync(SEEDS_PATH, 'utf-8'));

  // Fetch existing brand names
  const existing = await db.select({ name: brands.name }).from(brands);
  const existingNames = new Set(existing.map(r => r.name));

  let totalAdded = 0;

  const categories = opts.category ? [opts.category] : VALID_CATEGORIES;

  for (const cat of categories) {
    const seedList = seeds[cat] ?? [];
    const missing = seedList.filter(name => !existingNames.has(name));

    if (missing.length === 0) {
      log(`[SEEDS] ${cat}: 신규 브랜드 없음`);
      continue;
    }

    // Count existing brands in this category
    const [countRow] = await db.execute(
      sql`SELECT count(*) as cnt FROM brands WHERE category = ${cat} AND is_active = true`
    ) as Array<{ cnt: string }>;
    const currentCount = parseInt(countRow.cnt, 10) || 0;
    const canAdd = Math.max(0, opts.maxPerCategory - currentCount);

    const toAdd = missing.slice(0, canAdd);
    const skipped = missing.length - toAdd.length;

    log(`[SEEDS] ${cat}: 기존 ${currentCount}개, 추가 예정 ${toAdd.length}개${skipped > 0 ? `, 한도 초과 스킵 ${skipped}개` : ''}`);

    if (toAdd.length === 0) continue;

    if (opts.dryRun) {
      for (const name of toAdd) {
        log(`  [DRY-RUN] 추가 예정: ${name} (${makeBrandId(name)})`);
      }
      continue;
    }

    // Insert missing brands
    const defaultTemplates = ['{name} 신제품', '{name} 할인', '{name} 이벤트', '{name} 추천'];

    for (const name of toAdd) {
      const brand_id = makeBrandId(name);
      try {
        await db.insert(brands).values({
          brand_id,
          name,
          category: cat,
          search_keywords: [name],
          search_templates: defaultTemplates,
          is_active: true,
          priority: 0,
        }).onConflictDoNothing();
        log(`  [SEEDS] 추가: ${name} → ${brand_id}`);
        totalAdded++;
      } catch (err) {
        log(`  [SEEDS] 실패: ${name} — ${(err as Error).message}`);
      }
    }
  }

  return totalAdded;
}

// ─── List Brands for Research ─────────────────────────────

async function listBrandsForResearch(opts: CliOptions): Promise<BrandRow[]> {
  const conditions = [eq(brands.is_active, true)];

  if (opts.brandId) {
    conditions.push(eq(brands.brand_id, opts.brandId));
  } else if (opts.category) {
    conditions.push(eq(brands.category, opts.category));
  }

  const rows = await db
    .select({
      brand_id: brands.brand_id,
      name: brands.name,
      category: brands.category,
      last_researched_at: brands.last_researched_at,
      last_research_status: brands.last_research_status,
      is_active: brands.is_active,
    })
    .from(brands)
    .where(and(...conditions))
    .orderBy(
      // Prioritize: never researched first, then oldest researched
      sql`last_researched_at ASC NULLS FIRST`,
      brands.priority,
    );

  // Apply per-category limit (when no specific brandId)
  if (!opts.brandId) {
    const perCat: Record<string, BrandRow[]> = {};
    for (const row of rows) {
      if (!perCat[row.category]) perCat[row.category] = [];
      if (perCat[row.category].length < opts.maxPerCategory) {
        perCat[row.category].push(row as BrandRow);
      }
    }
    return Object.values(perCat).flat();
  }

  return rows as BrandRow[];
}

// ─── Main ─────────────────────────────────────────────────

async function main(): Promise<void> {
  const opts = parseCliArgs();

  log('=== 브랜드 리서치 배치 준비 ===');
  log(`카테고리: ${opts.category ?? '전체'} | 카테고리당 최대: ${opts.maxPerCategory}개`);
  if (opts.dryRun) log('[DRY-RUN 모드]');

  // 1. Add seeds if requested
  if (opts.seeds) {
    log('\n── 시드 브랜드 추가 ──');
    const added = await addSeedBrands(opts);
    if (!opts.dryRun) log(`시드 추가 완료: ${added}개`);
  }

  // 2. List brands to research
  log('\n── 리서치 대상 브랜드 ──');
  const rows = await listBrandsForResearch(opts);

  if (rows.length === 0) {
    log('리서치할 브랜드가 없습니다.');
    process.exit(0);
  }

  // Group by category for display
  const byCategory: Record<string, BrandRow[]> = {};
  for (const row of rows) {
    if (!byCategory[row.category]) byCategory[row.category] = [];
    byCategory[row.category].push(row);
  }

  for (const [cat, catRows] of Object.entries(byCategory)) {
    log(`\n[${cat}] ${catRows.length}개`);
    const batches = Math.ceil(catRows.length / BATCH_SIZE);
    for (let b = 0; b < batches; b++) {
      const batch = catRows.slice(b * BATCH_SIZE, (b + 1) * BATCH_SIZE);
      const names = batch.map(r => r.name).join(', ');
      const neverResearched = batch.filter(r => !r.last_researched_at).length;
      log(`  배치 ${b + 1}/${batches}: [${names}]${neverResearched > 0 ? ` (미조사 ${neverResearched}개)` : ''}`);
    }
  }

  log(`\n총 ${rows.length}개 브랜드, ${Math.ceil(rows.length / BATCH_SIZE)}개 배치`);
  log('\n실행: npm run research:brands -- --category <카테고리>');
  log('에이전트 실행: src/agents/brand-researcher.md 참조');

  process.exit(0);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
