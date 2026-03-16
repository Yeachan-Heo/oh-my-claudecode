#!/usr/bin/env tsx
/**
 * orchestrator.ts — 크롤링 오케스트레이터
 *
 * 로그인 → 채널 발굴 → 채널별 포스트 수집 → checkpoint 전체 흐름을 관리.
 *
 * Usage:
 *   npx tsx src/scraper/orchestrator.ts                  # 전체: 로그인→발굴→수집
 *   npx tsx src/scraper/orchestrator.ts --resume         # checkpoint에서 재개
 *   npx tsx src/scraper/orchestrator.ts --channels 5     # 채널 5개만
 *   npx tsx src/scraper/orchestrator.ts --posts 20       # 채널당 20포스트
 *   npx tsx src/scraper/orchestrator.ts --skip-discover  # 기존 채널 목록 사용
 */

import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import http from 'http';
import type {
  CrawlOptions,
  CrawlCheckpoint,
  ChannelCompletion,
  LoginResult,
  DiscoveryResult,
  DiscoveredChannel,
} from '../types.js';
import { loginThreads } from './login.js';
import { discoverChannels } from './discover.js';
import { saveCrawlSession } from './db-adapter.js';
import { sendAlert, sendErrorAlert } from '../utils/telegram.js';

// ─── Constants ──────────────────────────────────────────────

const PROJECT_ROOT = path.join(__dirname, '..', '..');
const SCRAPER_DIR = __dirname;
const DATA_DIR = path.join(PROJECT_ROOT, 'data');
const CHECKPOINT_PATH = path.join(DATA_DIR, 'threads-watch-checkpoint.json');
const DISCOVERED_CHANNELS_PATH = path.join(DATA_DIR, 'discovered_channels.json');
const HANDOFF_PATH = path.join(PROJECT_ROOT, 'handoff.md');

const CDP_URL = 'http://127.0.0.1:9223';

const DEFAULT_CHANNELS = 20;
const DEFAULT_POSTS_PER_CHANNEL = 40;
const MAX_RUNTIME_MS = 4 * 60 * 60 * 1000; // 4시간
const BLOCKED_RATE_THRESHOLD = 0.3; // 30%
const CHANNEL_DELAY = { min: 30_000, max: 120_000 }; // 30~120초

// ─── Exit codes (collect.ts) ──────────────────────────────

const EXIT_SUCCESS = 0;
const EXIT_BLOCKED = 3;
const EXIT_BUDGET_EXHAUSTED = 4;

// ─── Utility ────────────────────────────────────────────────

function log(msg: string): void {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`[${ts}] ${msg}`);
}

function randInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function generateRunId(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `run_${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}`;
}

function formatElapsed(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

// ─── Checkpoint I/O (atomic write) ──────────────────────────

function loadCheckpoint(): CrawlCheckpoint | null {
  try {
    const raw = fs.readFileSync(CHECKPOINT_PATH, 'utf8');
    return JSON.parse(raw) as CrawlCheckpoint;
  } catch {
    return null;
  }
}

function saveCheckpoint(cp: CrawlCheckpoint): void {
  cp.timestamp = new Date().toISOString();
  const tmpPath = CHECKPOINT_PATH + '.tmp';
  fs.writeFileSync(tmpPath, JSON.stringify(cp, null, 2));
  fs.renameSync(tmpPath, CHECKPOINT_PATH);

  // DB dual-write (fire-and-forget)
  saveCrawlSession(cp).catch((e) => {
    log(`DB checkpoint 저장 실패 (JSON은 정상): ${(e as Error).message}`);
  });
}

// ─── Handoff ────────────────────────────────────────────────

function writeHandoff(cp: CrawlCheckpoint, reason: string): void {
  const completed = cp.channels_completed.length;
  const totalCollected = cp.total_threads_collected;
  const remaining = cp.channels_queue.length;

  const content = `# Threads Watch 자동 이어하기

이전 세션에서 채널 수집이 중단되었습니다. 자동으로 이어서 수집합니다.

## 자동 실행
/threads-watch resume

## 진행 상태
- checkpoint: 쓰레드2/data/threads-watch-checkpoint.json
- 완료: ${completed}채널 / ${totalCollected}쓰레드
- 목표: ${cp.target_channels}채널
- 남은 채널 큐: ${remaining}개
- 세션: ${cp.session_count}회차
- 중단 사유: ${reason}
`;

  fs.writeFileSync(HANDOFF_PATH, content, 'utf8');
  log(`handoff.md 작성 완료: ${HANDOFF_PATH}`);
}

function deleteHandoff(): void {
  try {
    fs.unlinkSync(HANDOFF_PATH);
    log('handoff.md 삭제 완료');
  } catch {
    // 없으면 무시
  }
}

// ─── CDP Health Check ───────────────────────────────────────

function checkCDP(): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get(`${CDP_URL}/json/version`, { timeout: 5000 }, (res) => {
      let data = '';
      res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
      res.on('end', () => {
        try {
          JSON.parse(data);
          resolve(true);
        } catch {
          resolve(false);
        }
      });
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

async function ensureCDP(): Promise<boolean> {
  for (let attempt = 1; attempt <= 3; attempt++) {
    log(`CDP 연결 확인 (${attempt}/3)...`);
    const ok = await checkCDP();
    if (ok) {
      log('CDP 연결 성공');
      return true;
    }

    if (attempt < 3) {
      log('CDP 미연결 — Chrome 자동 실행 시도...');
      try {
        execSync(
          `powershell.exe -NoProfile -Command "Start-Process 'C:\\Users\\campu\\OneDrive\\Desktop\\Chrome (Claude).lnk'"`,
          { stdio: 'ignore', timeout: 10000 },
        );
      } catch {
        log('Chrome 실행 명령 실패');
      }
      await sleep(5000);
    }
  }

  log('CDP 연결 실패 (3회). Chrome을 수동으로 실행해주세요.');
  return false;
}

// ─── CLI Argument Parsing ───────────────────────────────────

function parseArgs(): CrawlOptions {
  const args = process.argv.slice(2);
  const opts: CrawlOptions = {};

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--resume':
        opts.resume = true;
        break;
      case '--skip-discover':
        opts.skipDiscover = true;
        break;
      case '--channels': {
        const val = parseInt(args[++i], 10);
        if (isNaN(val) || val <= 0) {
          console.error('--channels requires a positive integer');
          process.exit(1);
        }
        opts.channels = val;
        break;
      }
      case '--posts': {
        const val = parseInt(args[++i], 10);
        if (isNaN(val) || val <= 0) {
          console.error('--posts requires a positive integer');
          process.exit(1);
        }
        opts.postsPerChannel = val;
        break;
      }
      default:
        console.error(`Unknown argument: ${args[i]}`);
        console.error('Usage: npx tsx src/scraper/orchestrator.ts [--resume] [--channels N] [--posts N] [--skip-discover]');
        process.exit(1);
    }
  }

  return opts;
}

// ─── Collect Posts (child process) ──────────────────────────

interface CollectResult {
  exitCode: number;
  threadsCollected: number;
  stdout: string;
}

function collectPosts(channelId: string, postsCount: number): CollectResult {
  const collectScript = path.join(SCRAPER_DIR, 'collect.ts');
  const cmd = `npx tsx ${collectScript} --global --channel ${channelId} --posts ${postsCount}`;

  try {
    const stdout = execSync(cmd, {
      cwd: PROJECT_ROOT,
      encoding: 'utf8',
      stdio: 'pipe',
      timeout: 30 * 60 * 1000, // 30분 타임아웃
    });

    // stdout에서 수집된 포스트 수 추출
    const match = stdout.match(/쓰레드 단위:\s*(\d+)개/) || stdout.match(/수집 완료:\s*(\d+)/);
    const collected = match ? parseInt(match[1], 10) : 0;

    return { exitCode: EXIT_SUCCESS, threadsCollected: collected, stdout };
  } catch (err: unknown) {
    const execErr = err as { status?: number; stdout?: string; stderr?: string; message: string };
    const exitCode = execErr.status ?? 1;
    const stdout = execErr.stdout || '';
    const stderr = execErr.stderr || '';

    // stdout/stderr에서 수집된 포스트 수 추출 시도
    const combined = stdout + stderr;
    const match = combined.match(/쓰레드 단위:\s*(\d+)개/) || combined.match(/수집 완료:\s*(\d+)/);
    const collected = match ? parseInt(match[1], 10) : 0;

    if (exitCode === EXIT_BLOCKED) {
      log(`차단 감지: ${channelId}`);
    } else if (exitCode === EXIT_BUDGET_EXHAUSTED) {
      log(`예산 초과: ${channelId}`);
    } else {
      log(`수집 오류 (exit=${exitCode}): ${channelId}`);
      if (stderr) log(`stderr: ${stderr.slice(0, 200)}`);
    }

    return { exitCode, threadsCollected: collected, stdout: combined };
  }
}

// ─── Print Summary ──────────────────────────────────────────

function printSummary(cp: CrawlCheckpoint, elapsed: number): void {
  const completed = cp.channels_completed.length;
  const target = cp.target_channels;
  const blockedCount = cp.blocked_channels.length;

  console.log('\n' + '='.repeat(40));
  console.log('=== 크롤링 결과 ===');
  console.log('='.repeat(40));
  console.log(`채널: ${completed}/${target} 완료`);
  console.log(`포스트: ${cp.total_threads_collected}개 수집`);
  console.log(`차단: ${blockedCount}채널`);
  console.log(`상태: ${cp.status}`);
  console.log(`소요시간: ${formatElapsed(elapsed)}`);
  console.log('='.repeat(40));
}

// ─── Main Orchestration ─────────────────────────────────────

async function main(): Promise<void> {
  const opts = parseArgs();
  const startTime = Date.now();

  const targetChannels = opts.channels ?? DEFAULT_CHANNELS;
  const postsPerChannel = opts.postsPerChannel ?? DEFAULT_POSTS_PER_CHANNEL;

  log('크롤링 오케스트레이터 시작');
  log(`목표: ${targetChannels}채널 x ${postsPerChannel}포스트`);

  // ── 1. Checkpoint 확인 ─────────────────────────────────

  let checkpoint: CrawlCheckpoint | null = loadCheckpoint();

  if (checkpoint && opts.resume) {
    log(`기존 checkpoint 복원: ${checkpoint.channels_completed.length}채널 완료, 큐 ${checkpoint.channels_queue.length}개 남음`);
    checkpoint.session_count++;
    checkpoint.status = 'running';
    checkpoint.browser_ops_this_session = 0;
    saveCheckpoint(checkpoint);
  } else if (checkpoint && !opts.resume) {
    log(`기존 checkpoint 발견 (status=${checkpoint.status}). --resume 없이 새 수집을 시작합니다.`);
    checkpoint = null;
  }

  // ── 2. 헬스체크: CDP 연결 확인 ─────────────────────────

  const cdpOk = await ensureCDP();
  if (!cdpOk) {
    process.exit(1);
  }

  // ── 3. 로그인 ──────────────────────────────────────────

  log('로그인 확인 중...');
  let loginResult: LoginResult;
  try {
    loginResult = await loginThreads();
  } catch (err) {
    log(`로그인 실패: ${(err as Error).message}`);
    process.exit(1);
  }

  if (loginResult.status === 'needs_human') {
    log(`수동 개입 필요: ${loginResult.reason || 'unknown'}`);
    if (loginResult.screenshot) {
      log(`스크린샷: ${loginResult.screenshot}`);
    }
    await sendErrorAlert(`로그인 수동 개입 필요: ${loginResult.reason || 'unknown'}`, 'orchestrator > login').catch(() => {});
    process.exit(1);
  }

  if (loginResult.status === 'error') {
    log(`로그인 오류: ${loginResult.reason || 'unknown'}`);
    await sendErrorAlert(`로그인 오류: ${loginResult.reason || 'unknown'}`, 'orchestrator > login').catch(() => {});
    process.exit(1);
  }

  log('로그인 확인 완료');

  // ── 4. 채널 발굴 ──────────────────────────────────────

  let channelIds: string[];

  if (checkpoint && checkpoint.channels_queue.length > 0) {
    // resume: 기존 큐 사용
    channelIds = checkpoint.channels_queue;
    log(`기존 채널 큐 사용: ${channelIds.length}개`);
  } else if (opts.skipDiscover) {
    // --skip-discover: 파일에서 로드
    log('채널 발굴 건너뛰기 (--skip-discover)');
    try {
      const raw = fs.readFileSync(DISCOVERED_CHANNELS_PATH, 'utf8');
      const parsed = JSON.parse(raw);
      // Handle both formats: flat array or { channels: [...] }
      const channels: DiscoveredChannel[] = Array.isArray(parsed) ? parsed : (parsed.channels ?? []);
      channelIds = channels.map((c) => c.channel_id).slice(0, targetChannels);
      log(`discovered_channels.json에서 ${channelIds.length}개 채널 로드`);
    } catch {
      log(`채널 목록 파일 없음: ${DISCOVERED_CHANNELS_PATH}`);
      log('--skip-discover 없이 다시 실행하거나, discovered_channels.json을 준비해주세요.');
      process.exit(1);
    }
  } else {
    // 새 발굴
    log('채널 발굴 시작...');
    let discoveryResult: DiscoveryResult;
    try {
      // playwright Page 객체 획득 — loginThreads가 이미 연결했으므로
      // discoverChannels는 내부적으로 CDP 연결
      const { chromium } = await import('playwright');
      const browser = await chromium.connectOverCDP(CDP_URL);
      const contexts = browser.contexts();
      const context = contexts[0] || await browser.newContext();
      const pages = context.pages();
      const page = pages[0] || await context.newPage();

      discoveryResult = await discoverChannels(page, targetChannels, checkpoint ?? undefined);

      // disconnect (close 금지 — CDP)
      await browser.close().catch(() => {});
    } catch (err) {
      log(`채널 발굴 실패: ${(err as Error).message}`);
      process.exit(1);
    }

    // 발굴된 채널 저장
    fs.writeFileSync(
      DISCOVERED_CHANNELS_PATH,
      JSON.stringify(discoveryResult.channels, null, 2),
    );
    log(`채널 발굴 완료: ${discoveryResult.channels.length}개 발견, ${discoveryResult.stats.filtered}개 필터`);

    channelIds = discoveryResult.channels.map((c) => c.channel_id).slice(0, targetChannels);
  }

  if (channelIds.length === 0) {
    log('수집할 채널이 없습니다.');
    process.exit(0);
  }

  // ── 5. Checkpoint 초기화 (새 수집인 경우) ──────────────

  if (!checkpoint) {
    checkpoint = {
      run_id: generateRunId(),
      target_channels: targetChannels,
      target_posts_per_channel: postsPerChannel,
      channels_completed: [],
      channels_queue: [...channelIds],
      channels_discovered: [...channelIds],
      current_channel: null,
      current_channel_posts: [],
      total_threads_collected: 0,
      total_sheets_rows: 0,
      session_count: 1,
      browser_ops_this_session: 0,
      blocked_channels: [],
      timestamp: new Date().toISOString(),
      status: 'running',
    };
    saveCheckpoint(checkpoint);
    log(`새 checkpoint 생성: run_id=${checkpoint.run_id}`);
  }

  // ── 6. 채널별 수집 루프 ────────────────────────────────

  const totalChannels = checkpoint.channels_queue.length + checkpoint.channels_completed.length;
  let abortReason: string | null = null;

  while (checkpoint.channels_queue.length > 0) {
    const channelId = checkpoint.channels_queue[0];
    const completedSoFar = checkpoint.channels_completed.length;

    // 진행 상태 출력
    log(`\n[${ completedSoFar + 1}/${totalChannels}] 채널 수집 시작: @${channelId} (누적 ${checkpoint.total_threads_collected}포스트)`);

    // current_channel 업데이트
    checkpoint.current_channel = channelId;
    checkpoint.current_channel_posts = [];
    saveCheckpoint(checkpoint);

    // 수집 실행
    const result = collectPosts(channelId, postsPerChannel);

    if (result.exitCode === EXIT_SUCCESS) {
      // 성공
      const completion: ChannelCompletion = {
        channel_id: channelId,
        threads_collected: result.threadsCollected,
        session: checkpoint.session_count,
      };
      checkpoint.channels_completed.push(completion);
      checkpoint.channels_queue.shift();
      checkpoint.total_threads_collected += result.threadsCollected;
      checkpoint.current_channel = null;
      checkpoint.current_channel_posts = [];
      saveCheckpoint(checkpoint);

      log(`채널 완료: @${channelId} — ${result.threadsCollected}포스트 수집`);
    } else if (result.exitCode === EXIT_BLOCKED) {
      // 차단
      checkpoint.blocked_channels.push(channelId);
      checkpoint.channels_queue.shift();
      checkpoint.current_channel = null;
      checkpoint.current_channel_posts = [];
      saveCheckpoint(checkpoint);

      log(`채널 차단됨: @${channelId} — 다음 채널로 이동`);
      await sendErrorAlert(`채널 차단 감지: @${channelId}`, 'orchestrator > collectPosts').catch(() => {});

      // blocked_channel_rate 체크
      const blockedRate = checkpoint.blocked_channels.length /
        (checkpoint.channels_completed.length + checkpoint.blocked_channels.length || 1);
      if (blockedRate > BLOCKED_RATE_THRESHOLD) {
        abortReason = `차단 비율 초과 (${(blockedRate * 100).toFixed(0)}% > ${BLOCKED_RATE_THRESHOLD * 100}%)`;
        checkpoint.status = 'paused_blocked';
        saveCheckpoint(checkpoint);
        await sendErrorAlert(`🚫 차단 비율 초과로 크롤링 중단 (${(blockedRate * 100).toFixed(0)}%)`, 'orchestrator').catch(() => {});
        break;
      }
    } else if (result.exitCode === EXIT_BUDGET_EXHAUSTED) {
      // 예산 초과
      // 수집된 만큼은 기록
      if (result.threadsCollected > 0) {
        const completion: ChannelCompletion = {
          channel_id: channelId,
          threads_collected: result.threadsCollected,
          session: checkpoint.session_count,
        };
        checkpoint.channels_completed.push(completion);
        checkpoint.channels_queue.shift();
        checkpoint.total_threads_collected += result.threadsCollected;
      }
      checkpoint.current_channel = null;
      checkpoint.current_channel_posts = [];
      abortReason = '예산 초과 (browser_ops)';
      checkpoint.status = 'budget_exhausted';
      saveCheckpoint(checkpoint);
      break;
    } else {
      // 기타 오류 — 채널 건너뛰기
      checkpoint.channels_queue.shift();
      checkpoint.current_channel = null;
      checkpoint.current_channel_posts = [];
      saveCheckpoint(checkpoint);
      log(`채널 오류로 건너뛰기: @${channelId} (exit=${result.exitCode})`);
      await sendErrorAlert(`채널 수집 오류: @${channelId} (exit=${result.exitCode})`, 'orchestrator > collectPosts').catch(() => {});
    }

    // 시간 예산 체크 (4시간)
    const elapsed = Date.now() - startTime;
    if (elapsed > MAX_RUNTIME_MS) {
      abortReason = `시간 예산 초과 (${formatElapsed(elapsed)} > 4h)`;
      checkpoint.status = 'paused_context_limit';
      saveCheckpoint(checkpoint);
      break;
    }

    // 남은 채널이 있으면 대기
    if (checkpoint.channels_queue.length > 0) {
      const delay = randInt(CHANNEL_DELAY.min, CHANNEL_DELAY.max);
      log(`다음 채널까지 ${Math.round(delay / 1000)}초 대기...`);
      await sleep(delay);
    }
  }

  // ── 7. 완료/중단 처리 ──────────────────────────────────

  const elapsed = Date.now() - startTime;

  if (abortReason) {
    // 중단
    log(`\n수집 중단: ${abortReason}`);
    saveCheckpoint(checkpoint);
    writeHandoff(checkpoint, abortReason);
    await sendErrorAlert(`크롤링 중단: ${abortReason}\n채널: ${checkpoint.channels_completed.length}/${checkpoint.target_channels}\n포스트: ${checkpoint.total_threads_collected}개`, 'orchestrator').catch(() => {});
  } else {
    // 정상 완료
    checkpoint.status = 'completed';
    checkpoint.current_channel = null;
    checkpoint.current_channel_posts = [];
    saveCheckpoint(checkpoint);
    deleteHandoff();
    log('\n전체 수집 완료');
    await sendAlert(
      `✅ 크롤링 완료\n\n` +
      `📊 채널: ${checkpoint.channels_completed.length}/${checkpoint.target_channels}\n` +
      `📝 포스트: ${checkpoint.total_threads_collected}개\n` +
      `🚫 차단: ${checkpoint.blocked_channels.length}채널\n` +
      `⏱️ 소요: ${formatElapsed(elapsed)}`,
    ).catch(() => {});
  }

  printSummary(checkpoint, elapsed);
}

// ─── Entry ──────────────────────────────────────────────────

const isMainModule = process.argv[1] && (
  process.argv[1].endsWith('orchestrator.ts') ||
  process.argv[1].endsWith('orchestrator.js')
);

if (isMainModule) {
  main().catch((err) => {
    console.error('Orchestrator fatal error:', err);
    process.exit(1);
  });
}

export { main as orchestrateCrawl };
