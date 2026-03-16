/**
 * @file DB connection + table creation smoke test.
 *
 * Run: npx tsx scripts/test-db.ts
 *
 * Creates all tables via raw SQL from drizzle schema, inserts a test row,
 * reads it back, then cleans up.
 */

import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { sql } from 'drizzle-orm';
import * as schema from '../src/db/schema.js';

async function main() {
  console.log('[test-db] Connecting to PGlite (in-memory)...');

  const client = new PGlite();
  const db = drizzle(client, { schema });

  console.log('[test-db] Connected. Running migration SQL...');

  // Read and execute the generated migration SQL
  const fs = await import('fs');
  const path = await import('path');
  const migrationsDir = path.join(__dirname, '..', 'src', 'db', 'migrations');

  const entries = fs.readdirSync(migrationsDir).sort();
  const sqlFiles = entries
    .filter((f: string) => f.endsWith('.sql'));

  if (sqlFiles.length === 0) {
    console.error('[test-db] No migration SQL files found in', migrationsDir);
    process.exit(1);
  }

  for (const file of sqlFiles) {
    const filePath = path.join(migrationsDir, file);
    const sqlContent = fs.readFileSync(filePath, 'utf-8');
    console.log(`[test-db] Applying migration: ${file}`);

    // Split by statement breakpoints (drizzle-kit uses --> statement-breakpoint)
    const statements = sqlContent
      .split('--> statement-breakpoint')
      .map((s: string) => s.trim())
      .filter((s: string) => s.length > 0);

    for (const stmt of statements) {
      await db.execute(sql.raw(stmt));
    }
  }

  console.log('[test-db] All migrations applied.');

  // Verify tables exist
  const result = await db.execute(sql`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = 'public'
    ORDER BY table_name
  `);

  const tables = result.rows.map((r: Record<string, unknown>) => r.table_name);
  console.log('[test-db] Tables created:', tables);

  const expectedTables = [
    'accounts',
    'aff_contents',
    'channels',
    'content_lifecycle',
    'crawl_sessions',
    'diagnosis_reports',
    'needs',
    'post_snapshots',
    'products',
    'thread_posts',
    'tuning_actions',
  ];

  const missing = expectedTables.filter((t) => !tables.includes(t));
  if (missing.length > 0) {
    console.error('[test-db] FAIL: Missing tables:', missing);
    process.exit(1);
  }

  // Insert a test product
  console.log('[test-db] Inserting test product...');
  await db.insert(schema.products).values({
    product_id: 'test_product_001',
    name: 'Test Product',
    category: 'test',
    needs_categories: ['불편해소'],
    keywords: ['test'],
    affiliate_platform: 'coupang_partners',
    price_range: '10000~20000',
    description: 'A test product for DB verification',
  });

  // Read it back
  const rows = await db.select().from(schema.products);
  if (rows.length !== 1 || rows[0].product_id !== 'test_product_001') {
    console.error('[test-db] FAIL: Insert/select verification failed');
    process.exit(1);
  }

  console.log('[test-db] Product read back:', rows[0].name);

  // Clean up
  await db.delete(schema.products);

  console.log('[test-db] SUCCESS: All tables created and verified.');
  process.exit(0);
}

main().catch((err) => {
  console.error('[test-db] FATAL:', err);
  process.exit(1);
});
