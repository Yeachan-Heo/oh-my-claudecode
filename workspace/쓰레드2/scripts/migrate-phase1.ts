import path from 'path';
import { PGlite } from '@electric-sql/pglite';

async function main() {
  const dataDir = path.join(__dirname, '..', 'data', 'pglite');
  console.log('[migrate-phase1] Connecting to PGlite:', dataDir);
  const client = new PGlite(dataDir);

  // 1. Apply ALTER TABLE migrations
  const migrations = [
    `ALTER TABLE thread_posts ADD COLUMN IF NOT EXISTS topic_tags TEXT[]`,
    `ALTER TABLE thread_posts ADD COLUMN IF NOT EXISTS topic_category TEXT`,
    `ALTER TABLE post_snapshots ADD COLUMN IF NOT EXISTS post_views INTEGER`,
    `ALTER TABLE post_snapshots ADD COLUMN IF NOT EXISTS comment_views INTEGER`,
  ];

  for (const stmt of migrations) {
    console.log('[migrate-phase1] Executing:', stmt);
    await client.exec(stmt);
  }
  console.log('[migrate-phase1] Migrations applied.');

  // 2. Verify columns exist
  const checks = [
    { table: 'thread_posts', column: 'topic_tags' },
    { table: 'thread_posts', column: 'topic_category' },
    { table: 'post_snapshots', column: 'post_views' },
    { table: 'post_snapshots', column: 'comment_views' },
  ];

  let allOk = true;
  for (const { table, column } of checks) {
    const result = await client.query<{ count: string }>(
      `SELECT COUNT(*) as count FROM information_schema.columns WHERE table_name = $1 AND column_name = $2`,
      [table, column]
    );
    const found = Number(result.rows[0]?.count) > 0;
    console.log(`[migrate-phase1] ${table}.${column}: ${found ? 'OK' : 'MISSING'}`);
    if (!found) allOk = false;
  }

  // 3. Verify existing data preserved
  const postCount = await client.query<{ count: string }>('SELECT COUNT(*) as count FROM thread_posts');
  console.log(`[migrate-phase1] thread_posts row count: ${postCount.rows[0]?.count}`);

  await client.close();

  if (!allOk) {
    console.error('[migrate-phase1] FAILED: some columns are missing');
    process.exit(1);
  }
  console.log('[migrate-phase1] SUCCESS: all columns verified');
  process.exit(0);
}

main().catch(e => {
  console.error('[migrate-phase1] FATAL:', e);
  process.exit(1);
});
