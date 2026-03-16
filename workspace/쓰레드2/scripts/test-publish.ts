/**
 * @file Publishing E2E test — register account, generate warmup content, post to Threads.
 *
 * Run: npx tsx scripts/test-publish.ts
 *
 * Steps:
 *   1. Register account (or use existing)
 *   2. Generate warmup content
 *   3. Post to Threads via CDP
 *   4. Verify DB records
 */

import 'dotenv/config';
import { db } from '../src/db/index.js';
import { accounts, contentLifecycle } from '../src/db/schema.js';
import { eq, sql } from 'drizzle-orm';
import { registerAccount, getActiveAccounts } from '../src/publisher/account-manager.js';
import { generateWarmupContent } from '../src/publisher/warmup.js';
import { postToThreads } from '../src/publisher/poster.js';
import { generateId } from '../src/utils/id.js';

// ─── Config ──────────────────────────────────────────────

const USERNAME = 'duribeon231';
const EMAIL = 'test@threads.local';

function log(msg: string): void {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`[test-publish][${ts}] ${msg}`);
}

// ─── Main ────────────────────────────────────────────────

async function main(): Promise<void> {
  log('=== Publishing E2E Test Start ===');

  // Ensure schema columns exist (migration may be outdated)
  await db.execute(sql`
    ALTER TABLE "content_lifecycle"
    ADD COLUMN IF NOT EXISTS "threads_post_id" text,
    ADD COLUMN IF NOT EXISTS "threads_post_url" text
  `);

  // Step 1: Register or find existing account
  log('Step 1: 계정 확인...');
  let account;

  const existing = await getActiveAccounts();
  const found = existing.find((a) => a.username === USERNAME);

  if (found) {
    log(`기존 계정 사용: id=${found.id}, username=${found.username}, post_count=${found.post_count}`);
    account = found;
  } else {
    log(`새 계정 등록: username=${USERNAME}`);
    account = await registerAccount({ username: USERNAME, email: EMAIL });
    log(`계정 등록 완료: id=${account.id}`);
  }

  // Step 2: Generate warmup content
  log('Step 2: 워밍업 콘텐츠 생성...');
  const warmupText = generateWarmupContent();
  log(`생성된 콘텐츠: "${warmupText}"`);

  // Step 3: Post to Threads
  log('Step 3: Threads에 포스팅...');
  const startTime = Date.now();
  const result = await postToThreads({
    text: warmupText,
    accountId: account.id,
    dryRun: false,
  });
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

  if (!result.success) {
    log(`FAIL: 포스팅 실패 — ${result.error}`);
    process.exit(1);
  }

  log(`포스팅 성공 (${elapsed}s)`);
  log(`  postId: ${result.postId ?? 'unknown'}`);
  log(`  postUrl: ${result.postUrl ?? 'unknown'}`);

  // Step 4: Record in content_lifecycle + update account
  log('Step 4: DB 기록...');
  const now = new Date();

  // Insert content lifecycle record
  const lifecycleId = generateId('lc');
  await db.insert(contentLifecycle).values({
    id: lifecycleId,
    source_post_id: 'warmup',
    source_channel_id: 'self',
    source_engagement: 0,
    source_relevance: 0,
    extracted_need: 'warmup',
    need_category: 'warmup',
    need_confidence: 1,
    matched_product_id: 'none',
    match_relevance: 0,
    content_text: warmupText,
    content_style: 'warmup',
    hook_type: 'warmup',
    posted_account_id: account.id,
    posted_at: now,
    threads_post_id: result.postId ?? null,
    threads_post_url: result.postUrl ?? null,
    maturity: 'warmup',
    current_impressions: 0,
    current_clicks: 0,
    current_conversions: 0,
    current_revenue: 0,
  });
  log(`content_lifecycle 기록 완료: id=${lifecycleId}`);

  // Update account post_count and last_posted_at
  await db
    .update(accounts)
    .set({
      post_count: sql`${accounts.post_count} + 1`,
      last_posted_at: now,
    })
    .where(eq(accounts.id, account.id));
  log('accounts 업데이트 완료');

  // Step 5: Verify DB records
  log('Step 5: DB 검증...');

  const [updatedAccount] = await db
    .select()
    .from(accounts)
    .where(eq(accounts.id, account.id));

  const [lifecycleRow] = await db
    .select()
    .from(contentLifecycle)
    .where(eq(contentLifecycle.id, lifecycleId));

  log(`  accounts.post_count: ${updatedAccount?.post_count}`);
  log(`  accounts.last_posted_at: ${updatedAccount?.last_posted_at?.toISOString()}`);
  log(`  lifecycle.posted_at: ${lifecycleRow?.posted_at?.toISOString()}`);
  log(`  lifecycle.threads_post_id: ${lifecycleRow?.threads_post_id}`);

  // ─── Final Report ──────────────────────────────────────
  console.log('\n### 발행 테스트 결과');
  console.log(`- 계정: ${USERNAME}`);
  console.log(`- 포스트 내용: ${warmupText}`);
  console.log(`- 발행 시간: ${now.toISOString()}`);
  console.log(`- postId: ${result.postId ?? 'unknown'}`);
  console.log(`- postUrl: ${result.postUrl ?? 'unknown'}`);
  console.log(`- DB 기록: contentLifecycle=${lifecycleId} / accounts.post_count=${updatedAccount?.post_count}`);
  console.log(`- 소요 시간: ${elapsed}s`);
  console.log(`- 에러/수정: 없음`);

  log('=== Publishing E2E Test Complete ===');
  process.exit(0);
}

main().catch((err) => {
  console.error('[test-publish] FATAL:', err);
  process.exit(1);
});
