/**
 * @file scheduler.ts
 * 자연스러운 간격으로 콘텐츠를 발행하는 스케줄러.
 *
 * 발행 간격: 1~4시간 가우스 분포 (mean=2h, stddev=0.5h)
 * 새벽 0시~7시 회피 (사람의 활동 패턴)
 *
 * Usage:
 *   import { getNextPostTime, getPublishQueue, processQueue } from './scheduler.js';
 */

import { db } from '../db/index.js';
import { affContents, contentLifecycle, accounts } from '../db/schema.js';
import { eq, sql } from 'drizzle-orm';
import { postToThreads } from './poster.js';
import { isWarmupComplete, generateWarmupContent } from './warmup.js';
import { getAccountForPosting } from './account-manager.js';
import { gaussianDelay } from '../utils/timing.js';
import { generateId } from '../utils/id.js';
import type { QueueItem } from '../types.js';

// ─── Config ──────────────────────────────────────────────

/** 발행 간격 가우스 분포 파라미터 (시간 단위) */
const INTERVAL_MEAN_HOURS = 2;
const INTERVAL_STDDEV_HOURS = 0.5;

/** 새벽 회피 시간대 */
const QUIET_HOURS_START = 0;  // 0시
const QUIET_HOURS_END = 7;    // 7시

/** 재시도 최대 횟수 */
const MAX_RETRIES = 3;

// ─── Utility ─────────────────────────────────────────────

function log(msg: string): void {
  const ts = new Date().toISOString().slice(11, 19);
  console.error(`[scheduler][${ts}] ${msg}`);
}

/**
 * 새벽 시간대를 피하여 시간을 조정한다.
 * 0시~7시 사이이면 7시로 밀어낸다.
 */
function avoidQuietHours(date: Date): Date {
  const hours = date.getHours();
  if (hours >= QUIET_HOURS_START && hours < QUIET_HOURS_END) {
    const adjusted = new Date(date);
    adjusted.setHours(QUIET_HOURS_END, Math.floor(Math.random() * 60), 0, 0);
    return adjusted;
  }
  return date;
}

// ─── Core Functions ──────────────────────────────────────

/**
 * 다음 포스팅 시간을 계산한다.
 * - 마지막 포스팅 시간 + 랜덤 간격 (가우스 분포, mean=2h, stddev=0.5h)
 * - 새벽 0시~7시는 피함
 */
export function getNextPostTime(lastPostedAt: Date | null): Date {
  const baseTime = lastPostedAt ?? new Date();

  // 가우스 분포로 다음 간격(시간 단위) 계산
  const intervalHours = Math.max(1, gaussianDelay(INTERVAL_MEAN_HOURS, INTERVAL_STDDEV_HOURS));
  const intervalMs = intervalHours * 60 * 60 * 1000;

  const nextTime = new Date(baseTime.getTime() + intervalMs);
  return avoidQuietHours(nextTime);
}

/**
 * 발행 대기열을 조회한다.
 * - aff_contents에서 아직 발행되지 않은 콘텐츠 조회
 *   (content_lifecycle에 posted_at이 없는 것)
 * - 워밍업 미완료 계정이면 제휴 콘텐츠 제외
 * - 발행 시간 배정
 */
export async function getPublishQueue(): Promise<QueueItem[]> {
  const account = await getAccountForPosting();
  if (!account) {
    log('발행 가능한 계정 없음');
    return [];
  }

  const warmupDone = await isWarmupComplete(account.id);

  // 아직 발행되지 않은 콘텐츠 조회:
  // aff_contents 중 content_lifecycle에 매칭되는 발행 기록이 없는 것
  const allContents = await db
    .select({
      id: affContents.id,
      product_id: affContents.product_id,
      product_name: affContents.product_name,
      need_id: affContents.need_id,
      hook: affContents.hook,
      bodies: affContents.bodies,
      self_comments: affContents.self_comments,
    })
    .from(affContents)
    .where(
      sql`NOT EXISTS (
        SELECT 1 FROM ${contentLifecycle}
        WHERE ${contentLifecycle.source_post_id} = ${affContents.id}
        AND ${contentLifecycle.posted_at} IS NOT NULL
      )`,
    );

  if (allContents.length === 0) {
    log('발행할 콘텐츠 없음');
    return [];
  }

  // 발행 시간 배정
  let nextTime = getNextPostTime(
    account.last_posted_at ? new Date(account.last_posted_at) : null,
  );

  const queue: QueueItem[] = [];

  // 워밍업 미완료 계정이면 워밍업 콘텐츠를 생성하여 큐에 추가
  if (!warmupDone) {
    const warmupText = generateWarmupContent();
    queue.push({
      contentId: generateId('warmup'),
      accountId: account.id,
      scheduledAt: nextTime,
      text: warmupText,
      isAffiliate: false,
    });
    return queue;
  }

  for (const content of allContents) {
    // 본문 중 첫 번째 사용
    const text = content.bodies[0] ?? content.hook;
    const selfComment = content.self_comments[0] ?? undefined;

    queue.push({
      contentId: content.id,
      accountId: account.id,
      scheduledAt: nextTime,
      text,
      selfComment,
      isAffiliate: true,
    });

    // 다음 아이템의 발행 시간 계산
    nextTime = getNextPostTime(nextTime);
  }

  return queue;
}

/**
 * 발행 큐를 처리한다.
 * - 발행 시간이 된 큐 아이템만 처리
 * - poster.postToThreads() 호출
 * - 성공 시 content_lifecycle에 기록 + accounts 업데이트
 * - 실패 시 재시도 (최대 3회)
 */
export async function processQueue(): Promise<void> {
  const queue = await getPublishQueue();
  const now = new Date();

  for (const item of queue) {
    // 발행 시간이 아직 안 됐으면 스킵
    if (item.scheduledAt > now) {
      log(`스킵 — ${item.contentId} 예정 시간: ${item.scheduledAt.toISOString()}`);
      continue;
    }

    log(`발행 시작 — ${item.contentId}`);

    let success = false;
    let lastError = '';

    // 재시도 루프
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      const result = await postToThreads({
        text: item.text,
        accountId: item.accountId,
        selfComment: item.selfComment,
      });

      if (result.success) {
        success = true;

        // content_lifecycle에 기록
        if (item.isAffiliate) {
          // 제휴 콘텐츠: aff_contents에서 실제 데이터 조회
          const [affContent] = await db.select().from(affContents)
            .where(eq(affContents.id, item.contentId));

          await db.insert(contentLifecycle).values({
            id: generateId('lc'),
            source_post_id: affContent?.id ?? item.contentId,
            source_channel_id: affContent?.need_id ?? '',
            source_engagement: 0,
            source_relevance: 0,
            extracted_need: affContent?.hook ?? '',
            need_category: affContent?.need_id ?? '',
            need_confidence: 0,
            matched_product_id: affContent?.product_id ?? '',
            match_relevance: 0,
            content_text: item.text,
            content_style: affContent?.format ?? '',
            hook_type: affContent?.hook ?? '',
            posted_account_id: item.accountId,
            posted_at: new Date(),
            threads_post_id: result.postId ?? null,
            threads_post_url: result.postUrl ?? null,
            maturity: 'warmup',
            current_impressions: 0,
            current_clicks: 0,
            current_conversions: 0,
            current_revenue: 0,
          });
        } else {
          // 워밍업 포스트: 기본값 사용
          await db.insert(contentLifecycle).values({
            id: generateId('lc'),
            source_post_id: 'warmup',
            source_channel_id: 'warmup',
            source_engagement: 0,
            source_relevance: 0,
            extracted_need: 'warmup',
            need_category: 'warmup',
            need_confidence: 0,
            matched_product_id: 'warmup',
            match_relevance: 0,
            content_text: item.text,
            content_style: 'warmup',
            hook_type: 'warmup',
            posted_account_id: item.accountId,
            posted_at: new Date(),
            threads_post_id: result.postId ?? null,
            threads_post_url: result.postUrl ?? null,
            maturity: 'warmup',
            current_impressions: 0,
            current_clicks: 0,
            current_conversions: 0,
            current_revenue: 0,
          });
        }

        // accounts 업데이트 (last_posted_at, post_count)
        await db
          .update(accounts)
          .set({
            last_posted_at: new Date(),
            post_count: sql`${accounts.post_count} + 1`,
          })
          .where(eq(accounts.id, item.accountId));

        log(`발행 성공 — ${item.contentId}, postId=${result.postId}`);
        break;
      }

      lastError = result.error ?? 'Unknown error';
      log(`발행 실패 (${attempt}/${MAX_RETRIES}) — ${item.contentId}: ${lastError}`);

      // 재시도 전 대기 (exponential backoff)
      if (attempt < MAX_RETRIES) {
        const waitMs = attempt * 30000; // 30s, 60s
        await new Promise(r => setTimeout(r, waitMs));
      }
    }

    if (!success) {
      log(`발행 최종 실패 — ${item.contentId}: ${lastError}`);
    }
  }
}
