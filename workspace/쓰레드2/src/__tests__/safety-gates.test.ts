/**
 * @file safety-gates tests — TDD RED→GREEN
 * 8개 게이트 검증: gate1~gate8 + runSafetyGates 통합 테스트
 */

import { describe, it, expect } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import * as schema from '../db/schema.js';
import {
  gate1_warmupCheck,
  gate2_lengthCheck,
  gate3_frequencyCheck,
  gate4_duplicateCheck,
  gate5_brandSafety,
  gate6_qaPassCheck,
  gate7_dailyLimitCheck,
  gate8_captchaRisk,
  runSafetyGates,
} from '../safety/gates.js';

// ─── DDL ─────────────────────────────────────────────────

const CREATE_TABLES_SQL = `
CREATE TABLE IF NOT EXISTS content_lifecycle (
  id TEXT PRIMARY KEY,
  source_post_id TEXT NOT NULL,
  source_channel_id TEXT NOT NULL,
  source_engagement REAL NOT NULL DEFAULT 0,
  source_relevance REAL NOT NULL DEFAULT 0,
  extracted_need TEXT NOT NULL,
  need_category TEXT NOT NULL,
  need_confidence REAL NOT NULL DEFAULT 0,
  matched_product_id TEXT NOT NULL,
  match_relevance REAL NOT NULL DEFAULT 0,
  content_text TEXT NOT NULL,
  content_style TEXT NOT NULL,
  hook_type TEXT NOT NULL,
  posted_account_id TEXT NOT NULL,
  posted_at TIMESTAMPTZ,
  threads_post_id TEXT,
  threads_post_url TEXT,
  maturity TEXT NOT NULL DEFAULT 'warmup',
  current_impressions INTEGER NOT NULL DEFAULT 0,
  current_clicks INTEGER NOT NULL DEFAULT 0,
  current_conversions INTEGER NOT NULL DEFAULT 0,
  current_revenue REAL NOT NULL DEFAULT 0,
  diagnosis TEXT,
  diagnosed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
`;

// ─── Per-test DB factory ─────────────────────────────────

async function createTestDb() {
  const client = new PGlite();
  await client.exec(CREATE_TABLES_SQL);
  const db = drizzle(client, { schema });
  return { client, db };
}

// ─── Helpers ─────────────────────────────────────────────

async function insertPostedEntry(
  client: PGlite,
  opts: {
    id: string;
    accountId?: string;
    postedAt?: Date | null;
    contentText?: string;
  },
) {
  const {
    id,
    accountId = 'duribeon231',
    postedAt = new Date(),
    contentText = '일반 콘텐츠 텍스트',
  } = opts;
  await client.query(
    `INSERT INTO content_lifecycle (
       id, source_post_id, source_channel_id, extracted_need,
       need_category, matched_product_id, content_text, content_style,
       hook_type, posted_account_id, posted_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [id, `src-${id}`, 'ch1', 'test need', '불편해소', 'prod-1', contentText, 'style', 'hook', accountId, postedAt],
  );
}

// ─── gate1: 워밍업 체크 ──────────────────────────────────

describe('gate1_warmupCheck()', () => {
  it('워밍업 모드 + 쿠팡 링크 → 차단', async () => {
    const { db } = await createTestDb(); // 0개 posted → warmup mode
    const result = await gate1_warmupCheck('쿠팡에서 구매하세요 https://coupang.com/...', db);
    expect(result.passed).toBe(false);
    expect(result.severity).toBe('block');
    expect(result.reason).toBeTruthy();
  });

  it('워밍업 모드 + 제휴 키워드 → 차단', async () => {
    const { db } = await createTestDb();
    const result = await gate1_warmupCheck('이 포스트는 제휴 링크를 포함합니다', db);
    expect(result.passed).toBe(false);
    expect(result.severity).toBe('block');
  });

  it('워밍업 모드 + 광고 키워드 → 차단', async () => {
    const { db } = await createTestDb();
    const result = await gate1_warmupCheck('광고 포함 콘텐츠입니다', db);
    expect(result.passed).toBe(false);
  });

  it('워밍업 모드 + 깨끗한 콘텐츠 → 통과', async () => {
    const { db } = await createTestDb();
    const result = await gate1_warmupCheck('오늘 날씨 정말 좋네요! 커피 한 잔 어떠세요?', db);
    expect(result.passed).toBe(true);
  });

  it('워밍업 해제 후 제휴 링크 → 통과', async () => {
    const { client, db } = await createTestDb();
    for (let i = 0; i < 100; i++) {
      await insertPostedEntry(client, { id: `lc-${i}` });
    }
    const result = await gate1_warmupCheck('쿠팡 파트너스 제휴 링크: https://coupang.com', db);
    expect(result.passed).toBe(true);
  });
});

// ─── gate2: 길이 체크 ────────────────────────────────────

describe('gate2_lengthCheck()', () => {
  it('501자 → 차단', () => {
    const content = 'a'.repeat(501);
    const result = gate2_lengthCheck(content);
    expect(result.passed).toBe(false);
    expect(result.severity).toBe('block');
    expect(result.reason).toBeTruthy();
  });

  it('500자 → 통과', () => {
    const content = 'a'.repeat(500);
    const result = gate2_lengthCheck(content);
    expect(result.passed).toBe(true);
  });

  it('200자 이하 → 통과', () => {
    const content = 'a'.repeat(200);
    const result = gate2_lengthCheck(content);
    expect(result.passed).toBe(true);
  });

  it('빈 문자열 → 통과', () => {
    const result = gate2_lengthCheck('');
    expect(result.passed).toBe(true);
  });
});

// ─── gate3: 빈도 체크 (DB) ───────────────────────────────

describe('gate3_frequencyCheck()', () => {
  it('게시 이력 없음 → 통과', async () => {
    const { db } = await createTestDb();
    const result = await gate3_frequencyCheck('acc1', db);
    expect(result.passed).toBe(true);
  });

  it('마지막 게시 30분 전 → 차단', async () => {
    const { client, db } = await createTestDb();
    const thirtyMinsAgo = new Date(Date.now() - 30 * 60 * 1000);
    await insertPostedEntry(client, { id: 'recent', accountId: 'acc1', postedAt: thirtyMinsAgo });
    const result = await gate3_frequencyCheck('acc1', db);
    expect(result.passed).toBe(false);
    expect(result.severity).toBe('block');
  });

  it('마지막 게시 90분 전 → 통과', async () => {
    const { client, db } = await createTestDb();
    const ninetyMinsAgo = new Date(Date.now() - 90 * 60 * 1000);
    await insertPostedEntry(client, { id: 'old', accountId: 'acc1', postedAt: ninetyMinsAgo });
    const result = await gate3_frequencyCheck('acc1', db);
    expect(result.passed).toBe(true);
  });

  it('다른 계정 기록은 영향 없음', async () => {
    const { client, db } = await createTestDb();
    const fiveMinsAgo = new Date(Date.now() - 5 * 60 * 1000);
    await insertPostedEntry(client, { id: 'other', accountId: 'other_acc', postedAt: fiveMinsAgo });
    const result = await gate3_frequencyCheck('acc1', db);
    expect(result.passed).toBe(true); // acc1은 게시 이력 없음
  });
});

// ─── gate4: 중복 체크 ────────────────────────────────────

describe('gate4_duplicateCheck()', () => {
  it('동일 텍스트 → 차단 (유사도 > 0.8)', () => {
    const text = '선크림 제대로 바르고 있어? 피부과 의사가 알려준 올바른 선크림 사용법';
    const result = gate4_duplicateCheck(text, [text]);
    expect(result.passed).toBe(false);
    expect(result.severity).toBe('block');
  });

  it('거의 동일한 텍스트 → 차단', () => {
    const text1 = '선크림 제대로 바르고 있어? 피부과 의사가 알려준 올바른 선크림 사용법이에요';
    const text2 = '선크림 제대로 바르고 있어? 피부과 의사가 알려준 올바른 선크림 사용법입니다';
    const result = gate4_duplicateCheck(text1, [text2]);
    expect(result.passed).toBe(false);
  });

  it('완전히 다른 텍스트 → 통과', () => {
    const newText = '요즘 영양제 뭐 드세요? 오메가3 효능 정리해봤어요';
    const recentTexts = ['선크림 사용법', '피부 관리 루틴'];
    const result = gate4_duplicateCheck(newText, recentTexts);
    expect(result.passed).toBe(true);
  });

  it('최근 게시 이력 없음 → 통과', () => {
    const result = gate4_duplicateCheck('새로운 콘텐츠입니다', []);
    expect(result.passed).toBe(true);
  });
});

// ─── gate5: 브랜드 안전 ──────────────────────────────────

describe('gate5_brandSafety()', () => {
  it('욕설 포함 → 차단', () => {
    const result = gate5_brandSafety('이 제품 씨발 너무 별로야');
    expect(result.passed).toBe(false);
    expect(result.severity).toBe('block');
  });

  it('정치 키워드 포함 → 차단', () => {
    const result = gate5_brandSafety('선거철에 추천하는 영양제');
    expect(result.passed).toBe(false);
  });

  it('대통령 언급 → 차단', () => {
    const result = gate5_brandSafety('대통령도 먹는다는 건강식품');
    expect(result.passed).toBe(false);
  });

  it('경쟁사 비방 → 차단', () => {
    const result = gate5_brandSafety('올리브영 vs 다이소 비방 내용');
    expect(result.passed).toBe(false);
  });

  it('깨끗한 콘텐츠 → 통과', () => {
    const result = gate5_brandSafety('오늘 소개할 선크림은 SPF50+ 제품이에요. 자세히 알아볼게요.');
    expect(result.passed).toBe(true);
    expect(result.reason).toBeUndefined();
  });
});

// ─── gate6: QA 점수 체크 ─────────────────────────────────

describe('gate6_qaPassCheck()', () => {
  it('QA 점수 9 → 차단', () => {
    const result = gate6_qaPassCheck(9);
    expect(result.passed).toBe(false);
    expect(result.severity).toBe('block');
    expect(result.reason).toBeTruthy();
  });

  it('QA 점수 0 → 차단', () => {
    const result = gate6_qaPassCheck(0);
    expect(result.passed).toBe(false);
  });

  it('QA 점수 10 → 통과', () => {
    const result = gate6_qaPassCheck(10);
    expect(result.passed).toBe(true);
  });

  it('QA 점수 15 → 통과', () => {
    const result = gate6_qaPassCheck(15);
    expect(result.passed).toBe(true);
  });
});

// ─── gate7: 일일 한도 체크 (DB) ──────────────────────────

describe('gate7_dailyLimitCheck()', () => {
  it('오늘 0개 게시 → 통과', async () => {
    const { db } = await createTestDb();
    const result = await gate7_dailyLimitCheck('acc1', db);
    expect(result.passed).toBe(true);
  });

  it('오늘 9개 게시 → 통과', async () => {
    const { client, db } = await createTestDb();
    for (let i = 0; i < 9; i++) {
      await insertPostedEntry(client, { id: `p-${i}`, accountId: 'acc1', postedAt: new Date() });
    }
    const result = await gate7_dailyLimitCheck('acc1', db);
    expect(result.passed).toBe(true);
  });

  it('오늘 10개 게시 → 차단', async () => {
    const { client, db } = await createTestDb();
    for (let i = 0; i < 10; i++) {
      await insertPostedEntry(client, { id: `p-${i}`, accountId: 'acc1', postedAt: new Date() });
    }
    const result = await gate7_dailyLimitCheck('acc1', db);
    expect(result.passed).toBe(false);
    expect(result.severity).toBe('block');
  });

  it('어제 게시는 카운트 제외', async () => {
    const { client, db } = await createTestDb();
    const yesterday = new Date(Date.now() - 25 * 60 * 60 * 1000);
    for (let i = 0; i < 10; i++) {
      await insertPostedEntry(client, { id: `y-${i}`, accountId: 'acc1', postedAt: yesterday });
    }
    const result = await gate7_dailyLimitCheck('acc1', db);
    expect(result.passed).toBe(true);
  });
});

// ─── gate8: 캡차 위험 체크 (DB, severity=warn) ───────────

describe('gate8_captchaRisk()', () => {
  it('게시 이력 2개 이하 → 통과', async () => {
    const { client, db } = await createTestDb();
    await insertPostedEntry(client, { id: 'p1', accountId: 'acc1', postedAt: new Date() });
    await insertPostedEntry(client, { id: 'p2', accountId: 'acc1', postedAt: new Date(Date.now() - 3 * 60 * 1000) });
    const result = await gate8_captchaRisk('acc1', db);
    expect(result.passed).toBe(true);
  });

  it('연속 3개 게시 간격 < 10분 → 경고(warn)', async () => {
    const { client, db } = await createTestDb();
    const now = Date.now();
    await insertPostedEntry(client, { id: 'p1', accountId: 'acc1', postedAt: new Date(now) });
    await insertPostedEntry(client, { id: 'p2', accountId: 'acc1', postedAt: new Date(now - 5 * 60 * 1000) });
    await insertPostedEntry(client, { id: 'p3', accountId: 'acc1', postedAt: new Date(now - 9 * 60 * 1000) });
    const result = await gate8_captchaRisk('acc1', db);
    expect(result.passed).toBe(false);
    expect(result.severity).toBe('warn'); // warn, not block
  });

  it('간격 > 10분 → 통과', async () => {
    const { client, db } = await createTestDb();
    const now = Date.now();
    await insertPostedEntry(client, { id: 'p1', accountId: 'acc1', postedAt: new Date(now) });
    await insertPostedEntry(client, { id: 'p2', accountId: 'acc1', postedAt: new Date(now - 15 * 60 * 1000) });
    await insertPostedEntry(client, { id: 'p3', accountId: 'acc1', postedAt: new Date(now - 30 * 60 * 1000) });
    const result = await gate8_captchaRisk('acc1', db);
    expect(result.passed).toBe(true);
  });
});

// ─── runSafetyGates 통합 ─────────────────────────────────

describe('runSafetyGates()', () => {
  it('모든 게이트 통과 → allPassed: true', async () => {
    const { client, db } = await createTestDb();
    // 100개 이상 게시 → 워밍업 해제 (200h+ ago: gate3/gate7 미영향)
    for (let i = 0; i < 100; i++) {
      await insertPostedEntry(client, { id: `lc-${i}`, postedAt: new Date(Date.now() - (i + 200) * 60 * 60 * 1000) });
    }
    const report = await runSafetyGates('깨끗한 콘텐츠 텍스트입니다.', 'duribeon231', 10, db);
    expect(report.allPassed).toBe(true);
    expect(report.blockers).toHaveLength(0);
  });

  it('워밍업 + 제휴링크 → allPassed: false, blockers에 gate1', async () => {
    const { db } = await createTestDb(); // 0개 → warmup mode
    const report = await runSafetyGates('쿠팡 제휴 링크 있어요', 'duribeon231', 10, db);
    expect(report.allPassed).toBe(false);
    expect(report.blockers.some(r => r.gate === 'gate1_warmupCheck')).toBe(true);
  });

  it('500자 초과 → allPassed: false, blockers에 gate2', async () => {
    const { db } = await createTestDb();
    const longContent = 'a'.repeat(501);
    const report = await runSafetyGates(longContent, 'acc1', 10, db);
    expect(report.allPassed).toBe(false);
    expect(report.blockers.some(r => r.gate === 'gate2_lengthCheck')).toBe(true);
  });

  it('gate8 경고만 → allPassed: true (warn은 차단 아님)', async () => {
    const { client, db } = await createTestDb();
    // 100개 게시 → 워밍업 해제 (200h+ ago: gate7/gate3 미영향)
    for (let i = 0; i < 100; i++) {
      await insertPostedEntry(client, { id: `lc-${i}`, postedAt: new Date(Date.now() - (i + 200) * 60 * 60 * 1000) });
    }
    // 연속 3개 게시 61~69분 전: gate3 통과(61min≥60min) + gate8 경고(간격 4min<10min)
    const now = Date.now();
    await insertPostedEntry(client, { id: 'recent1', accountId: 'duribeon231', postedAt: new Date(now - 61 * 60 * 1000) });
    await insertPostedEntry(client, { id: 'recent2', accountId: 'duribeon231', postedAt: new Date(now - 65 * 60 * 1000) });
    await insertPostedEntry(client, { id: 'recent3', accountId: 'duribeon231', postedAt: new Date(now - 69 * 60 * 1000) });
    const report = await runSafetyGates('깨끗한 콘텐츠', 'duribeon231', 10, db);
    expect(report.warnings.some(r => r.gate === 'gate8_captchaRisk')).toBe(true);
    expect(report.blockers).toHaveLength(0);
    expect(report.allPassed).toBe(true); // warn은 차단 아님
  });

  it('results 배열에 9개 게이트 결과 포함', async () => {
    const { db } = await createTestDb();
    const report = await runSafetyGates('테스트 콘텐츠', 'acc1', 10, db);
    expect(report.results).toHaveLength(9);
  });
});

// ─── gate_toneCheck in runSafetyGates ────────────────────

describe('gate_toneCheck in runSafetyGates()', () => {
  it('전문가 용어(나이아신아마이드) 포함 → allPassed: false, blockers에 gate_toneCheck', async () => {
    const { db } = await createTestDb();
    const report = await runSafetyGates('나이아신아마이드 함유 크림 추천드려요', 'acc1', 10, db);
    expect(report.allPassed).toBe(false);
    expect(report.blockers.some(r => r.gate === 'gate_toneCheck')).toBe(true);
  });

  it('일반 비전문가 콘텐츠 → gate_toneCheck 통과', async () => {
    const { client, db } = await createTestDb();
    // 워밍업 해제 (100개 이상)
    for (let i = 0; i < 100; i++) {
      await insertPostedEntry(client, { id: `lc-${i}`, postedAt: new Date(Date.now() - (i + 200) * 60 * 60 * 1000) });
    }
    const report = await runSafetyGates('피부가 촉촉해지는 느낌이에요', 'duribeon231', 10, db);
    expect(report.blockers.some(r => r.gate === 'gate_toneCheck')).toBe(false);
  });
});
