/**
 * @file revenue helper integration tests using PGlite in-memory.
 *
 * TDD RED→GREEN: drives creation of revenue_tracking table and helper functions.
 */

import { describe, it, expect } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import * as schema from '../db/schema.js';
import {
  trackClick,
  trackPurchase,
  getRevenueByPost,
  getRevenueByDate,
  getDailyRevenueSummary,
} from '../db/revenue.js';

// ─── DDL ─────────────────────────────────────────────────

const CREATE_TABLES_SQL = `
CREATE TABLE IF NOT EXISTS revenue_tracking (
  id TEXT PRIMARY KEY,
  post_id TEXT NOT NULL,
  product_id TEXT,
  coupang_link TEXT,
  click_count INT DEFAULT 0,
  purchase_count INT DEFAULT 0,
  revenue NUMERIC(10,2) DEFAULT 0,
  commission NUMERIC(10,2) DEFAULT 0,
  tracked_date DATE NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
`;

// ─── Per-test DB factory ─────────────────────────────────

async function createTestDb() {
  const client = new PGlite();
  await client.exec(CREATE_TABLES_SQL);
  const db = drizzle(client, { schema });
  return { client, db };
}

// ─── Tests ───────────────────────────────────────────────

describe('trackClick()', () => {
  it('saves click to DB', async () => {
    const { db } = await createTestDb();
    const row = await trackClick('post-1', 'prod-1', 'https://coupang.com/p/1', db);

    expect(row.post_id).toBe('post-1');
    expect(row.product_id).toBe('prod-1');
    expect(row.click_count).toBe(1);
    expect(row.purchase_count).toBe(0);
  });
});

describe('trackPurchase()', () => {
  it('saves purchase with revenue and commission to DB', async () => {
    const { db } = await createTestDb();
    const row = await trackPurchase('post-2', 15000, 750, db);

    expect(row.post_id).toBe('post-2');
    expect(row.purchase_count).toBe(1);
    expect(Number(row.revenue)).toBe(15000);
    expect(Number(row.commission)).toBe(750);
  });
});

describe('getRevenueByPost()', () => {
  it('returns all rows for the given post', async () => {
    const { db } = await createTestDb();
    await trackClick('post-3', 'prod-3', 'https://coupang.com/p/3', db);
    await trackPurchase('post-3', 20000, 1000, db);

    const rows = await getRevenueByPost('post-3', db);
    expect(rows.length).toBe(2);
    expect(rows.every((r: { post_id: string }) => r.post_id === 'post-3')).toBe(true);
  });

  it('does not return rows from other posts', async () => {
    const { db } = await createTestDb();
    await trackClick('post-A', 'prod-A', null, db);
    await trackClick('post-B', 'prod-B', null, db);

    const rows = await getRevenueByPost('post-A', db);
    expect(rows).toHaveLength(1);
  });
});

describe('getRevenueByDate()', () => {
  it('returns rows within date range', async () => {
    const { db } = await createTestDb();
    await trackClick('post-4', 'prod-4', 'https://coupang.com/p/4', db);

    const today = new Date().toISOString().split('T')[0];
    const rows = await getRevenueByDate(today, today, db);
    expect(rows.length).toBeGreaterThan(0);
  });
});

describe('getDailyRevenueSummary()', () => {
  it('aggregates clicks, purchases, and revenue by date', async () => {
    const { db } = await createTestDb();
    await trackClick('post-5', 'prod-5', 'https://coupang.com/p/5', db);
    await trackPurchase('post-5', 30000, 1500, db);

    const summary = await getDailyRevenueSummary(db);
    expect(summary.length).toBeGreaterThan(0);

    const today = new Date().toISOString().split('T')[0];
    const todayRow = summary.find((r: { tracked_date: string }) => r.tracked_date === today);
    expect(todayRow).toBeDefined();
    expect(todayRow!.total_clicks).toBeGreaterThanOrEqual(1);
    expect(todayRow!.total_purchases).toBeGreaterThanOrEqual(1);
    expect(Number(todayRow!.total_revenue)).toBeGreaterThan(0);
  });
});
