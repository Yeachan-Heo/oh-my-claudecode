/**
 * @file Migrate v1 JSON data into the database.
 *
 * Currently supports:
 *   - data/product_dict/products_v1.json -> products table
 *
 * Future extensions:
 *   - raw_posts/*.json -> thread_posts table
 *   - discovered_channels.json -> channels table
 *
 * Run: npx tsx scripts/migrate-v1-data.ts
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import { sql } from 'drizzle-orm';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import * as schema from '../src/db/schema.js';

// ---------------------------------------------------------------------------
// Types matching products_v1.json structure
// ---------------------------------------------------------------------------

interface ProductV1 {
  product_id: string;
  name: string;
  category: string;
  needs_categories: string[];
  keywords: string[];
  affiliate_platform: 'coupang_partners' | 'naver_smartstore' | 'ali_express' | 'other';
  price_range: string;
  description: string;
  affiliate_link?: string;
}

interface ProductsV1File {
  version: string;
  updated_at: string;
  total_products: number;
  products: ProductV1[];
}

// ---------------------------------------------------------------------------
// Migration functions
// ---------------------------------------------------------------------------

async function migrateProducts(
  db: ReturnType<typeof drizzle>,
  dataDir: string,
): Promise<number> {
  const filePath = join(dataDir, 'product_dict', 'products_v1.json');
  console.log(`[migrate] Reading ${filePath}...`);

  const raw = readFileSync(filePath, 'utf-8');
  const data: ProductsV1File = JSON.parse(raw);
  console.log(`[migrate] Found ${data.total_products} products (v${data.version})`);

  let inserted = 0;

  for (const product of data.products) {
    await db
      .insert(schema.products)
      .values({
        product_id: product.product_id,
        name: product.name,
        category: product.category,
        needs_categories: product.needs_categories,
        keywords: product.keywords,
        affiliate_platform: product.affiliate_platform,
        price_range: product.price_range,
        description: product.description,
        affiliate_link: product.affiliate_link ?? null,
      })
      .onConflictDoNothing();

    inserted++;
  }

  return inserted;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const dataDir = join(__dirname, '..', 'data');
  const dbPath = process.env.DATABASE_URL || './data/pglite';

  console.log(`[migrate] Connecting to PGlite at ${dbPath}...`);
  const client = new PGlite(dbPath);
  const db = drizzle(client, { schema });

  // Apply migrations first
  console.log('[migrate] Applying migrations...');
  const fs = await import('fs');
  const path = await import('path');
  const migrationsDir = path.join(__dirname, '..', 'src', 'db', 'migrations');
  const entries = fs.readdirSync(migrationsDir).sort();
  const sqlFiles = entries.filter((f: string) => f.endsWith('.sql'));

  for (const file of sqlFiles) {
    const filePath = path.join(migrationsDir, file);
    const sqlContent = fs.readFileSync(filePath, 'utf-8');
    const statements = sqlContent
      .split('--> statement-breakpoint')
      .map((s: string) => s.trim())
      .filter((s: string) => s.length > 0);

    for (const stmt of statements) {
      try {
        await db.execute(sql.raw(stmt));
      } catch (err: unknown) {
        // Ignore "already exists" errors during re-runs
        // DrizzleQueryError wraps the original PGlite error in `cause`
        const msg = err instanceof Error ? err.message : String(err);
        const causeMsg = (err as any)?.cause?.message ?? '';
        const fullMsg = `${msg} ${causeMsg}`;
        if (!fullMsg.includes('already exists')) {
          throw err;
        }
      }
    }
  }

  // Run migrations
  console.log('\n--- Migrating Products ---');
  const productCount = await migrateProducts(db, dataDir);
  console.log(`[migrate] Products: ${productCount} rows inserted`);

  // Verify
  const rows = await db.select().from(schema.products);
  console.log(`[migrate] Verification: ${rows.length} products in DB`);

  console.log('\n[migrate] DONE. All v1 data migrated successfully.');
  process.exit(0);
}

main().catch((err) => {
  console.error('[migrate] FATAL:', err);
  process.exit(1);
});
