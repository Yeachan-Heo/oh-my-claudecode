/**
 * @file warmup-gate unit tests — TDD RED→GREEN
 * Tests isWarmupMode(), validateContent(), getWarmupProgress() using PGlite in-memory.
 */

import { describe, it, expect } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import * as schema from '../db/schema.js';
import {
  isWarmupMode,
  validateContent,
  getWarmupProgress,
} from '../utils/warmup-gate.js';

// ─── DDL ─────────────────────────────────────────────────

const CREATE_TABLES_SQL = `
CREATE TABLE IF NOT EXISTS aff_contents (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL,
  product_name TEXT NOT NULL,
  need_id TEXT NOT NULL,
  format TEXT NOT NULL,
  hook TEXT NOT NULL,
  bodies JSONB NOT NULL DEFAULT '[]',
  hooks JSONB NOT NULL DEFAULT '[]',
  self_comments JSONB NOT NULL DEFAULT '[]',
  status TEXT DEFAULT 'draft',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

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

async function insertPostedEntry(client: PGlite, id: string, postedAt: Date | null = new Date()) {
  await client.query(
    `INSERT INTO content_lifecycle (
       id, source_post_id, source_channel_id, extracted_need,
       need_category, matched_product_id, content_text, content_style,
       hook_type, posted_account_id, posted_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [id, `src-${id}`, 'ch1', 'test need', '불편해소', 'prod-1', 'content', 'style', 'hook', 'duribeon231', postedAt]
  );
}

// ─── aff_contents.status column ──────────────────────────

describe('aff_contents.status column', () => {
  it('defaults to "draft" when not specified', async () => {
    const { client } = await createTestDb();
    await client.query(
      `INSERT INTO aff_contents (id, product_id, product_name, need_id, format, hook)
       VALUES ('c1', 'p1', '테스트상품', 'n1', '문제공감형', '훅텍스트')`
    );
    const result = await client.query<{ status: string }>(
      `SELECT status FROM aff_contents WHERE id = 'c1'`
    );
    expect(result.rows[0].status).toBe('draft');
  });

  it('accepts explicit status value', async () => {
    const { client } = await createTestDb();
    await client.query(
      `INSERT INTO aff_contents (id, product_id, product_name, need_id, format, hook, status)
       VALUES ('c2', 'p1', '테스트상품', 'n1', '문제공감형', '훅텍스트', 'published')`
    );
    const result = await client.query<{ status: string }>(
      `SELECT status FROM aff_contents WHERE id = 'c2'`
    );
    expect(result.rows[0].status).toBe('published');
  });
});

// ─── isWarmupMode() ──────────────────────────────────────

describe('isWarmupMode()', () => {
  it('returns true when posted count is 0 (< 100)', async () => {
    const { db } = await createTestDb();
    const result = await isWarmupMode(db);
    expect(result).toBe(true);
  });

  it('returns true when posted count is 50 (< 100)', async () => {
    const { client, db } = await createTestDb();
    for (let i = 0; i < 50; i++) {
      await insertPostedEntry(client, `lc-${i}`);
    }
    const result = await isWarmupMode(db);
    expect(result).toBe(true);
  });

  it('returns false when posted count is exactly 100', async () => {
    const { client, db } = await createTestDb();
    for (let i = 0; i < 100; i++) {
      await insertPostedEntry(client, `lc-${i}`);
    }
    const result = await isWarmupMode(db);
    expect(result).toBe(false);
  });

  it('returns false when posted count exceeds 100', async () => {
    const { client, db } = await createTestDb();
    for (let i = 0; i < 120; i++) {
      await insertPostedEntry(client, `lc-${i}`);
    }
    const result = await isWarmupMode(db);
    expect(result).toBe(false);
  });

  it('ignores entries where posted_at IS NULL', async () => {
    const { client, db } = await createTestDb();
    // Insert 99 entries without posted_at (not published)
    for (let i = 0; i < 99; i++) {
      await insertPostedEntry(client, `lc-${i}`, null);
    }
    const result = await isWarmupMode(db);
    expect(result).toBe(true);
  });

  it('only counts entries for duribeon231 account', async () => {
    const { client, db } = await createTestDb();
    // Insert 200 entries for a different account
    for (let i = 0; i < 200; i++) {
      await client.query(
        `INSERT INTO content_lifecycle (
           id, source_post_id, source_channel_id, extracted_need,
           need_category, matched_product_id, content_text, content_style,
           hook_type, posted_account_id, posted_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW())`,
        [`other-${i}`, `src-${i}`, 'ch1', 'need', '불편해소', 'p1', 'c', 's', 'h', 'other_account']
      );
    }
    const result = await isWarmupMode(db);
    expect(result).toBe(true); // duribeon231 still has 0
  });
});

// ─── validateContent() ───────────────────────────────────

describe('validateContent()', () => {
  it('rejects content with 쿠팡 in warmup mode', () => {
    const result = validateContent('쿠팡에서 구매하세요', true);
    expect(result.valid).toBe(false);
    expect(result.reason).toBeTruthy();
  });

  it('rejects content with coupang in warmup mode', () => {
    const result = validateContent('Buy from coupang.com now!', true);
    expect(result.valid).toBe(false);
  });

  it('rejects content with 제휴 in warmup mode', () => {
    const result = validateContent('이 포스트는 제휴 링크를 포함합니다', true);
    expect(result.valid).toBe(false);
  });

  it('rejects content with 광고 in warmup mode', () => {
    const result = validateContent('광고 포함 콘텐츠입니다', true);
    expect(result.valid).toBe(false);
  });

  it('accepts clean content in warmup mode', () => {
    const result = validateContent('오늘 날씨가 정말 좋네요. 커피 한 잔 어떠세요?', true);
    expect(result.valid).toBe(true);
    expect(result.reason).toBeUndefined();
  });

  it('accepts affiliate content when NOT in warmup mode', () => {
    const result = validateContent('쿠팡 파트너스 제휴 링크: https://coupang.com/...', false);
    expect(result.valid).toBe(true);
  });
});

// ─── getWarmupProgress() ─────────────────────────────────

describe('getWarmupProgress()', () => {
  it('returns {current:0, target:100, remaining:100} when no posts', async () => {
    const { db } = await createTestDb();
    const progress = await getWarmupProgress(db);
    expect(progress.current).toBe(0);
    expect(progress.target).toBe(100);
    expect(progress.remaining).toBe(100);
  });

  it('returns correct values when 30 posts published', async () => {
    const { client, db } = await createTestDb();
    for (let i = 0; i < 30; i++) {
      await insertPostedEntry(client, `lc-${i}`);
    }
    const progress = await getWarmupProgress(db);
    expect(progress.current).toBe(30);
    expect(progress.target).toBe(100);
    expect(progress.remaining).toBe(70);
  });

  it('returns remaining=0 when target reached', async () => {
    const { client, db } = await createTestDb();
    for (let i = 0; i < 110; i++) {
      await insertPostedEntry(client, `lc-${i}`);
    }
    const progress = await getWarmupProgress(db);
    expect(progress.current).toBe(110);
    expect(progress.target).toBe(100);
    expect(progress.remaining).toBe(0);
  });
});
