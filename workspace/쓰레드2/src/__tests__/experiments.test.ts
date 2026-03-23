/**
 * @file experiments helper integration tests using PGlite in-memory.
 *
 * TDD RED→GREEN: drives creation of experiments table and CRUD helpers.
 */

import { describe, it, expect } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import * as schema from '../db/schema.js';
import {
  createExperiment,
  getActiveExperiments,
  closeExperiment,
} from '../db/experiments.js';

// ─── DDL ─────────────────────────────────────────────────

const CREATE_TABLES_SQL = `
CREATE TABLE IF NOT EXISTS experiments (
  id TEXT PRIMARY KEY,
  hypothesis TEXT NOT NULL,
  variable TEXT NOT NULL,
  variant_a TEXT NOT NULL,
  variant_b TEXT NOT NULL,
  post_id_a TEXT,
  post_id_b TEXT,
  start_date TIMESTAMPTZ DEFAULT NOW(),
  end_date TIMESTAMPTZ,
  status TEXT DEFAULT 'active',
  verdict TEXT,
  confidence TEXT DEFAULT 'directional',
  results JSONB,
  created_by TEXT DEFAULT 'minjun-ceo',
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

describe('createExperiment()', () => {
  it('saves an experiment and returns it with an id', async () => {
    const { db } = await createTestDb();
    const exp = await createExperiment(
      '감정공감형 훅이 정보형보다 조회수가 높다',
      '훅 스타일',
      '감정공감형',
      '정보형',
      db,
    );

    expect(exp.id).toBeTruthy();
    expect(exp.hypothesis).toBe('감정공감형 훅이 정보형보다 조회수가 높다');
    expect(exp.variable).toBe('훅 스타일');
    expect(exp.variant_a).toBe('감정공감형');
    expect(exp.variant_b).toBe('정보형');
    expect(exp.status).toBe('active');
    expect(exp.confidence).toBe('directional');
  });
});

describe('getActiveExperiments()', () => {
  it('returns only status=active experiments', async () => {
    const { db } = await createTestDb();

    await createExperiment('가설 A', '훅', 'A1', 'A2', db);
    const exp2 = await createExperiment('가설 B', '포맷', 'B1', 'B2', db);

    // Close the second experiment directly
    await closeExperiment(exp2.id, 'variant_a_wins', 'directional', db);

    const active = await getActiveExperiments(db);
    expect(active).toHaveLength(1);
    expect(active[0].hypothesis).toBe('가설 A');
  });

  it('returns empty array when no active experiments', async () => {
    const { db } = await createTestDb();
    const active = await getActiveExperiments(db);
    expect(active).toHaveLength(0);
  });
});

describe('closeExperiment()', () => {
  it('sets status=closed, verdict, and end_date', async () => {
    const { db } = await createTestDb();
    const exp = await createExperiment('가설 C', '시간대', 'C1', 'C2', db);

    await closeExperiment(exp.id, 'variant_b_wins', 'replicated', db);

    const active = await getActiveExperiments(db);
    expect(active).toHaveLength(0);  // no active remaining
  });

  it('closed experiment has verdict stored', async () => {
    const { client, db } = await createTestDb();
    const exp = await createExperiment('가설 D', '이미지', 'D1', 'D2', db);

    await closeExperiment(exp.id, 'no_difference', 'directional', db);

    const result = await client.query<{ verdict: string; status: string; end_date: string }>(
      `SELECT verdict, status, end_date FROM experiments WHERE id = $1`,
      [exp.id],
    );

    expect(result.rows[0].status).toBe('closed');
    expect(result.rows[0].verdict).toBe('no_difference');
    expect(result.rows[0].end_date).not.toBeNull();
  });
});
