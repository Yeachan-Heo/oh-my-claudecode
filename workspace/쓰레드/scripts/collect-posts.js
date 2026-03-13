#!/usr/bin/env node
/**
 * Threads Post Collector — Playwright CLI v2
 *
 * CDP(9223)로 열린 Chrome에 연결하여 Threads 채널의 포스트를 수집한다.
 * 결과를 JSON 파일로 저장하므로 Claude 컨텍스트를 소모하지 않는다.
 *
 * v2 변경점:
 *  - 훅 포스트 방문 → 본문 + 셀프답글 텍스트/미디어를 DOM 블록 기반으로 정확 추출
 *  - 셀프답글 URL 추출 후 답글 페이지 직접 방문하여 답글 조회수 확보
 *  - l.threads.com 리다이렉트 URL에서 실제 제휴링크 디코딩
 *  - 작성자명/UI 텍스트 필터링 강화
 *
 * Usage:
 *   Legacy:  node collect-posts.js <channel_id> [post_count] [--resume]
 *   Global:  node collect-posts.js --global --channel <id> [--posts N] [--resume]
 */

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const http = require('http');

// ─── Config ──────────────────────────────────────────────
const CDP_URL = 'http://127.0.0.1:9223';
const BASE_URL = 'https://www.threads.net';
const DATA_DIR = path.join(__dirname, '..', 'data', 'raw_posts');
const SEEN_POSTS_PATH = path.join(__dirname, '..', 'data', 'seen_posts.json');
const QUARANTINE_DIR = path.join(__dirname, '..', 'data', 'quarantine');
const GLOBAL_CHECKPOINT_PATH = path.join(__dirname, '..', 'data', 'threads-watch-checkpoint.json');

const TIMING = {
  pageLoad:     { min: 3000, max: 6000 },
  postRead:     { min: 2000, max: 5000 },
  betweenPosts: { min: 1500, max: 4000 },
  scrollPause:  { min: 800,  max: 2000 },
  longBreak:    { min: 45000, max: 120000 },
  mouseMove:    { min: 100,  max: 500 },
};
const LONG_BREAK_INTERVAL = { min: 12, max: 20 };

const AFF_TEXT_KEYWORDS = [
  '쿠팡파트너스', '수수료를 제공', '파트너스 활동',
  'link.coupang', 'coupa.ng',
];

// ─── Utility Functions ───────────────────────────────────

function gaussRandom(min, max) {
  const mean = (min + max) / 2;
  const stddev = (max - min) / 6;
  let u, v, s;
  do { u = Math.random() * 2 - 1; v = Math.random() * 2 - 1; s = u * u + v * v; }
  while (s >= 1 || s === 0);
  const mul = Math.sqrt(-2 * Math.log(s) / s);
  return Math.round(Math.max(min, Math.min(max, mean + stddev * u * mul)));
}

function randInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

async function humanDelay(timing) {
  const ms = gaussRandom(timing.min, timing.max);
  await new Promise(r => setTimeout(r, ms));
  return ms;
}

function getRunId() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `run_${now.getFullYear()}${pad(now.getMonth()+1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}`;
}

function log(msg) {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`[${ts}] ${msg}`);
}

// ─── Patch #1: Atomic Write ─────────────────────────────

function atomicWriteJSON(filePath, data) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmpPath = filePath + '.tmp';
  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf-8');
  fs.renameSync(tmpPath, filePath);
}

// ─── Patch #2: Persistent Dedup Ledger ──────────────────

let _seenPosts = {};

function loadSeenPosts() {
  try {
    if (fs.existsSync(SEEN_POSTS_PATH)) {
      const data = JSON.parse(fs.readFileSync(SEEN_POSTS_PATH, 'utf-8'));
      _seenPosts = data.posts || {};
      log(`📋 dedup 원장 로드: ${Object.keys(_seenPosts).length}개 기록`);
    } else {
      _seenPosts = {};
    }
  } catch (e) {
    log(`⚠️  seen_posts.json 로드 실패 — 빈 상태로 초기화: ${e.message}`);
    _seenPosts = {};
  }
}

function saveSeenPosts() {
  const data = {
    version: '1.0',
    updated_at: new Date().toISOString(),
    posts: _seenPosts,
  };
  atomicWriteJSON(SEEN_POSTS_PATH, data);
}

function isPostSeen(channelId, postId) {
  return _seenPosts[`${channelId}_${postId}`] === true;
}

function markPostSeen(channelId, postId) {
  _seenPosts[`${channelId}_${postId}`] = true;
}

// ─── Patch #4: Health Gate ──────────────────────────────

async function healthGate() {
  // Check 1: CDP connectivity
  try {
    await new Promise((resolve, reject) => {
      const req = http.get('http://127.0.0.1:9223/json/version', { timeout: 10000 }, (res) => {
        let body = '';
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => {
          if (res.statusCode === 200) resolve(body);
          else reject(new Error(`HTTP ${res.statusCode}`));
        });
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    });
    log('✅ CDP 연결 확인 완료');
  } catch (e) {
    log(`⚠️  CDP 연결 실패 — Chrome 자동 실행 시도...`);
    try {
      execSync('cmd.exe /c start "" "C:\\Users\\campu\\OneDrive\\Desktop\\Chrome (Claude).lnk"', {
        timeout: 5000, stdio: 'pipe',
      });
      // Wait for Chrome to start
      let connected = false;
      for (let i = 0; i < 10; i++) {
        await new Promise(r => setTimeout(r, 2000));
        try {
          await new Promise((resolve, reject) => {
            const req = http.get('http://127.0.0.1:9223/json/version', { timeout: 3000 }, (res) => {
              let body = '';
              res.on('data', (chunk) => { body += chunk; });
              res.on('end', () => {
                if (res.statusCode === 200) resolve(body);
                else reject(new Error(`HTTP ${res.statusCode}`));
              });
            });
            req.on('error', reject);
            req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
          });
          connected = true;
          break;
        } catch { /* retry */ }
      }
      if (!connected) throw new Error('Chrome started but CDP not responding after 20s');
      log('✅ Chrome 자동 실행 + CDP 연결 확인 완료');
    } catch (launchErr) {
      console.error(`❌ Chrome 자동 실행 실패: ${launchErr.message}`);
      console.error('   Chrome을 --remote-debugging-port=9223 으로 수동 실행하세요.');
      process.exit(1);
    }
  }

  // Check 2: gspread OAuth
  try {
    const pythonPath = path.join(__dirname, '..', '.venv', 'bin', 'python');
    execSync(`${pythonPath} -c "import gspread; gc = gspread.oauth(); gc.open_by_key('1U-m4sJvV_EyELTRk7ECDYXLLlvF8Kqf4YmrjzVnDJgE')"`, {
      timeout: 10000,
      stdio: 'pipe',
    });
    log('✅ gspread 인증 확인 완료');
  } catch (e) {
    console.error(`❌ gspread 인증 실패: ${e.message}`);
    console.error('   .venv/bin/python 경로와 OAuth 설정을 확인하세요.');
    process.exit(1);
  }
}

// ─── Patch #5: Validity Rate ────────────────────────────

function validateThreadUnit(unit) {
  const errors = [];

  // hook_post_id: non-empty + regex
  if (!unit.hook_post_id || !/^[A-Za-z0-9_-]+$/.test(unit.hook_post_id)) {
    errors.push(`hook_post_id 잘못됨: "${unit.hook_post_id || ''}"`);
  }

  // hook_date: ISO 8601
  if (!unit.hook_date || isNaN(Date.parse(unit.hook_date))) {
    errors.push(`hook_date 잘못됨: "${unit.hook_date || ''}"`);
  }

  // hook_text: non-empty
  if (!unit.hook_text || unit.hook_text.length === 0) {
    errors.push('hook_text 비어있음');
  }

  // channel_id: non-empty
  if (!unit.channel_id) {
    errors.push('channel_id 비어있음');
  }

  // hook_view_count: -1 → null (warn, not reject)
  if (unit.hook_view_count === -1) {
    log(`  ⚠️  hook_view_count=-1 → null 변환 (${unit.hook_post_id})`);
    unit.hook_view_count = null;
  }

  // reply_view_count: -1 → null (warn, not reject)
  if (unit.reply_view_count === -1) {
    log(`  ⚠️  reply_view_count=-1 → null 변환 (${unit.hook_post_id})`);
    unit.reply_view_count = null;
  }

  return { valid: errors.length === 0, errors };
}

function quarantineRecord(unit) {
  fs.mkdirSync(QUARANTINE_DIR, { recursive: true });
  const date = new Date().toISOString().slice(0, 10);
  const postId = unit.hook_post_id || 'unknown';
  const filePath = path.join(QUARANTINE_DIR, `${date}_${postId}.json`);
  atomicWriteJSON(filePath, unit);
}

// ─── Human-like Behavior ─────────────────────────────────

async function randomMouseMove(page) {
  const vp = page.viewportSize() || { width: 1280, height: 800 };
  const x = randInt(100, vp.width - 100);
  const y = randInt(100, vp.height - 100);
  await page.mouse.move(x, y, { steps: randInt(5, 15) });
  await humanDelay(TIMING.mouseMove);
}

async function humanScroll(page, direction = 'down') {
  const scrollAmount = direction === 'down' ? randInt(300, 800) : randInt(-400, -100);
  await page.mouse.wheel(0, scrollAmount);
  await humanDelay(TIMING.scrollPause);
  if (Math.random() < 0.2) {
    await page.mouse.wheel(0, -scrollAmount * 0.3);
    await humanDelay({ min: 300, max: 700 });
  }
}

async function idleBehavior(page) {
  const actions = randInt(2, 4);
  for (let i = 0; i < actions; i++) {
    const r = Math.random();
    if (r < 0.4) await randomMouseMove(page);
    else if (r < 0.7) await humanScroll(page, Math.random() < 0.3 ? 'up' : 'down');
    else await humanDelay({ min: 500, max: 2000 });
  }
}

async function longBreak(page, postNum) {
  const breakMs = gaussRandom(TIMING.longBreak.min, TIMING.longBreak.max);
  log(`  ☕ 긴 휴식 (${Math.round(breakMs / 1000)}초) — ${postNum}개 처리 후`);
  const chunks = randInt(3, 7);
  const chunkMs = breakMs / chunks;
  for (let i = 0; i < chunks; i++) {
    await new Promise(r => setTimeout(r, chunkMs));
    if (Math.random() < 0.5) await randomMouseMove(page);
  }
}

// ─── Data Extraction (v2 — DOM 블록 기반) ────────────────

/**
 * 훅 포스트 페이지에서 데이터 추출.
 *
 * Threads 포스트 상세 페이지 DOM 구조:
 *   region "칼럼 본문"
 *     ├ 블록1: 훅 본문 (프로필 + 텍스트 + 이미지 + 좋아요/답글 버튼)
 *     ├ 블록2: 셀프답글 (같은 작성자) — 있을 수도 없을 수도
 *     ├ 블록3+: 다른 사용자의 답글
 *     └ ...
 *
 * 각 블록은 cursor=pointer 속성이 있는 generic 요소.
 * 블록 안에서:
 *   - 작성자: a[href*="/@{channelId}"] → 텍스트에서 제외
 *   - 본문: 위 링크가 아닌 나머지 텍스트 노드
 *   - 이미지: img[src*="cdninstagram" or "scontent"] (width>100)
 *   - 좋아요/답글 수: button "좋아요 N", button "답글 N"
 *   - 제휴링크: a[href*="l.threads.com"] → URL 파라미터에서 실제 URL 디코딩
 */
async function extractHookPageData(page, channelId) {
  return page.evaluate((chId) => {
    // ── Helper: parse Korean numbers ──
    function parseNum(str) {
      if (!str) return 0;
      str = str.trim();
      if (str.includes('만')) return Math.round(parseFloat(str.replace('만','')) * 10000);
      if (str.includes('천')) return Math.round(parseFloat(str.replace('천','')) * 1000);
      return parseInt(str.replace(/,/g,''), 10) || 0;
    }

    // ── Helper: extract real URL from l.threads.com redirect ──
    function decodeThreadsRedirect(href) {
      try {
        const url = new URL(href);
        if (url.hostname === 'l.threads.com' || url.hostname === 'l.threads.net') {
          const realUrl = url.searchParams.get('u');
          if (realUrl) return decodeURIComponent(realUrl);
        }
      } catch (e) {}
      return href;
    }

    // ── Helper: extract affiliate links from a container ──
    function extractAffLinks(container) {
      const affDomains = ['coupang.com','coupa.ng','link.coupang.com','musinsa.com','smartstore.naver.com','ali.ski','bit.ly','han.gl'];
      const links = [];
      container.querySelectorAll('a[href]').forEach(a => {
        let realHref = decodeThreadsRedirect(a.href);
        for (const d of affDomains) {
          if (realHref.includes(d)) {
            links.push(realHref);
            break;
          }
        }
      });
      return [...new Set(links)]; // dedupe
    }

    // ── Helper: extract clean text from a block (filtering out author name, time, UI) ──
    function extractCleanText(block, authorId) {
      const skipExact = new Set([
        authorId, '팔로우', '더 보기', '좋아요', '답글', '리포스트',
        '공유하기', '인기순', '활동 보기', '원본 작성자가 좋아함',
        '수정됨', '작성자', '·',
      ]);
      const skipContains = [
        '님의 프로필 사진', '오디오 소리', 'Threads 사용자',
      ];
      const textParts = [];
      const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT, null);
      let node;
      while ((node = walker.nextNode())) {
        const text = node.textContent.trim();
        if (!text || text.length < 2) continue;
        const el = node.parentElement;
        if (!el) continue;
        // Skip if inside time, button, or img alt
        if (el.closest('time')) continue;
        if (el.closest('button')) continue;
        // Skip author link text
        if (el.closest(`a[href*="/@${authorId}"]`)) continue;
        // Skip exact matches
        if (skipExact.has(text)) continue;
        // Skip contains matches
        if (skipContains.some(p => text.includes(p))) continue;
        // Skip pure numbers (button counts, page indicators like "1 / 2")
        if (/^\d+$/.test(text)) continue;
        if (text === '/') continue;
        textParts.push(text);
      }
      // Deduplicate consecutive identical lines
      const deduped = [];
      for (const part of textParts) {
        if (deduped.length === 0 || deduped[deduped.length - 1] !== part) {
          deduped.push(part);
        }
      }
      return deduped.join('\n').substring(0, 1500);
    }

    // ── Helper: extract media URLs from a block ──
    function extractMedia(block) {
      const urls = [];
      block.querySelectorAll('img[src*="cdninstagram"], img[src*="scontent"]').forEach(img => {
        // Filter out profile pics and icons (small images)
        if (img.width > 100 && img.height > 100) urls.push(img.src);
      });
      block.querySelectorAll('video source[src], video[src]').forEach(v => {
        if (v.src) urls.push(v.src);
      });
      return [...new Set(urls)].slice(0, 10);
    }

    // ── Helper: extract button count (좋아요 N, 답글 N, etc) ──
    // Threads는 <button>이 아닌 <div role="button">을 사용한다.
    // textContent는 "좋아요8", "답글2" 형태 (아이콘은 SVG/CSS, img.alt 없음).
    function extractButtonCount(block, label) {
      const roleBtns = block.querySelectorAll('[role="button"]');
      for (const btn of roleBtns) {
        const text = (btn.textContent || '').replace(/\s+/g, '').trim();
        // Match "좋아요8" or "좋아요129" — label immediately followed by digits
        if (text.startsWith(label)) {
          const numPart = text.slice(label.length).replace(/,/g, '');
          const parsed = parseInt(numPart, 10);
          if (!isNaN(parsed) && parsed > 0) return parsed;
          // Button found but no number (e.g. "좋아요" with 0 likes)
          return 0;
        }
      }
      return 0;
    }

    // ══════════════════════════════════════
    // MAIN EXTRACTION
    // ══════════════════════════════════════

    // ── Page-level view count (from header) ──
    let viewCount = -1;
    // The header has "조회 N회" or "N views"
    const headerEl = document.querySelector('a[href*="/post/"]');
    if (headerEl) {
      const headerText = headerEl.textContent || '';
      const vmKo = headerText.match(/조회\s*([\d,.]+(?:\.\d+)?[만천]?)\s*회/);
      if (vmKo) viewCount = parseNum(vmKo[1]);
    }
    // Fallback: search all text
    if (viewCount <= 0) {
      const allText = document.body.innerText || '';
      const vmKo = allText.match(/조회\s*([\d,.]+(?:\.\d+)?[만천]?)\s*회/);
      if (vmKo) viewCount = parseNum(vmKo[1]);
      if (viewCount <= 0) {
        const vmEn = allText.match(/([\d,.]+(?:\.\d+)?[KkMm]?)\s*views?/i);
        if (vmEn) {
          let v = vmEn[1].replace(/,/g,'');
          if (/[Kk]$/.test(v)) viewCount = Math.round(parseFloat(v)*1000);
          else if (/[Mm]$/.test(v)) viewCount = Math.round(parseFloat(v)*1000000);
          else viewCount = parseInt(v, 10);
        }
      }
    }

    // ── Find post blocks inside "칼럼 본문" region ──
    const region = document.querySelector('[role="region"]') ||
                   document.querySelector('main') ||
                   document.body;

    // Post blocks: direct children with cursor=pointer or containing profile links
    // More reliable: find all blocks that contain a link to /@someone/post/XXX
    const allPostLinks = region.querySelectorAll('a[href*="/post/"]');
    const blockMap = new Map(); // postId → parent block element

    for (const link of allPostLinks) {
      const m = link.href.match(/\/@([^/]+)\/post\/([A-Za-z0-9_-]+)/);
      if (!m) continue;
      const [, author, postId] = m;
      // Only care about this channel's posts
      if (author !== chId) continue;
      // Walk up to find the containing block (usually 3-4 levels up to the cursor=pointer generic)
      let el = link;
      for (let i = 0; i < 8; i++) {
        el = el.parentElement;
        if (!el) break;
        // Block boundary: has profile image button as sibling/child
        const hasProfileBtn = el.querySelector(`button[aria-label*="${chId}"]`) ||
                              el.querySelector(`img[alt*="${chId}"]`);
        if (hasProfileBtn && !blockMap.has(postId)) {
          blockMap.set(postId, el);
          break;
        }
      }
    }

    // ── Identify hook block and self-reply block ──
    // The first block in DOM order with this page's post ID = hook
    // Any subsequent block by same author = self-reply
    const pageUrl = window.location.href;
    const pagePostIdMatch = pageUrl.match(/\/post\/([A-Za-z0-9_-]+)/);
    const pagePostId = pagePostIdMatch ? pagePostIdMatch[1] : '';

    let hookBlock = null;
    let replyBlock = null;
    let replyPostId = '';

    // Sort blocks by DOM position
    const sortedEntries = [...blockMap.entries()].sort((a, b) => {
      const posA = a[1].compareDocumentPosition(b[1]);
      return posA & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
    });

    for (const [postId, block] of sortedEntries) {
      if (postId === pagePostId) {
        hookBlock = block;
      } else if (hookBlock && !replyBlock) {
        // First block after hook by same author = self-reply
        replyBlock = block;
        replyPostId = postId;
      }
    }

    // C-2: Track which selector tier found the hook block
    let selectorTier = hookBlock ? 'aria-label' : 'fallback';

    // Fallback: if blockMap didn't work, use pressable containers
    if (!hookBlock) {
      const pressables = document.querySelectorAll('[data-pressable-container]');
      if (pressables.length > 0) { hookBlock = pressables[0]; selectorTier = 'data-pressable'; }
      if (pressables.length > 1) {
        const secondP = pressables[1];
        const authorLinks = secondP.querySelectorAll(`a[href*="/@${chId}"]`);
        if (authorLinks.length > 0) {
          replyBlock = secondP;
          // Try to get reply post ID from link
          const rpLink = secondP.querySelector(`a[href*="/post/"]`);
          if (rpLink) {
            const rpm = rpLink.href.match(/\/post\/([A-Za-z0-9_-]+)/);
            if (rpm) replyPostId = rpm[1];
          }
        }
      }
    }

    // ── Extract hook data ──
    let hookText = '';
    let hookMediaUrls = [];
    let hookLikeCount = 0;
    let hookReplyCount = 0;
    let hookRepostCount = 0;
    let hookHasImage = false;
    let hookDate = '';

    if (hookBlock) {
      hookText = extractCleanText(hookBlock, chId);
      hookMediaUrls = extractMedia(hookBlock);
      hookHasImage = hookMediaUrls.length > 0;
      hookLikeCount = extractButtonCount(hookBlock, '좋아요');
      hookReplyCount = extractButtonCount(hookBlock, '답글');
      hookRepostCount = extractButtonCount(hookBlock, '리포스트');

      const timeEl = hookBlock.querySelector('time[datetime]');
      if (timeEl) hookDate = timeEl.getAttribute('datetime');
    }

    // ── Extract self-reply data ──
    let selfReply = null;
    if (replyBlock) {
      const replyText = extractCleanText(replyBlock, chId);
      const replyMediaUrls = extractMedia(replyBlock);
      const replyLikeCount = extractButtonCount(replyBlock, '좋아요');
      const replyAffLinks = extractAffLinks(replyBlock);
      const affKeywords = ['쿠팡파트너스','수수료를 제공','파트너스 활동','link.coupang','coupa.ng'];
      const replyHasAff = affKeywords.some(kw => replyText.includes(kw)) || replyAffLinks.length > 0;

      // Reply URL
      let replyUrl = '';
      if (replyPostId) {
        replyUrl = `https://www.threads.net/@${chId}/post/${replyPostId}`;
      }

      selfReply = {
        postId: replyPostId,
        url: replyUrl,
        text: replyText,
        viewCount: -1, // Must visit reply page separately
        likeCount: replyLikeCount,
        mediaUrls: replyMediaUrls,
        affLinks: replyAffLinks,
        hasAffText: replyHasAff,
      };
    }

    // ── Hook-level affiliate links ──
    const hookAffLinks = hookBlock ? extractAffLinks(hookBlock) : [];
    const allText = document.body.innerText || '';
    const affKeywordsPage = ['쿠팡파트너스','수수료를 제공','파트너스 활동','link.coupang','coupa.ng'];
    const textHasAff = affKeywordsPage.some(kw => allText.includes(kw));

    return {
      hookText,
      viewCount,
      likeCount: hookLikeCount,
      replyCount: hookReplyCount,
      repostCount: hookRepostCount,
      postDate: hookDate,
      hasImage: hookHasImage,
      hookMediaUrls,
      hookAffLinks,
      textHasAff,
      selfReply,
      selectorTier,
    };
  }, channelId);
}

/**
 * 답글 페이지를 방문하여 조회수만 추출
 */
async function extractReplyViewCount(page) {
  return page.evaluate(() => {
    function parseNum(str) {
      if (!str) return 0;
      str = str.trim();
      if (str.includes('만')) return Math.round(parseFloat(str.replace('만','')) * 10000);
      if (str.includes('천')) return Math.round(parseFloat(str.replace('천','')) * 1000);
      return parseInt(str.replace(/,/g,''), 10) || 0;
    }

    let viewCount = -1;
    const headerEl = document.querySelector('a[href*="/post/"]');
    if (headerEl) {
      const headerText = headerEl.textContent || '';
      const vmKo = headerText.match(/조회\s*([\d,.]+(?:\.\d+)?[만천]?)\s*회/);
      if (vmKo) viewCount = parseNum(vmKo[1]);
    }
    if (viewCount <= 0) {
      const allText = document.body.innerText || '';
      const vmKo = allText.match(/조회\s*([\d,.]+(?:\.\d+)?[만천]?)\s*회/);
      if (vmKo) viewCount = parseNum(vmKo[1]);
      if (viewCount <= 0) {
        const vmEn = allText.match(/([\d,.]+(?:\.\d+)?[KkMm]?)\s*views?/i);
        if (vmEn) {
          let v = vmEn[1].replace(/,/g,'');
          if (/[Kk]$/.test(v)) viewCount = Math.round(parseFloat(v)*1000);
          else if (/[Mm]$/.test(v)) viewCount = Math.round(parseFloat(v)*1000000);
          else viewCount = parseInt(v, 10);
        }
      }
    }
    return viewCount;
  });
}

// ─── Feed Scrolling ──────────────────────────────────────

// Patch #3: Channel Exhaustion Tag — returns { postIds, status }
async function collectPostIds(page, channelId, targetCount) {
  log(`📜 피드 스크롤 시작 — 목표: ${targetCount}개`);
  await page.goto(`${BASE_URL}/@${channelId}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await humanDelay(TIMING.pageLoad);

  const collected = new Set();
  let noNewCount = 0;
  let status = 'ok';

  while (collected.size < targetCount && noNewCount < 3) {
    const ids = await page.evaluate(() => {
      const links = document.querySelectorAll('a[href*="/post/"]');
      const ids = new Set();
      links.forEach(a => {
        const m = a.href.match(/\/post\/([A-Za-z0-9_-]+)/);
        if (m) ids.add(m[1]);
      });
      return [...ids];
    });

    const before = collected.size;
    ids.forEach(id => collected.add(id));
    const added = collected.size - before;

    if (added === 0) noNewCount++;
    else noNewCount = 0;

    log(`  스크롤: ${collected.size}/${targetCount} (+${added})`);
    if (collected.size >= targetCount) break;

    await humanScroll(page, 'down');
    await humanScroll(page, 'down');
    await humanDelay(TIMING.scrollPause);
    if (Math.random() < 0.3) await randomMouseMove(page);
  }

  if (noNewCount >= 3 && collected.size < targetCount) {
    status = 'exhausted';
    log(`📋 채널 소진: ${collected.size}개 수집 (목표 ${targetCount}개)`);
  }

  log(`📜 피드 스크롤 완료 — ${collected.size}개 수집`);
  return { postIds: [...collected], status };
}

// ─── Thread Unit Builder ─────────────────────────────────

// Patch #6: Output Field Extension — added runId, loginStatus params
function buildThreadUnit(hookData, channelId, runId, loginStatus) {
  const sr = hookData.selfReply;
  const hasAff = hookData.textHasAff ||
    hookData.hookAffLinks.length > 0 ||
    (sr && sr.hasAffText) ||
    (sr && sr.affLinks.length > 0);

  let threadType = '비광고';
  let linkLocation = '없음';
  let linkUrl = '';
  let linkDomain = '';

  if (hasAff) {
    const hookHasLink = hookData.hookAffLinks.length > 0;
    const replyHasLink = sr && (sr.affLinks.length > 0 || sr.hasAffText);

    if (sr) {
      threadType = '쓰레드형';
      if (hookHasLink && replyHasLink) linkLocation = 'both';
      else if (replyHasLink) linkLocation = '답글';
      else linkLocation = '본문';
    } else {
      threadType = '단독형';
      linkLocation = '본문';
    }

    const allLinks = [...hookData.hookAffLinks, ...(sr ? sr.affLinks : [])];
    if (allLinks.length > 0) {
      linkUrl = allLinks[0];
      try { linkDomain = new URL(linkUrl).hostname.replace('www.', ''); }
      catch { linkDomain = ''; }
    }
    if (!linkDomain) {
      const combined = hookData.hookText + ' ' + (sr ? sr.text : '');
      if (combined.includes('coupang.com') || combined.includes('link.coupang')) linkDomain = 'coupang.com';
      else if (combined.includes('musinsa')) linkDomain = 'musinsa.com';
      else if (combined.includes('smartstore.naver')) linkDomain = 'smartstore.naver.com';
    }
  } else if (sr) {
    threadType = '쓰레드형';
  }

  let conversionRate = null;
  if (sr && sr.viewCount > 0 && hookData.viewCount > 0) {
    conversionRate = Math.round((sr.viewCount / hookData.viewCount) * 1000) / 10;
  }

  // category는 빈값 — 수집 완료 후 Claude가 텍스트 분석으로 동적 분류
  const category = '';

  return {
    channel_id: channelId,
    display_name: '',
    follower_count: 0,
    category,
    hook_post_id: hookData.postId,
    hook_post_url: hookData.url,
    hook_date: hookData.postDate,
    hook_text: hookData.hookText,
    hook_view_count: hookData.viewCount,
    hook_like_count: hookData.likeCount,
    hook_reply_count: hookData.replyCount,
    hook_repost_count: hookData.repostCount,
    hook_has_image: hookData.hasImage,
    hook_media_urls: hookData.hookMediaUrls || [],
    reply_post_id: sr ? sr.postId : '',
    reply_post_url: hookData.url,
    reply_text: sr ? sr.text : '',
    reply_view_count: sr ? sr.viewCount : null,
    reply_like_count: sr ? sr.likeCount : null,
    reply_media_urls: sr ? sr.mediaUrls : [],
    conversion_rate: conversionRate,
    thread_type: threadType,
    link_location: linkLocation,
    link_url: linkUrl,
    link_domain: linkDomain,
    // Patch #6: new fields
    tags: { primary: 'general', secondary: [] },
    crawl_meta: {
      crawl_at: new Date().toISOString(),
      run_id: runId,
      selector_tier: hookData.selectorTier || 'fallback',
      login_status: loginStatus,
      block_detected: false,
    },
    permalink: hookData.url,
  };
}

// ─── Checkpoint ──────────────────────────────────────────

function loadCheckpoint(channelId, runId) {
  const cpPath = path.join(DATA_DIR, `checkpoint_${channelId}.json`);
  if (fs.existsSync(cpPath)) {
    const cp = JSON.parse(fs.readFileSync(cpPath, 'utf-8'));
    log(`📋 체크포인트 발견: ${cp.completedHooks.length}개 완료`);
    return cp;
  }
  return { runId, channelId, completedHooks: [], postIds: [], threadUnits: [] };
}

// Patch #1: saveCheckpoint uses atomicWriteJSON
function saveCheckpoint(cp) {
  const cpPath = path.join(DATA_DIR, `checkpoint_${cp.channelId}.json`);
  atomicWriteJSON(cpPath, cp);
}

function clearCheckpoint(channelId) {
  const cpPath = path.join(DATA_DIR, `checkpoint_${channelId}.json`);
  if (fs.existsSync(cpPath)) fs.unlinkSync(cpPath);
}

// ─── B-Stage: CLI Argument Parser ────────────────────────

function parseArgs() {
  const args = process.argv.slice(2);
  const hasGlobal = args.includes('--global');

  if (hasGlobal) {
    // Global mode: --global --channel <id> [--posts N] [--resume]
    const chIdx = args.indexOf('--channel');
    if (chIdx === -1 || !args[chIdx + 1]) {
      console.error('Usage: node collect-posts.js --global --channel <id> [--posts N] [--resume]');
      process.exit(1);
    }
    const channelId = args[chIdx + 1];
    let postCount = 20;
    const postsIdx = args.indexOf('--posts');
    if (postsIdx !== -1 && args[postsIdx + 1]) {
      postCount = parseInt(args[postsIdx + 1], 10) || 20;
    }
    const isResume = args.includes('--resume');
    return { mode: 'global', channelId, postCount, isResume };
  }

  // Legacy mode: <channel_id> [post_count] [--resume]
  if (args.length < 1 || args[0].startsWith('--')) {
    console.error('Usage: node collect-posts.js <channel_id> [post_count] [--resume]');
    process.exit(1);
  }
  const channelId = args[0];
  const postCount = parseInt(args[1], 10) || 40;
  const isResume = args.includes('--resume');
  return { mode: 'legacy', channelId, postCount, isResume };
}

// ─── B-Stage: Global Checkpoint ─────────────────────────

function loadGlobalCheckpoint(runId, channelId) {
  if (fs.existsSync(GLOBAL_CHECKPOINT_PATH)) {
    try {
      const cp = JSON.parse(fs.readFileSync(GLOBAL_CHECKPOINT_PATH, 'utf-8'));
      log(`📋 글로벌 체크포인트 로드: state=${cp.state}, browser_ops=${cp.budget.browser_ops}`);
      return cp;
    } catch (e) {
      log(`⚠️  글로벌 체크포인트 파싱 실패 — 새로 생성: ${e.message}`);
    }
  }
  // Create new global checkpoint
  return {
    version: '1.0',
    run_id: runId,
    state: 'collect',
    channels: {
      completed: [],
      queue: [],
      current: channelId,
      blocked: [],
      exhausted: [],
    },
    budget: {
      browser_ops: 0,
      browser_ops_limit: 150,
      channels_completed_count: 0,
      channels_limit: 3,
    },
    overlap_resume: {
      enabled: true,
      overlap_count: 20,
      current_channel_tail: [],
    },
    telemetry: {
      stages_completed: [],
      errors: [],
      selector_stats: { tier1_rate: 0, tier2_rate: 0, tier3_rate: 0 },
      validity_rate: 0,
    },
    session_count: 1,
    timestamp: new Date().toISOString(),
    status: 'active',
  };
}

function saveGlobalCheckpoint(gcp) {
  gcp.timestamp = new Date().toISOString();
  atomicWriteJSON(GLOBAL_CHECKPOINT_PATH, gcp);
}

// ─── C-4: Error Telemetry Helper ────────────────────────

function recordError(type, message, recovered, atPost) {
  if (!_globalCheckpoint || !_globalCheckpoint.telemetry) return;
  _globalCheckpoint.telemetry.errors.push({
    type, recovered, at_post: atPost ?? null,
    message: (message || '').substring(0, 200),
    timestamp: new Date().toISOString(),
  });
  saveGlobalCheckpoint(_globalCheckpoint);
}

// ─── B-Stage: Budget-Tracked page.goto ──────────────────

let _globalCheckpoint = null;

async function trackedGoto(page, url, options) {
  const result = await page.goto(url, options);
  if (_globalCheckpoint) {
    _globalCheckpoint.budget.browser_ops++;
    saveGlobalCheckpoint(_globalCheckpoint);
    if (_globalCheckpoint.budget.browser_ops >= _globalCheckpoint.budget.browser_ops_limit) {
      log(`🚫 예산 소진: browser_ops=${_globalCheckpoint.budget.browser_ops} >= ${_globalCheckpoint.budget.browser_ops_limit}`);
      _globalCheckpoint.status = 'budget_exhausted';
      _globalCheckpoint.handoff_reason = 'browser_ops budget exhausted';
      saveGlobalCheckpoint(_globalCheckpoint);
      process.exit(4);
    }
  }
  return result;
}

// ─── B-Stage: 10-Post Health Check ──────────────────────

async function healthCheckAt10(page, processedCount, globalMode) {
  if (processedCount === 0 || processedCount % 10 !== 0) return true;
  log(`  🏥 10포스트 주기 헬스 체크 (${processedCount}번째)`);

  for (let attempt = 0; attempt < 2; attempt++) {
    // Check CDP connectivity
    let cdpOk = false;
    try {
      await new Promise((resolve, reject) => {
        const req = http.get('http://127.0.0.1:9223/json/version', { timeout: 5000 }, (res) => {
          let body = '';
          res.on('data', (chunk) => { body += chunk; });
          res.on('end', () => {
            if (res.statusCode === 200) resolve(body);
            else reject(new Error(`HTTP ${res.statusCode}`));
          });
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
      });
      cdpOk = true;
    } catch (e) {
      log(`  ⚠️  CDP 연결 실패 (시도 ${attempt + 1}/2): ${e.message}`);
    }

    // Check login status
    let loginOk = false;
    try {
      loginOk = await checkLoginStatus(page);
    } catch { loginOk = false; }

    if (cdpOk && loginOk) {
      log(`  ✅ 헬스 체크 통과`);
      return true;
    }

    if (attempt === 0) {
      log(`  ⚠️  헬스 체크 실패 — 재연결 시도...`);
      await new Promise(r => setTimeout(r, 3000));
    }
  }

  // Both attempts failed
  log(`  ❌ 헬스 체크 2회 실패 — 세션 만료`);
  recordError('login_expiry', 'health check failed after 2 retries', false, processedCount);
  if (_globalCheckpoint) {
    _globalCheckpoint.status = 'paused_session_expired';
    _globalCheckpoint.handoff_reason = 'health check failed after 2 retries';
    saveGlobalCheckpoint(_globalCheckpoint);
  }
  return false;
}

// ─── Session Check ───────────────────────────────────────

async function checkLoginStatus(page) {
  try {
    return page.evaluate(() => {
      const profileLinks = document.querySelectorAll('a[href*="/@"]');
      let hasLogin = false;
      document.querySelectorAll('a, button').forEach(b => {
        if ((b.textContent || '').includes('로그인') || (b.textContent || '').includes('Log in'))
          hasLogin = true;
      });
      return profileLinks.length > 2 && !hasLogin;
    });
  } catch { return false; }
}

// ─── Main ────────────────────────────────────────────────

/**
 * Core collection loop — shared between legacy and global modes.
 * The `gotoFn` parameter abstracts page.goto so that global mode can use trackedGoto.
 * Returns { threadUnits, validCount, totalCount, channelInfo, outputPath }.
 */
async function runCollection({ channelId, postCount, isResume, runId, page, gotoFn, globalMode }) {
  // Patch #7: Load taxonomy version
  let taxonomyVersion = '0.0';
  try {
    const tax = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'taxonomy.json'), 'utf-8'));
    taxonomyVersion = tax.version || '0.0';
    log(`📖 taxonomy v${taxonomyVersion} 로드`);
  } catch (e) {
    log('⚠️  taxonomy.json 로드 실패 — 기본값 사용');
  }

  fs.mkdirSync(DATA_DIR, { recursive: true });

  // Check login status early for buildThreadUnit
  let loggedIn = true;
  try {
    loggedIn = await checkLoginStatus(page);
  } catch { loggedIn = false; }

  let cp = isResume ? loadCheckpoint(channelId, runId)
    : { runId, channelId, completedHooks: [], postIds: [], threadUnits: [] };

  // Patch #5: validity tracking
  let validCount = 0;
  let totalCount = 0;

  // C-2: Selector tier counters
  const selectorCounts = { 'aria-label': 0, 'data-pressable': 0, 'fallback': 0 };

  // B-Stage: Overlap-resume — load tail from global checkpoint
  let overlapTail = new Set();
  if (globalMode && isResume && _globalCheckpoint) {
    const completedEntry = _globalCheckpoint.channels.completed.find(c => c.channel_id === channelId);
    if (completedEntry && _globalCheckpoint.overlap_resume.current_channel_tail.length > 0) {
      overlapTail = new Set(_globalCheckpoint.overlap_resume.current_channel_tail);
      log(`📋 overlap-resume: ${overlapTail.size}개 tail ID 로드`);
    }
  }

  try {
    // Step 1: Collect post IDs from feed
    let postIds;
    if (cp.postIds.length > 0 && isResume) {
      postIds = cp.postIds;
      log(`📋 체크포인트에서 ${postIds.length}개 포스트 ID 로드`);
    } else {
      // Feed scrolling inlined here to use gotoFn (budget tracking in global mode)
      // and support overlap-resume detection during scroll
      log(`📜 피드 스크롤 시작 — 목표: ${postCount}개`);
      await gotoFn(page, `${BASE_URL}/@${channelId}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await humanDelay(TIMING.pageLoad);

      const collected = new Set();
      let noNewCount = 0;
      let feedStatus = 'ok';
      let overlapHit = false;

      while (collected.size < postCount && noNewCount < 3 && !overlapHit) {
        const ids = await page.evaluate(() => {
          const links = document.querySelectorAll('a[href*="/post/"]');
          const ids = new Set();
          links.forEach(a => {
            const m = a.href.match(/\/post\/([A-Za-z0-9_-]+)/);
            if (m) ids.add(m[1]);
          });
          return [...ids];
        });

        const before = collected.size;
        for (const id of ids) {
          // B-Stage: overlap-resume detection
          if (overlapTail.size > 0 && overlapTail.has(id)) {
            log(`  📋 overlap-resume: tail ID ${id} 도달 — 이미 수집 구간`);
            overlapHit = true;
            break;
          }
          collected.add(id);
        }
        const added = collected.size - before;

        if (added === 0 && !overlapHit) noNewCount++;
        else noNewCount = 0;

        log(`  스크롤: ${collected.size}/${postCount} (+${added})`);
        if (collected.size >= postCount) break;
        if (overlapHit) break;

        await humanScroll(page, 'down');
        await humanScroll(page, 'down');
        await humanDelay(TIMING.scrollPause);
        if (Math.random() < 0.3) await randomMouseMove(page);
      }

      if (noNewCount >= 3 && collected.size < postCount) {
        feedStatus = 'exhausted';
        log(`📋 채널 소진: ${collected.size}개 수집 (목표 ${postCount}개)`);
      }

      log(`📜 피드 스크롤 완료 — ${collected.size}개 수집`);
      postIds = [...collected];

      if (feedStatus === 'exhausted') {
        log(`⚠️  채널이 소진되었지만 ${postIds.length}개로 계속 진행`);
      }
      cp.postIds = postIds;
      saveCheckpoint(cp);
    }

    // Step 2: Visit each post — extract hook + self-reply + reply view count
    const completedSet = new Set(cp.completedHooks);
    const remaining = postIds.filter(id => !completedSet.has(id));
    // Also filter out IDs that are already known as reply IDs
    const knownReplyIds = new Set(cp.threadUnits.map(tu => tu.reply_post_id).filter(Boolean));
    // B-Stage: filter out overlap tail IDs
    const skipIds = new Set([...overlapTail]);

    log(`📊 처리 대상: ${remaining.length}개 (완료: ${completedSet.size}개, 답글로 확인됨: ${knownReplyIds.size}개)`);

    let nextLongBreak = randInt(LONG_BREAK_INTERVAL.min, LONG_BREAK_INTERVAL.max);
    let processedSinceBreak = 0;
    let processedCount = 0; // B-Stage: absolute count for 10-post health check

    for (let i = 0; i < remaining.length; i++) {
      const pid = remaining[i];

      // Skip if this post was already identified as a reply to another hook
      if (knownReplyIds.has(pid)) {
        log(`  ⏭️  ${pid} — 이미 답글로 식별됨, skip`);
        completedSet.add(pid);
        cp.completedHooks.push(pid);
        continue;
      }

      // Patch #2: dedup check
      if (isPostSeen(channelId, pid)) {
        log(`  ⏭️  ${pid} — dedup skip (이전 런에서 수집됨)`);
        completedSet.add(pid);
        cp.completedHooks.push(pid);
        continue;
      }

      // B-Stage: overlap tail skip
      if (skipIds.has(pid)) {
        log(`  ⏭️  ${pid} — overlap tail skip`);
        completedSet.add(pid);
        cp.completedHooks.push(pid);
        continue;
      }

      const url = `${BASE_URL}/@${channelId}/post/${pid}`;
      const progress = `[${completedSet.size + 1}/${postIds.length}]`;

      try {
        // ── Visit hook page ──
        log(`${progress} 🔍 ${pid}`);
        await gotoFn(page, url, { waitUntil: 'domcontentloaded', timeout: 20000 });
        await humanDelay(TIMING.pageLoad);
        await idleBehavior(page);

        const hookData = await extractHookPageData(page, channelId);
        hookData.postId = pid;
        hookData.url = url;
        // C-2: Track selector tier
        if (hookData.selectorTier && selectorCounts[hookData.selectorTier] !== undefined)
          selectorCounts[hookData.selectorTier]++;
        else selectorCounts['fallback']++;

        // ── If self-reply detected, visit reply page for view count ──
        if (hookData.selfReply && hookData.selfReply.postId) {
          const replyUrl = hookData.selfReply.url;
          log(`${progress}   ↳ 답글 조회수 확인: ${hookData.selfReply.postId}`);

          await humanDelay(TIMING.betweenPosts);
          await gotoFn(page, replyUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
          await humanDelay(TIMING.postRead);

          const replyViewCount = await extractReplyViewCount(page);
          hookData.selfReply.viewCount = replyViewCount;

          // Mark reply ID so we skip it in the main loop
          knownReplyIds.add(hookData.selfReply.postId);

          log(`${progress}   ↳ 답글 조회수: ${replyViewCount >= 0 ? replyViewCount.toLocaleString() : '?'}`);
        }

        // ── Build thread unit (Patch #6: pass runId and loginStatus) ──
        const threadUnit = buildThreadUnit(hookData, channelId, runId, loggedIn);

        // ── Patch #5: Validate thread unit ──
        totalCount++;
        const validation = validateThreadUnit(threadUnit);
        if (!validation.valid) {
          log(`${progress} ⚠️  유효성 실패: ${validation.errors.join(', ')}`);
          quarantineRecord(threadUnit);
        } else {
          validCount++;
        }

        cp.threadUnits.push(threadUnit);
        cp.completedHooks.push(pid);
        completedSet.add(pid);

        // Patch #2: mark as seen
        markPostSeen(channelId, pid);
        if (hookData.selfReply && hookData.selfReply.postId) {
          cp.completedHooks.push(hookData.selfReply.postId);
          completedSet.add(hookData.selfReply.postId);
          markPostSeen(channelId, hookData.selfReply.postId);
        }

        // ── Log ──
        const viewStr = hookData.viewCount >= 0 ? hookData.viewCount.toLocaleString() : '?';
        const typeStr = threadUnit.thread_type;
        const convStr = threadUnit.conversion_rate !== null ? ` conv=${threadUnit.conversion_rate}%` : '';
        const affStr = threadUnit.link_domain ? ` [${threadUnit.link_domain}]` : '';
        log(`${progress} ✅ views=${viewStr} ${typeStr}${convStr}${affStr}`);

        // Checkpoint every 5 thread units
        if (cp.threadUnits.length % 5 === 0) {
          saveCheckpoint(cp);
          log(`  💾 체크포인트 저장 (${cp.threadUnits.length}개 쓰레드)`);
        }

        await humanDelay(TIMING.betweenPosts);

        processedSinceBreak++;
        processedCount++;

        // B-Stage: 10-post health check (AC-5)
        if (globalMode) {
          const healthOk = await healthCheckAt10(page, processedCount, globalMode);
          if (!healthOk) {
            saveCheckpoint(cp);
            saveSeenPosts();
            process.exit(5);
          }
          // B-Stage: update overlap tail (keep last 20 processed IDs)
          if (_globalCheckpoint) {
            const tail = _globalCheckpoint.overlap_resume.current_channel_tail;
            tail.push(pid);
            if (tail.length > 20) tail.splice(0, tail.length - 20);
          }
        }

        // Long break (legacy mode uses existing random interval; global mode also uses it)
        if (processedSinceBreak >= nextLongBreak && i < remaining.length - 1) {
          await longBreak(page, processedSinceBreak);
          processedSinceBreak = 0;
          nextLongBreak = randInt(LONG_BREAK_INTERVAL.min, LONG_BREAK_INTERVAL.max);

          loggedIn = await checkLoginStatus(page);
          if (!loggedIn) {
            log('⚠️  로그인 풀림 감지!');
            saveCheckpoint(cp);
            saveSeenPosts();
            if (globalMode && _globalCheckpoint) {
              _globalCheckpoint.status = 'paused_session_expired';
              _globalCheckpoint.handoff_reason = 'login expired during long break';
              saveGlobalCheckpoint(_globalCheckpoint);
            }
            console.error('SESSION_EXPIRED');
            process.exit(5);
          }
        }

      } catch (e) {
        log(`${progress} ❌ ${pid}: ${e.message}`);
        recordError('post_error', e.message, true, processedCount);
        if (e.message.includes('429') || e.message.includes('503') || e.message.includes('blocked')) {
          log('🚫 차단 감지!');
          recordError('blocked', e.message, false, processedCount);
          saveCheckpoint(cp);
          saveSeenPosts();
          if (globalMode && _globalCheckpoint) {
            _globalCheckpoint.status = 'paused_blocked';
            _globalCheckpoint.handoff_reason = 'block detected: ' + e.message;
            saveGlobalCheckpoint(_globalCheckpoint);
          }
          console.error('BLOCKED');
          process.exit(3);
        }
        cp.completedHooks.push(pid);
        completedSet.add(pid);
      }
    }

    // Patch #2: Save dedup ledger at end
    saveSeenPosts();
    log(`📋 dedup 원장 저장: ${Object.keys(_seenPosts).length}개 기록`);

    // Step 3: Get channel info
    let channelInfo = { display_name: channelId, follower_count: 0, category: '기타' };
    try {
      await gotoFn(page, `${BASE_URL}/@${channelId}`, { waitUntil: 'domcontentloaded', timeout: 15000 });
      await humanDelay(TIMING.pageLoad);
      channelInfo = await page.evaluate(() => {
        const allText = document.body.innerText || '';
        let followers = 0;
        const fm = allText.match(/팔로워\s*([\d,.]+(?:\.\d+)?[만천]?)\s*명/);
        if (fm) {
          let v = fm[1];
          if (v.includes('만')) followers = Math.round(parseFloat(v.replace('만',''))*10000);
          else if (v.includes('천')) followers = Math.round(parseFloat(v.replace('천',''))*1000);
          else followers = parseInt(v.replace(/,/g,''), 10);
        }
        if (followers === 0) {
          const fmEn = allText.match(/([\d,.]+[KkMm]?)\s*followers?/i);
          if (fmEn) {
            let v = fmEn[1].replace(/,/g,'');
            if (/[Kk]$/.test(v)) followers = Math.round(parseFloat(v)*1000);
            else if (/[Mm]$/.test(v)) followers = Math.round(parseFloat(v)*1000000);
            else followers = parseInt(v, 10);
          }
        }
        const name = document.querySelector('h1, [role="heading"]');
        return {
          display_name: name ? name.textContent.trim() : '',
          follower_count: followers || 0,
          category: '기타',
        };
      });
    } catch (e) {
      log(`⚠️  채널 정보 수집 실패: ${e.message}`);
    }

    for (const tu of cp.threadUnits) {
      tu.display_name = channelInfo.display_name;
      tu.follower_count = channelInfo.follower_count;
      // category는 buildThreadUnit에서 포스트 텍스트 기반으로 분류됨 — 덮어쓰지 않음
    }

    // Step 4: Save results
    const outputPath = path.join(DATA_DIR, `${channelId}_${runId}.json`);
    const output = {
      meta: {
        run_id: runId,
        channel_id: channelId,
        channel_info: channelInfo,
        thread_units: cp.threadUnits.length,
        ad_count: cp.threadUnits.filter(t => t.thread_type !== '비광고').length,
        non_ad_count: cp.threadUnits.filter(t => t.thread_type === '비광고').length,
        collected_at: new Date().toISOString(),
        // Patch #7: Dependency gate stub
        taxonomy_version: taxonomyVersion,
        schema_version: '1.0',
      },
      thread_units: cp.threadUnits,
    };

    // Patch #1: Use atomicWriteJSON for final result save
    atomicWriteJSON(outputPath, output);
    log(`💾 결과 저장: ${outputPath}`);
    clearCheckpoint(channelId);

    // Step 5: Sheets 업로드는 Claude가 카테고리 분류 후 수동 실행
    log('📋 카테고리 분류 대기 — Claude가 JSON을 읽고 분류 후 Sheets 업로드 예정');
    log(`   업로드 명령: .venv/bin/python scripts/upload-sheets.py ${outputPath}`);

    // Patch #5: Validity rate check
    if (totalCount > 0) {
      const validityRate = validCount / totalCount;
      log(`📊 유효성 비율: ${(validityRate * 100).toFixed(1)}% (${validCount}/${totalCount})`);
      if (validityRate < 0.9) {
        log(`⚠️  유효성 비율 ${(validityRate * 100).toFixed(1)}% < 90% — 경고`);
      }
    }

    // Summary
    const tus = cp.threadUnits;
    log('');
    log('═══════════════════════════════════════');
    log(`📊 수집 완료 — @${channelId}`);
    log(`   팔로워: ${channelInfo.follower_count.toLocaleString()}`);
    log(`   쓰레드 단위: ${tus.length}개`);
    log(`   ├ 쓰레드형: ${tus.filter(t => t.thread_type === '쓰레드형').length}개`);
    log(`   ├ 단독형: ${tus.filter(t => t.thread_type === '단독형').length}개`);
    log(`   └ 비광고: ${tus.filter(t => t.thread_type === '비광고').length}개`);
    const withConv = tus.filter(t => t.conversion_rate !== null);
    if (withConv.length > 0) {
      const avgConv = withConv.reduce((s, t) => s + t.conversion_rate, 0) / withConv.length;
      log(`   평균 전환율: ${avgConv.toFixed(1)}%`);
    }
    const viewCounts = tus.map(t => t.hook_view_count).filter(v => v !== null && v > 0);
    if (viewCounts.length > 0) {
      const avgViews = viewCounts.reduce((a, b) => a + b, 0) / viewCounts.length;
      log(`   평균 훅 조회수: ${Math.round(avgViews).toLocaleString()}`);
    }
    log(`   출력: ${outputPath}`);
    log('═══════════════════════════════════════');

    return { threadUnits: tus, validCount, totalCount, channelInfo, outputPath, selectorCounts };

  } catch (e) {
    log(`❌ 치명적 오류: ${e.message}`);
    saveCheckpoint(cp);
    saveSeenPosts();
    if (globalMode && _globalCheckpoint) {
      _globalCheckpoint.status = 'error';
      _globalCheckpoint.handoff_reason = 'fatal error: ' + e.message;
      saveGlobalCheckpoint(_globalCheckpoint);
    }
    console.error(e);
    process.exit(1);
  }
}

async function main() {
  const parsed = parseArgs();
  const { mode, channelId, postCount, isResume } = parsed;
  const globalMode = mode === 'global';
  const runId = getRunId();

  log(`🚀 수집 시작: @${channelId} — ${postCount}개 포스트 (v2${globalMode ? ' global' : ''})`);
  log(`   Run ID: ${runId}`);
  if (isResume) log('   ↻ 이전 체크포인트에서 이어서 수집');
  if (globalMode) log('   🌐 글로벌 체크포인트 모드');

  // Patch #4: Health gate before CDP connect
  await healthGate();

  // Patch #2: Load dedup ledger
  loadSeenPosts();

  // B-Stage: Initialize global checkpoint if in global mode
  if (globalMode) {
    _globalCheckpoint = loadGlobalCheckpoint(runId, channelId);
    _globalCheckpoint.state = 'collect';
    _globalCheckpoint.channels.current = channelId;
    _globalCheckpoint.status = 'active';
    saveGlobalCheckpoint(_globalCheckpoint);
  }

  // Connect to Chrome
  let browser, context, page;
  try {
    browser = await chromium.connectOverCDP(CDP_URL);
    const contexts = browser.contexts();
    context = contexts[0];
    const pages = context.pages();
    page = pages[0] || await context.newPage();
    log('🔗 Chrome CDP 연결 성공');
  } catch (e) {
    console.error(`❌ Chrome CDP 연결 실패: ${e.message}`);
    if (globalMode && _globalCheckpoint) {
      _globalCheckpoint.status = 'error';
      _globalCheckpoint.handoff_reason = 'CDP connection failed';
      saveGlobalCheckpoint(_globalCheckpoint);
    }
    process.exit(1);
  }

  // Choose goto function: global mode uses trackedGoto, legacy uses page.goto directly
  const gotoFn = globalMode
    ? trackedGoto
    : (p, url, opts) => p.goto(url, opts);

  const result = await runCollection({
    channelId, postCount, isResume, runId, page, gotoFn, globalMode,
  });

  // B-Stage: Update global checkpoint on successful completion
  if (globalMode && _globalCheckpoint) {
    // Record frontier — last post from threadUnits
    const lastUnit = result.threadUnits[result.threadUnits.length - 1];
    const frontier = lastUnit
      ? { last_post_id: lastUnit.hook_post_id, last_timestamp: lastUnit.hook_date || new Date().toISOString() }
      : { last_post_id: '', last_timestamp: new Date().toISOString() };

    // Move channel from current to completed
    _globalCheckpoint.channels.completed.push({
      channel_id: channelId,
      threads_collected: result.threadUnits.length,
      frontier,
      status: 'completed',
      track: 'marketer',  // C-5: dual-track stub (consumer track added later)
    });
    _globalCheckpoint.channels.current = null;
    _globalCheckpoint.state = 'next_channel';
    _globalCheckpoint.budget.channels_completed_count++;
    // C-1: Update telemetry
    if (_globalCheckpoint.telemetry) {
      _globalCheckpoint.telemetry.validity_rate = result.totalCount > 0
        ? +(result.validCount / result.totalCount).toFixed(3) : 0;
      if (!_globalCheckpoint.telemetry.stages_completed.includes('collect'))
        _globalCheckpoint.telemetry.stages_completed.push('collect');
      // C-2: Selector stats
      const sc = result.selectorCounts;
      const total = sc['aria-label'] + sc['data-pressable'] + sc['fallback'];
      if (total > 0) {
        _globalCheckpoint.telemetry.selector_stats = {
          tier1_rate: +(sc['data-pressable'] / total).toFixed(3),
          tier2_rate: +(sc['aria-label'] / total).toFixed(3),
          tier3_rate: +(sc['fallback'] / total).toFixed(3),
        };
      }
    }
    _globalCheckpoint.status = 'active';
    _globalCheckpoint.handoff_reason = null;
    saveGlobalCheckpoint(_globalCheckpoint);
    log(`🌐 글로벌 체크포인트 업데이트: state=next_channel, browser_ops=${_globalCheckpoint.budget.browser_ops}`);

    // C-3: Save run telemetry file
    try {
      const telDir = path.join(__dirname, '..', 'data', 'telemetry');
      fs.mkdirSync(telDir, { recursive: true });
      const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, '');
      const telPath = path.join(telDir, `${dateStr}_run.json`);
      const telData = {
        run_id: _globalCheckpoint.run_id,
        channel_id: channelId,
        timestamp: new Date().toISOString(),
        threads_collected: result.threadUnits.length,
        browser_ops: _globalCheckpoint.budget.browser_ops,
        validity_rate: _globalCheckpoint.telemetry?.validity_rate ?? 0,
        selector_stats: _globalCheckpoint.telemetry?.selector_stats ?? {},
        errors: _globalCheckpoint.telemetry?.errors ?? [],
      };
      // Append to existing file or create new
      let runs = [];
      if (fs.existsSync(telPath)) {
        try { runs = JSON.parse(fs.readFileSync(telPath, 'utf-8')); } catch {}
      }
      runs.push(telData);
      atomicWriteJSON(telPath, runs);
      log(`📊 텔레메트리 저장: ${telPath}`);
    } catch (e) {
      log(`⚠️  텔레메트리 저장 실패: ${e.message}`);
    }
  }

  // Patch #5: Exit code 2 if validity rate below threshold
  if (result.totalCount > 0 && (result.validCount / result.totalCount) < 0.9) {
    if (globalMode && _globalCheckpoint) {
      _globalCheckpoint.status = 'error';
      _globalCheckpoint.handoff_reason = 'validity rate below 0.9';
      saveGlobalCheckpoint(_globalCheckpoint);
    }
    process.exit(2);
  }

  process.exit(0);
}

main();
