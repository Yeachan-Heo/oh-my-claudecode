#!/usr/bin/env node

/**
 * Context Injector Hook (UserPromptSubmit + SessionStart)
 *
 * Injects current context-window usage into the model's conversation as a
 * `<system-reminder>`. Claude Code shows context % to the human in the HUD;
 * this closes the loop and tells the model too, so it can self-manage
 * remaining headroom (delegate to subagents, summarize, /clear, etc.).
 *
 * Fires on:
 *   - UserPromptSubmit (every turn)
 *   - SessionStart    (initial reading for resumed sessions)
 *
 * Reads the transcript JSONL (path comes in via stdin payload), finds the
 * most recent assistant message with a `message.usage` block, computes:
 *
 *   total context = input_tokens + cache_read_input_tokens + cache_creation_input_tokens
 *
 * then renders a one-line advisory and emits it via
 * `hookSpecificOutput.additionalContext`.
 *
 * Fails silent: any throw → exit 0 with no output beyond
 * `{continue:true, suppressOutput:true}`. Never blocks a turn.
 */

import { openSync, readSync, closeSync, statSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Import timeout-protected stdin reader (prevents hangs on Linux/Windows, see issue #240).
let readStdin;
try {
  const mod = await import(pathToFileURL(join(__dirname, 'lib', 'stdin.mjs')).href);
  readStdin = mod.readStdin;
} catch {
  // Fallback: inline timeout-protected readStdin if lib module is missing.
  readStdin = (timeoutMs = 2000) => new Promise((resolve) => {
    const chunks = [];
    let settled = false;
    const timeout = setTimeout(() => {
      if (!settled) { settled = true; process.stdin.removeAllListeners(); process.stdin.destroy(); resolve(Buffer.concat(chunks).toString('utf-8')); }
    }, timeoutMs);
    process.stdin.on('data', (chunk) => { chunks.push(chunk); });
    process.stdin.on('end', () => { if (!settled) { settled = true; clearTimeout(timeout); resolve(Buffer.concat(chunks).toString('utf-8')); } });
    process.stdin.on('error', () => { if (!settled) { settled = true; clearTimeout(timeout); resolve(''); } });
    if (process.stdin.readableEnded) { if (!settled) { settled = true; clearTimeout(timeout); resolve(Buffer.concat(chunks).toString('utf-8')); } }
  });
}

// ---------- model → context limit (tokens) ----------
// Calibrated against Claude Code's own statusline `context_window.remaining_percentage`.
// Opus 4.x and Sonnet 4.x in Claude Code run with a 1M context window. Haiku stays
// at 200k. Default 200k for anything we don't recognise.
const MODEL_LIMITS = [
  { match: /opus-4/i, limit: 1_000_000 },
  { match: /sonnet-4/i, limit: 1_000_000 },
  { match: /haiku-4/i, limit: 200_000 },
];
const DEFAULT_LIMIT = 200_000;

function limitForModel(model) {
  if (!model) return DEFAULT_LIMIT;
  for (const { match, limit } of MODEL_LIMITS) {
    if (match.test(model)) return limit;
  }
  return DEFAULT_LIMIT;
}

// ---------- transcript tail reader ----------
// Read only the last `maxBytes` of the file. JSONL is line-delimited; the most
// recent assistant entry with usage is almost always in the last few hundred
// lines. We then split on \n and walk backwards.
function readTail(path, maxBytes = 512 * 1024) {
  const stats = statSync(path);
  const size = stats.size;
  const start = size > maxBytes ? size - maxBytes : 0;
  const length = size - start;
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.alloc(length);
    readSync(fd, buf, 0, length, start);
    return buf.toString('utf-8');
  } finally {
    closeSync(fd);
  }
}

function findLatestAssistantUsage(transcriptPath) {
  if (!transcriptPath || !existsSync(transcriptPath)) return null;
  const tail = readTail(transcriptPath);
  const lines = tail.split('\n');
  // If we sliced mid-line at the start, that first fragment will fail JSON.parse — that's fine, we skip it.
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line) continue;
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }
    if (obj?.type !== 'assistant') continue;
    const usage = obj?.message?.usage;
    if (!usage) continue;
    const inputTokens = Number(usage.input_tokens) || 0;
    const cacheRead = Number(usage.cache_read_input_tokens) || 0;
    const cacheCreate = Number(usage.cache_creation_input_tokens) || 0;
    const total = inputTokens + cacheRead + cacheCreate;
    if (total <= 0) continue;
    return { total, model: obj?.message?.model || null };
  }
  return null;
}

// ---------- formatting ----------
function roundToK(n) {
  return Math.round(n / 1000);
}

function buildMessage(total, limit) {
  const usedPct = Math.round((total / limit) * 100);
  const usedK = roundToK(total);
  const limitK = roundToK(limit);
  const headroomK = Math.max(0, roundToK(limit - total));
  return `Context: ${usedPct}% used (${usedK}k / ${limitK}k tokens, ~${headroomK}k headroom remaining).`;
}

// Main
async function main() {
  try {
    const raw = await readStdin(2000);
    let payload = {};
    try { payload = JSON.parse(raw); } catch { /* ignore parse errors */ }

    const transcriptPath = payload.transcript_path || payload.transcriptPath;
    const eventName = payload.hook_event_name || payload.hookEventName || 'UserPromptSubmit';

    const found = findLatestAssistantUsage(transcriptPath);
    if (!found) {
      // No usage data yet (e.g. fresh session before first assistant turn).
      // Stay silent rather than emit a noisy placeholder.
      console.log(JSON.stringify({ continue: true, suppressOutput: true }));
      return;
    }

    const limit = limitForModel(found.model);
    const message = buildMessage(found.total, limit);

    console.log(JSON.stringify({
      continue: true,
      hookSpecificOutput: {
        hookEventName: eventName,
        additionalContext: message,
      },
    }));
  } catch {
    // Fail silent. Never block a turn.
    try { console.log(JSON.stringify({ continue: true, suppressOutput: true })); } catch {}
  }
}

main();
