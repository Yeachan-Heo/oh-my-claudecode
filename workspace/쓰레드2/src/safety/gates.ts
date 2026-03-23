/**
 * @file gates — Safety Check 8개 게이트.
 *
 * runSafetyGates(content, accountId, qaScore?, db?): SafetyReport
 *
 * gate1: 워밍업 모드에서 제휴/광고 링크 차단
 * gate2: 500자 초과 차단
 * gate3: 마지막 게시 후 1시간 미경과 차단
 * gate4: 유사도 > 0.8 중복 콘텐츠 차단
 * gate5: 금지 키워드(욕설/정치/경쟁사비방) 차단
 * gate6: QA 점수 < 10 차단
 * gate7: 일일 10개 한도 초과 차단
 * gate8: 연속 3개 게시 간격 < 10분 경고(warn)
 */

import { db as defaultDb } from '../db/index.js';
import { contentLifecycle } from '../db/schema.js';
import { isWarmupMode, validateContent } from '../utils/warmup-gate.js';
import { checkSimilarity } from '../recycler/recycle.js';
import { and, eq, gte, isNotNull, desc, sql } from 'drizzle-orm';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyDb = any;

const DUPLICATE_THRESHOLD = 0.8;
const MAX_DAILY_POSTS = 10;
const MIN_POST_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
const CAPTCHA_RISK_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes

const BANNED_PATTERNS =
  /씨발|병신|개새끼|ㅅㅂ|ㅄ|정치|대통령|선거|국회의원|더불어민주당|국민의힘|경쟁사|비방/i;

// ─── Types ───────────────────────────────────────────────

export interface GateResult {
  gate: string;
  passed: boolean;
  reason?: string;
  severity: 'block' | 'warn';
}

export interface SafetyReport {
  allPassed: boolean;
  results: GateResult[];
  blockers: GateResult[];
  warnings: GateResult[];
}

// ─── Individual Gates ────────────────────────────────────

export async function gate1_warmupCheck(
  content: string,
  db: AnyDb = defaultDb,
): Promise<GateResult> {
  const warmup = await isWarmupMode(db);
  const validation = validateContent(content, warmup);
  return {
    gate: 'gate1_warmupCheck',
    passed: validation.valid,
    reason: validation.reason,
    severity: 'block',
  };
}

export function gate2_lengthCheck(content: string): GateResult {
  const len = content.length;
  const passed = len <= 500;
  return {
    gate: 'gate2_lengthCheck',
    passed,
    reason: passed ? undefined : `${len}자 초과 (최대 500자)`,
    severity: 'block',
  };
}

export async function gate3_frequencyCheck(
  accountId: string,
  db: AnyDb = defaultDb,
): Promise<GateResult> {
  const [result] = await db
    .select({ last_posted: sql<Date>`MAX(posted_at)` })
    .from(contentLifecycle)
    .where(
      and(
        eq(contentLifecycle.posted_account_id, accountId),
        isNotNull(contentLifecycle.posted_at),
      ),
    );

  const lastPosted = result?.last_posted;
  if (!lastPosted) {
    return { gate: 'gate3_frequencyCheck', passed: true, severity: 'block' };
  }

  const elapsed = Date.now() - new Date(lastPosted).getTime();
  const passed = elapsed >= MIN_POST_INTERVAL_MS;
  return {
    gate: 'gate3_frequencyCheck',
    passed,
    reason: passed
      ? undefined
      : `마지막 게시 후 ${Math.round(elapsed / 60000)}분 경과 (최소 60분 필요)`,
    severity: 'block',
  };
}

export function gate4_duplicateCheck(
  content: string,
  recentTexts: string[],
): GateResult {
  for (const recent of recentTexts) {
    const { score } = checkSimilarity(content, recent);
    if (score > DUPLICATE_THRESHOLD) {
      return {
        gate: 'gate4_duplicateCheck',
        passed: false,
        reason: `유사도 ${score} > ${DUPLICATE_THRESHOLD} — 중복 콘텐츠`,
        severity: 'block',
      };
    }
  }
  return { gate: 'gate4_duplicateCheck', passed: true, severity: 'block' };
}

export function gate5_brandSafety(content: string): GateResult {
  const passed = !BANNED_PATTERNS.test(content);
  return {
    gate: 'gate5_brandSafety',
    passed,
    reason: passed ? undefined : '금지 키워드 감지 (욕설/정치/경쟁사비방)',
    severity: 'block',
  };
}

export function gate6_qaPassCheck(qaScore: number): GateResult {
  const passed = qaScore >= 10;
  return {
    gate: 'gate6_qaPassCheck',
    passed,
    reason: passed ? undefined : `QA 점수 ${qaScore} (최소 10점 필요)`,
    severity: 'block',
  };
}

export async function gate7_dailyLimitCheck(
  accountId: string,
  db: AnyDb = defaultDb,
): Promise<GateResult> {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const [result] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(contentLifecycle)
    .where(
      and(
        eq(contentLifecycle.posted_account_id, accountId),
        isNotNull(contentLifecycle.posted_at),
        gte(contentLifecycle.posted_at, today),
      ),
    );

  const count = result?.count ?? 0;
  const passed = count < MAX_DAILY_POSTS;
  return {
    gate: 'gate7_dailyLimitCheck',
    passed,
    reason: passed
      ? undefined
      : `오늘 ${count}개 게시 완료 (일일 최대 ${MAX_DAILY_POSTS}개)`,
    severity: 'block',
  };
}

export async function gate8_captchaRisk(
  accountId: string,
  db: AnyDb = defaultDb,
): Promise<GateResult> {
  const rows = await db
    .select({ posted_at: contentLifecycle.posted_at })
    .from(contentLifecycle)
    .where(
      and(
        eq(contentLifecycle.posted_account_id, accountId),
        isNotNull(contentLifecycle.posted_at),
      ),
    )
    .orderBy(desc(contentLifecycle.posted_at))
    .limit(3);

  if (rows.length < 3) {
    return { gate: 'gate8_captchaRisk', passed: true, severity: 'warn' };
  }

  const times = rows.map((r: { posted_at: Date }) => new Date(r.posted_at).getTime());
  const gap1 = times[0] - times[1];
  const gap2 = times[1] - times[2];
  const risky = gap1 < CAPTCHA_RISK_INTERVAL_MS && gap2 < CAPTCHA_RISK_INTERVAL_MS;

  return {
    gate: 'gate8_captchaRisk',
    passed: !risky,
    reason: risky ? '연속 3개 게시 간격 < 10분 (캡차 위험)' : undefined,
    severity: 'warn',
  };
}

// ─── Main ────────────────────────────────────────────────

export async function runSafetyGates(
  content: string,
  accountId: string,
  qaScore = 10,
  db: AnyDb = defaultDb,
): Promise<SafetyReport> {
  // Fetch recent posted texts for duplicate check
  const recent = await db
    .select({ content_text: contentLifecycle.content_text })
    .from(contentLifecycle)
    .where(
      and(
        eq(contentLifecycle.posted_account_id, accountId),
        isNotNull(contentLifecycle.posted_at),
      ),
    )
    .orderBy(desc(contentLifecycle.posted_at))
    .limit(20);
  const recentTexts = recent.map((r: { content_text: string }) => r.content_text);

  const results = await Promise.all([
    gate1_warmupCheck(content, db),
    Promise.resolve(gate2_lengthCheck(content)),
    gate3_frequencyCheck(accountId, db),
    Promise.resolve(gate4_duplicateCheck(content, recentTexts)),
    Promise.resolve(gate5_brandSafety(content)),
    Promise.resolve(gate6_qaPassCheck(qaScore)),
    gate7_dailyLimitCheck(accountId, db),
    gate8_captchaRisk(accountId, db),
  ]);

  const blockers = results.filter(r => !r.passed && r.severity === 'block');
  const warnings = results.filter(r => !r.passed && r.severity === 'warn');

  return {
    allPassed: blockers.length === 0,
    results,
    blockers,
    warnings,
  };
}
