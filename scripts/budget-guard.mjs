#!/usr/bin/env node

/**
 * Stop Hook: run-budget guard (E2).
 *
 * Enforces OMC_RUN_BUDGET_TOKENS for unattended sessions: when an active
 * mode (ralph, autopilot, team, ultragoal) is running and the session's
 * token spend crosses the budget, the hook stops the stop — the model is
 * sent back to finish with a resumable budget report.
 *
 * Rollout is tri-state (mirrors the jev off/shadow/active protocol):
 *   OMC_BUDGET_ENFORCE=off     — do nothing
 *   OMC_BUDGET_ENFORCE=shadow  — log judgments to the enforcement shadow
 *                                log, never block or warn (default)
 *   OMC_BUDGET_ENFORCE=active  — warn at 90%, block at 100%
 *
 * Token accounting reads assistant-message usage from a bounded transcript
 * tail. Repeated records for the same message/request use the latest usage
 * snapshot, so content-block records are not counted multiple times. The tail
 * can undercount a long session. A missing/unreadable transcript degrades to
 * a pass with a `degraded` log line: this hook must never block on absent
 * evidence.
 */

import { closeSync, existsSync, fstatSync, openSync, readFileSync, readSync } from 'fs';
import { join } from 'path';
import { readStdin } from './lib/stdin.mjs';
import { resolveOmcStateRoot } from './lib/state-root.mjs';
import { logEnforcement } from './lib/enforcement-log.mjs';

const GUARDED_MODES = ['ralph', 'autopilot', 'team', 'ultragoal'];
const TRANSCRIPT_TAIL_BYTES = 2 * 1024 * 1024;

function modeStatePath(stateRoot, mode, sessionId) {
  // session-scoped first, legacy fallback (mirrors resolveSessionStatePaths)
  const scoped = sessionId ? join(stateRoot, 'state', 'sessions', sessionId, `${mode}-state.json`) : null;
  if (scoped && existsSync(scoped)) return scoped;
  return join(stateRoot, 'state', `${mode}-state.json`);
}

async function activeUnattendedMode(stateRoot, sessionId) {
  for (const mode of GUARDED_MODES) {
    try {
      const path = modeStatePath(stateRoot, mode, sessionId);
      if (!existsSync(path)) continue;
      const state = JSON.parse(readFileSync(path, 'utf8'));
      if (state && state.active === true) return mode;
    } catch {
      // unreadable state files never trigger the guard
    }
  }
  return null;
}

/**
 * Sum assistant-message usage over a bounded tail of the transcript.
 * @returns {number|null} total tokens, or null when the transcript is
 *   missing/unreadable (degraded — never estimate).
 */
function transcriptTokenSpend(transcriptPath) {
  if (!transcriptPath || !existsSync(transcriptPath)) return null;
  let text;
  let start = 0;
  let fd;
  try {
    fd = openSync(transcriptPath, 'r');
    const size = fstatSync(fd).size;
    start = Math.max(0, size - TRANSCRIPT_TAIL_BYTES);
    const length = size - start;
    const buffer = Buffer.allocUnsafe(length);
    let offset = 0;
    while (offset < length) {
      const bytesRead = readSync(fd, buffer, offset, length - offset, start + offset);
      if (bytesRead === 0) return null;
      offset += bytesRead;
    }
    text = buffer.toString('utf8');
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // A close failure does not change the transcript-read outcome.
      }
    }
  }
  // Drop the first partial line when the tail cut mid-record.
  if (start > 0) {
    const firstNewline = text.indexOf('\n');
    if (firstNewline !== -1) text = text.slice(firstNewline + 1);
  }
  const usageByMessage = new Map();
  let lineNumber = 0;
  for (const line of text.split('\n')) {
    lineNumber += 1;
    if (!line.trim()) continue;
    try {
      const record = JSON.parse(line);
      if (record?.type !== 'assistant') continue;
      const usage = record?.message?.usage;
      if (!usage) continue;
      const messageId = record?.message?.id;
      const requestId = record?.requestId;
      const key =
        typeof messageId === 'string' && messageId
          ? `message:${messageId}`
          : typeof requestId === 'string' && requestId
            ? `request:${requestId}`
            : `line:${lineNumber}`;
      // Claude Code can append multiple usage snapshots for one message.
      // Keep the latest snapshot rather than summing duplicate content blocks.
      usageByMessage.set(key, usage);
    } catch {
      // non-JSON lines contribute nothing
    }
  }
  let total = 0;
  for (const usage of usageByMessage.values()) {
    total +=
      (usage.input_tokens ?? 0) +
      (usage.output_tokens ?? 0) +
      (usage.cache_read_input_tokens ?? 0) +
      (usage.cache_creation_input_tokens ?? 0);
  }
  return total;
}

function blockReason({ mode, spend, budget }) {
  const percent = Math.round((spend / budget) * 100);
  return [
    `Run budget exhausted: ~${spend} of ${budget} tokens (${percent}%) during this ${mode} run.`,
    'Stop now with a budget report so the session is resumable:',
    '- what was completed and verified (fresh evidence only)',
    '- what remains (state files and progress artifacts are preserved)',
    '- the resume pointer (re-enter the mode to continue from artifacts)',
    'Budget exhaustion is a stop condition, not a failure — do not start new work.',
  ].join('\n');
}

async function main() {
  const started = Date.now();
  const enforce = process.env.OMC_BUDGET_ENFORCE || 'shadow';
  if (enforce === 'off') process.exit(0);

  const budget = Number(process.env.OMC_RUN_BUDGET_TOKENS);
  if (!Number.isFinite(budget) || budget <= 0) process.exit(0);

  const raw = await readStdin(3000);
  let payload = null;
  try {
    payload = JSON.parse(raw);
  } catch {
    process.exit(0);
  }

  const cwd = typeof payload?.cwd === 'string' && payload.cwd ? payload.cwd : process.cwd();
  const sessionId = typeof payload?.session_id === 'string' ? payload.session_id : undefined;

  let stateRoot;
  try {
    stateRoot = await resolveOmcStateRoot(cwd);
  } catch {
    process.exit(0);
  }

  const mode = await activeUnattendedMode(stateRoot, sessionId);
  if (!mode) process.exit(0);

  if (payload?.stop_hook_active === true || payload?.stopHookActive === true) {
    logEnforcement({
      stateRoot,
      rule: 'budget-stop',
      mode,
      outcome: 'pass',
      detail: 'Stop hook re-entry; budget check skipped to avoid a blocking loop',
      latencyMs: Date.now() - started,
    });
    process.exit(0);
  }

  const spend = transcriptTokenSpend(payload?.transcript_path);
  const detail = spend === null ? 'transcript unavailable; no estimate attempted' : `~${spend}/${budget} tokens (${Math.round((spend / budget) * 100)}%)`;
  const latencyMs = Date.now() - started;

  if (spend === null) {
    logEnforcement({ stateRoot, rule: 'budget-stop', mode, outcome: 'degraded', detail, latencyMs });
    process.exit(0);
  }

  const ratio = spend / budget;

  if (ratio >= 1) {
    if (enforce === 'active') {
      logEnforcement({ stateRoot, rule: 'budget-stop', mode, outcome: 'block', detail, latencyMs });
      process.stderr.write(`${blockReason({ mode, spend, budget })}\n`);
      process.exit(2);
    }
    // shadow: record the would-block, stay silent
    logEnforcement({ stateRoot, rule: 'budget-stop', mode, outcome: 'warn', detail, latencyMs });
    process.exit(0);
  }

  if (ratio >= 0.9) {
    logEnforcement({ stateRoot, rule: 'budget-stop', mode, outcome: 'warn', detail, latencyMs });
    if (enforce === 'active') {
      console.log(JSON.stringify({ continue: true, systemMessage: `[BUDGET] ${mode} run at ${Math.round(ratio * 100)}% of OMC_RUN_BUDGET_TOKENS — finish the current unit, then stop with a budget report.` }));
    }
    process.exit(0);
  }

  logEnforcement({ stateRoot, rule: 'budget-stop', mode, outcome: 'pass', detail, latencyMs });
  process.exit(0);
}

await main();
