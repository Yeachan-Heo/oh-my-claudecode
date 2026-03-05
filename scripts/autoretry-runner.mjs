#!/usr/bin/env node
/**
 * omc-autoretry runner
 *
 * Runs `claude -p "<prompt>" --dangerously-skip-permissions` in a working
 * directory, detects rate-limit errors from stdout/stderr, waits the required
 * cool-down period, then resumes via `claude --continue -p "..."
 * --dangerously-skip-permissions` — all without human intervention.
 *
 * Usage:
 *   node autoretry-runner.mjs --prompt "..." --work-dir "/abs/path" [--session-name "omc-autoretry-xxxx"]
 *
 * The runner exits 0 on success, 1 on 3 consecutive non-rate-limit failures.
 */

import { spawnSync, spawn } from 'child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, createWriteStream } from 'fs';
import { join, resolve } from 'path';
import { homedir } from 'os';
import { randomBytes } from 'crypto';

// ─── Config ───────────────────────────────────────────────────────────────────

const CLAUDE_BIN    = process.env.CLAUDE_BIN || 'claude';
const MAX_FAILURES  = 3;          // consecutive non-rate-limit failures → abort
const DEFAULT_WAIT  = 5 * 3600;  // seconds — fallback when no time parsed

const OMC_CONFIG = join(homedir(), '.claude', '.omc-config.json');

// ─── CLI args ─────────────────────────────────────────────────────────────────

function argValue(flag) {
  const idx = process.argv.indexOf(flag);
  return idx !== -1 ? process.argv[idx + 1] : null;
}

const promptArg      = argValue('--prompt');
const workDirArg     = argValue('--work-dir');
const sessionNameArg = argValue('--session-name'); // optional: tmux session name

if (!promptArg) {
  console.error('Error: --prompt "<text>" is required');
  process.exit(1);
}
if (!workDirArg) {
  console.error('Error: --work-dir "/abs/path" is required');
  process.exit(1);
}

const WORK_DIR = resolve(workDirArg);

if (!existsSync(WORK_DIR)) {
  console.error(`Error: --work-dir does not exist: ${WORK_DIR}`);
  process.exit(1);
}

// ─── Paths ────────────────────────────────────────────────────────────────────

const SESSION_ID   = randomBytes(4).toString('hex');
const LOG_DIR      = join(WORK_DIR, '.omc', 'logs', 'autoretry');
const LOG_FILE     = join(LOG_DIR, `${SESSION_ID}.log`);
const STATE_DIR    = join(WORK_DIR, '.omc', 'state');
const STATUS_FILE  = join(STATE_DIR, `autoretry-${SESSION_ID}-status.json`);

mkdirSync(LOG_DIR,   { recursive: true });
mkdirSync(STATE_DIR, { recursive: true });

// ─── Helpers ──────────────────────────────────────────────────────────────────

function log(msg) {
  const ts = new Date().toISOString();
  console.log(`[omc-autoretry ${ts}] ${msg}`);
}

// Serialized write lock — prevents concurrent read-modify-write races
let writeLock = Promise.resolve();

function writeStatus(patch) {
  writeLock = writeLock.then(() => {
    let current = {};
    try {
      if (existsSync(STATUS_FILE)) {
        current = JSON.parse(readFileSync(STATUS_FILE, 'utf8'));
      }
    } catch { /* start fresh */ }
    const next = { ...current, ...patch };
    writeFileSync(STATUS_FILE, JSON.stringify(next, null, 2), 'utf8');
    // NOTE: do NOT reset writeLock here — that would orphan any queued writes
  });
  return writeLock;
}

// ─── Rate-limit detection ─────────────────────────────────────────────────────

// Patterns matched case-insensitively against accumulated output chunks.
// Kept specific to avoid false positives on legitimate task output.
const RATE_LIMIT_PATTERNS = [
  /rate\s+limit/i,
  /try\s+again\s+in\s+\d/i,           // require a digit after "in" to reduce false positives
  /you'?ve\s+hit\s+your\s+limit/i,
  /\bHTTP\s*429\b|\bstatus\s+(?:code\s+)?429\b|\berror\s+429\b/i,  // 429 with context
  /claude\s+is\s+overloaded/i,        // specific — NOT bare "overloaded"
];

function isRateLimit(text) {
  return RATE_LIMIT_PATTERNS.some(re => re.test(text));
}

/**
 * Parse a wait duration in seconds from a rate-limit message.
 * Recognises forms like:
 *   "5 hours", "5h", "5h 0m", "5h30m", "300 minutes", "45 minutes"
 * Returns DEFAULT_WAIT if nothing found.
 */
function parseWaitSeconds(text) {
  // "Xh Ym" or "XhYm"
  const hm = text.match(/(\d+)\s*h(?:ours?)?\s*(?:(\d+)\s*m(?:in(?:utes?)?)?)?/i);
  if (hm) {
    const h = parseInt(hm[1], 10);
    const m = hm[2] ? parseInt(hm[2], 10) : 0;
    return h * 3600 + m * 60;
  }
  // "X minutes"
  const mins = text.match(/(\d+)\s*min(?:utes?)?/i);
  if (mins) return parseInt(mins[1], 10) * 60;

  return DEFAULT_WAIT;
}

// ─── Notifications ────────────────────────────────────────────────────────────

function sendNotification(title, body) {
  try {
    if (existsSync(OMC_CONFIG)) {
      const cfg = JSON.parse(readFileSync(OMC_CONFIG, 'utf8'));
      const n = cfg.notifications ?? {};
      if (n.telegram?.enabled && n.telegram?.botToken && n.telegram?.chatId) {
        const payload = JSON.stringify({ chat_id: n.telegram.chatId, text: `${title}\n${body}` });
        spawnSync('curl', [
          '-s', '-X', 'POST',
          `https://api.telegram.org/bot${n.telegram.botToken}/sendMessage`,
          '-H', 'Content-Type: application/json',
          '-d', payload,
        ], { timeout: 10_000 });
        return;
      }
      if (n.discord?.enabled && n.discord?.webhookUrl) {
        const payload = JSON.stringify({ content: `**${title}**\n${body}` });
        spawnSync('curl', [
          '-s', '-X', 'POST', n.discord.webhookUrl,
          '-H', 'Content-Type: application/json',
          '-d', payload,
        ], { timeout: 10_000 });
        return;
      }
    }
  } catch { /* fall through to system notifications */ }

  // macOS — use argument array; strip newlines before JSON-quoting for AppleScript compat
  try {
    const safeBody  = body.replace(/[\r\n]+/g, ' ');
    const safeTitle = title.replace(/[\r\n]+/g, ' ');
    spawnSync('osascript', [
      '-e', `display notification ${JSON.stringify(safeBody)} with title ${JSON.stringify(safeTitle)}`,
    ], { timeout: 5_000 });
  } catch { /* non-critical */ }

  // Linux — argument array, no shell
  try {
    spawnSync('notify-send', [title, body], { timeout: 5_000 });
  } catch { /* non-critical */ }
}

// ─── Countdown logger ─────────────────────────────────────────────────────────

/**
 * Logs a countdown to the console every minute.
 * Uses wall-clock anchor so drift doesn't affect wait accuracy.
 * Returns a Promise that resolves after waitSeconds seconds have elapsed.
 */
function countdown(waitSeconds, logStream) {
  return new Promise((resolve) => {
    const waitUntil = Date.now() + waitSeconds * 1000;

    const tick = () => {
      const remaining = Math.max(0, Math.ceil((waitUntil - Date.now()) / 1000));
      const h = Math.floor(remaining / 3600);
      const m = Math.floor((remaining % 3600) / 60);
      const s = remaining % 60;
      const line = `[omc-autoretry] Rate-limit wait: ${h}h ${m}m ${s}s remaining`;
      log(line);
      if (logStream && !logStream.destroyed) logStream.write(`\n${line}`);

      if (remaining <= 0) {
        resolve();
      } else {
        setTimeout(tick, Math.min(60_000, remaining * 1000));
      }
    };

    tick();
  });
}

// ─── Claude runner ────────────────────────────────────────────────────────────

let activeChild = null;  // module-level — for signal handler cleanup
let logStream   = null;  // module-level — for .catch() flush on fatal error

/**
 * Spawns a claude process, streams output to terminal + logStream.
 * Resolves with { code, rateLimited, waitSeconds }.
 */
function runClaude(args, logStream) {
  return new Promise((resolveP) => {
    const child = spawn(CLAUDE_BIN, args, {
      cwd: WORK_DIR,
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    activeChild = child;

    let logClosed = false;
    let outputBuffer = ''; // last ~4 KB of output for rate-limit scanning

    child.on('error', (err) => {
      logClosed = true;
      activeChild = null;
      if (!logStream.destroyed) logStream.write(`\n# Spawn error: ${err.message}\n`);
      resolveP({ code: 1, rateLimited: false, waitSeconds: 0 });
    });

    function handleChunk(chunk) {
      const text = chunk.toString();
      outputBuffer += text;
      // Truncate at newline boundary to avoid splitting rate-limit messages
      if (outputBuffer.length > 4096) {
        const trimmed = outputBuffer.slice(-4096);
        const nl = trimmed.indexOf('\n');
        outputBuffer = nl !== -1 ? trimmed.slice(nl + 1) : trimmed;
      }
      if (!logStream.destroyed) logStream.write(text);
    }

    child.stdout.on('data', (d) => { process.stdout.write(d); handleChunk(d); });
    child.stderr.on('data', (d) => { process.stderr.write(d); handleChunk(d); });

    child.on('close', (code) => {
      activeChild = null;
      if (logClosed) return;

      const finishedAt = new Date().toISOString();
      if (!logStream.destroyed) {
        logStream.write(`\n\n# Finished: ${finishedAt} — exit code: ${code}\n`);
      }

      const rateLimited = isRateLimit(outputBuffer);
      const waitSeconds = rateLimited ? parseWaitSeconds(outputBuffer) : 0;
      resolveP({ code, rateLimited, waitSeconds });
    });
  });
}

// ─── Main loop ────────────────────────────────────────────────────────────────

async function main() {
  log(`Session ID  : ${SESSION_ID}`);
  log(`Prompt      : ${promptArg.slice(0, 80)}${promptArg.length > 80 ? '...' : ''}`);
  log(`Work dir    : ${WORK_DIR}`);
  log(`Log file    : ${LOG_FILE}`);
  if (sessionNameArg) log(`tmux session: ${sessionNameArg}`);

  // Open a persistent log stream for the whole session (module-level for .catch() flush)
  logStream = createWriteStream(LOG_FILE, { flags: 'w' });
  logStream.on('error', (err) => log(`Log stream error: ${err.message}`));
  logStream.write([
    `# omc-autoretry session: ${SESSION_ID}`,
    `# Prompt: ${promptArg}`,
    `# Directory: ${WORK_DIR}`,
    `# Started: ${new Date().toISOString()}`,
    '',
  ].join('\n'));

  // Graceful shutdown — kill active child, flush log
  function shutdown(signal) {
    log(`Received ${signal} — shutting down`);
    if (activeChild) {
      activeChild.kill('SIGTERM');
      activeChild = null;
    }
    writeStatus({ status: 'cancelled', cancelledAt: new Date().toISOString() }).then(() => {
      logStream.end(`\n# Cancelled by ${signal}\n`, () => process.exit(130));
    });
  }
  process.on('SIGINT',  () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  // Write initial status
  await writeStatus({
    sessionId: SESSION_ID,
    tmuxSession: sessionNameArg ?? null,
    prompt: promptArg,
    status: 'running',
    waitUntil: null,
    attempt: 1,
    logFile: LOG_FILE,
    startedAt: new Date().toISOString(),
  });

  let attempt          = 1;
  let consecutiveFails = 0;
  let useOriginalPrompt = true; // first run always uses original prompt

  // eslint-disable-next-line no-constant-condition
  while (true) {
    // Guard: re-check work-dir existence before each spawn
    if (!existsSync(WORK_DIR)) {
      log(`FATAL: work-dir no longer exists: ${WORK_DIR}`);
      await writeStatus({ status: 'failed', error: 'work-dir removed', failedAt: new Date().toISOString() });
      logStream.end('\n# FATAL: work-dir removed\n', () => process.exit(1));
      return;
    }

    const args = useOriginalPrompt
      ? ['-p', promptArg, '--dangerously-skip-permissions']
      : ['--continue', '-p', 'The previous session was interrupted by a rate limit. Please continue the task where you left off.', '--dangerously-skip-permissions'];

    const attemptLabel = useOriginalPrompt ? 'initial run' : `rate-limit resume (attempt ${attempt})`;
    log(`Starting ${attemptLabel}`);
    logStream.write(`\n\n# === Attempt ${attempt}: ${attemptLabel} — ${new Date().toISOString()} ===\n\n`);

    await writeStatus({ status: 'running', attempt });

    const { code, rateLimited, waitSeconds } = await runClaude(args, logStream);

    if (code === 0) {
      log(`Completed successfully (attempt ${attempt})`);
      logStream.write(`\n# === Session complete: exit 0 ===\n`);
      await writeStatus({ status: 'completed', completedAt: new Date().toISOString() });
      sendNotification(
        'omc-autoretry: Complete ✅',
        `"${promptArg.slice(0, 80)}" finished after ${attempt} attempt(s). Log: ${LOG_FILE}`
      );
      logStream.end(() => process.exit(0));
      return;
    }

    if (rateLimited) {
      consecutiveFails = 0;
      useOriginalPrompt = false; // resume via --continue after rate limit
      attempt += 1;

      const waitUntil = new Date(Date.now() + waitSeconds * 1000).toISOString();
      const h = Math.floor(waitSeconds / 3600);
      const m = Math.floor((waitSeconds % 3600) / 60);
      log(`Rate limited — waiting ${h}h ${m}m (until ${waitUntil})`);
      logStream.write(`\n# Rate limit detected. Waiting ${waitSeconds}s until ${waitUntil}\n`);

      await writeStatus({ status: 'waiting', waitUntil, attempt });
      sendNotification(
        'omc-autoretry: Rate limited ⏳',
        `Will resume in ${h}h ${m}m. Session: ${SESSION_ID}`
      );

      await countdown(waitSeconds, logStream);

      log(`Wait complete — resuming`);
      logStream.write(`\n# Wait complete — resuming at ${new Date().toISOString()}\n`);
    } else {
      // Non-rate-limit failure: retry from original prompt for a clean slate
      consecutiveFails += 1;
      useOriginalPrompt = true; // reset to original prompt — don't --continue a failed session
      attempt += 1;

      log(`Non-rate-limit exit (code ${code}) — consecutive failures: ${consecutiveFails}/${MAX_FAILURES}`);
      logStream.write(`\n# Exit code ${code} (not a rate limit). Will retry with original prompt. Consecutive failures: ${consecutiveFails}/${MAX_FAILURES}\n`);

      if (consecutiveFails >= MAX_FAILURES) {
        log(`Aborting after ${MAX_FAILURES} consecutive non-rate-limit failures`);
        await writeStatus({ status: 'failed', failedAt: new Date().toISOString() });
        sendNotification(
          'omc-autoretry: Failed ❌',
          `"${promptArg.slice(0, 80)}" failed ${MAX_FAILURES}x in a row. Log: ${LOG_FILE}`
        );
        logStream.end('\n# === ABORTED: too many failures ===\n', () => process.exit(1));
        return;
      }

      // Brief back-off (30s) before retrying
      log(`Retrying in 30 seconds...`);
      await new Promise(r => setTimeout(r, 30_000));
    }
  }
}

main().catch((err) => {
  console.error(`[omc-autoretry] Fatal error: ${err.message}`);
  if (logStream && !logStream.destroyed) {
    logStream.end(`\n# FATAL: ${err.message}\n`, () => process.exit(1));
  } else {
    process.exit(1);
  }
});
