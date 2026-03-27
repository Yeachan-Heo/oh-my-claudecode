import fs from 'fs';
import path from 'path';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { sql } from 'drizzle-orm';
import * as schema from '../src/db/schema.js';

async function main() {
  if (!process.argv.includes('--force')) {
    console.error('⚠️ 기존 데이터가 전부 삭제됩니다. --force 플래그를 추가하세요.');
    process.exit(1);
  }

  console.log('[rebuild] Creating fresh PGlite database...');
  const dataDir = path.join(__dirname, '..', 'data', 'pglite');
  const client = new PGlite(dataDir);
  const db = drizzle(client, { schema });

  // 1. Apply migrations
  console.log('[rebuild] Applying migrations...');
  const migrationsDir = path.join(__dirname, '..', 'src', 'db', 'migrations');
  const sqlFiles = fs.readdirSync(migrationsDir).filter((f: string) => f.endsWith('.sql')).sort();
  for (const file of sqlFiles) {
    const filePath = path.join(migrationsDir, file);
    const sqlContent = fs.readFileSync(filePath, 'utf-8');
    console.log(`[rebuild] Applying: ${file}`);
    const statements = sqlContent.split('--> statement-breakpoint').map((s: string) => s.trim()).filter((s: string) => s.length > 0);
    for (const stmt of statements) {
      await db.execute(sql.raw(stmt));
    }
  }

  // 2. Import channels
  const discoveredPath = path.join(__dirname, '..', 'data', 'discovered_channels.json');
  if (fs.existsSync(discoveredPath)) {
    const data = JSON.parse(fs.readFileSync(discoveredPath, 'utf-8'));
    const allChannels = [...(data.channels || []), ...(data.review_queue || [])];
    let inserted = 0;
    for (const ch of allChannels) {
      try {
        const rows = await db.insert(schema.channels).values({
          channel_id: ch.channel_id,
          display_name: ch.display_name,
          follower_count: ch.follower_count,
          bio: ch.bio || '',
          recent_ad_count: ch.recent_ad_count || 0,
          source_keyword: ch.source_keyword,
          discovered_at: ch.discovered_at ? new Date(ch.discovered_at) : new Date(),
          is_active: true,
        }).onConflictDoNothing().returning({ channel_id: schema.channels.channel_id });
        if (rows.length > 0) inserted++;
      } catch { /* ignored */ }
    }
    console.log(`[rebuild] Channels imported: ${inserted}`);
  }
  // Original 3 channels
  for (const ch of [
    { channel_id: 'hongsi_s2s2', display_name: 'hongsi_s2s2', follower_count: 656, source_keyword: '쿠팡파트너스', recent_ad_count: 1 },
    { channel_id: 'pickmeup__shop', display_name: 'pickmeup__shop', follower_count: 583, source_keyword: '쿠팡파트너스', recent_ad_count: 12 },
    { channel_id: 'r.j.lim', display_name: 'r.j.lim', follower_count: 7322, source_keyword: '제휴마케팅', recent_ad_count: 1 },
  ]) {
    try {
      await db.insert(schema.channels).values({ ...ch, bio: '', is_active: true }).onConflictDoNothing();
    } catch { /* ignored */ }
  }

  // 3. Import posts from thread_units
  const rawPostsDir = path.join(__dirname, '..', 'data', 'raw_posts');
  const postFiles = fs.readdirSync(rawPostsDir).filter((f: string) => f.endsWith('.json'));
  let totalPostsInserted = 0;

  for (const file of postFiles) {
    const filePath = path.join(rawPostsDir, file);
    const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    const units = data.thread_units || [];
    const runId = data.meta?.run_id || file.replace('.json', '');
    let fileInserted = 0;

    for (const u of units) {
      try {
        // Build comments array from reply data
        const comments: any[] = [];
        if (u.reply_text) {
          comments.push({
            text: u.reply_text,
            has_affiliate_link: !!u.link_url,
            link_url: u.link_url || null,
            metrics: { view_count: u.reply_view_count || null, like_count: u.reply_like_count || 0 },
            media_urls: u.reply_media_urls || [],
          });
        }

        const rows = await db.insert(schema.threadPosts).values({
          post_id: u.hook_post_id,
          channel_id: u.channel_id,
          author: u.display_name || null,
          text: u.hook_text || '',
          timestamp: u.hook_date ? new Date(u.hook_date) : null,
          permalink: u.permalink || u.hook_post_url || null,
          view_count: u.hook_view_count ?? null,
          like_count: u.hook_like_count ?? 0,
          reply_count: u.hook_reply_count ?? 0,
          repost_count: u.hook_repost_count ?? 0,
          has_image: u.hook_has_image ?? false,
          media_urls: u.hook_media_urls || [],
          link_url: u.link_url || null,
          link_domain: u.link_domain || null,
          link_location: u.link_location || null,
          primary_tag: u.tags?.primary || null,
          secondary_tags: u.tags?.secondary || [],
          comments,
          channel_meta: { display_name: u.display_name, follower_count: u.follower_count, category: u.category },
          crawl_at: u.crawl_meta?.crawl_at ? new Date(u.crawl_meta.crawl_at) : new Date(),
          run_id: runId,
          selector_tier: u.crawl_meta?.selector_tier ?? null,
          login_status: u.crawl_meta?.login_status ?? null,
          block_detected: u.crawl_meta?.block_detected ?? null,
          thread_type: u.thread_type || null,
          conversion_rate: u.conversion_rate ?? null,
        }).onConflictDoNothing().returning({ post_id: schema.threadPosts.post_id });
        if (rows.length > 0) fileInserted++;
      } catch {
        // skip
      }
    }
    console.log(`[rebuild] ${file}: ${fileInserted}/${units.length} posts`);
    totalPostsInserted += fileInserted;
  }
  console.log(`[rebuild] Total posts imported: ${totalPostsInserted}`);

  // 4. Import products
  const productPath = path.join(__dirname, '..', 'data', 'product_dict', 'products_v1.json');
  if (fs.existsSync(productPath)) {
    const productData = JSON.parse(fs.readFileSync(productPath, 'utf-8'));
    const productList = productData.products || [];
    let pInserted = 0;
    for (const p of productList) {
      try {
        const rows = await db.insert(schema.products).values({
          product_id: p.product_id,
          name: p.name,
          category: p.category,
          needs_categories: p.needs_categories || [],
          keywords: p.keywords || [],
          affiliate_platform: p.affiliate_platform || 'coupang_partners',
          price_range: p.price_range || '',
          description: p.description || '',
          affiliate_link: p.affiliate_link ?? null,
          is_active: true,
        }).onConflictDoNothing().returning({ product_id: schema.products.product_id });
        if (rows.length > 0) pInserted++;
      } catch { /* ignored */ }
    }
    console.log(`[rebuild] Products imported: ${pInserted}/${productList.length}`);
  }

  // 5. Verify
  const chCount = await db.select().from(schema.channels);
  const postCount = await db.select().from(schema.threadPosts);
  const prodCount = await db.select().from(schema.products);
  console.log(`\n[rebuild] DONE. Channels: ${chCount.length}, Posts: ${postCount.length}, Products: ${prodCount.length}`);

  await client.close();
  process.exit(0);
}

main().catch(e => { console.error('[rebuild] FATAL:', e); process.exit(1); });
