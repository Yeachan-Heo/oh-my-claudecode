#!/usr/bin/env node

/**
 * OMC Preemptive Compaction Hook (PostToolUse)
 *
 * Monitors context usage via transcript file and warns before hitting the
 * context limit. Encourages proactive /compact to prevent context overflow.
 *
 * Fixes #2180: The original TypeScript implementation used in-memory Maps
 * for state tracking, but each hook invocation is a new process — state was
 * always lost. This rewrite uses the transcript-based approach (reading
 * input_tokens/context_window from the transcript's tail) and file-based
 * cooldown, matching the pattern established by context-guard-stop.mjs.
 *
 * Hook output:
 *   - { hookSpecificOutput: { additionalContext: "..." } } when context high
 *   - { continue: true, suppressOutput: true } otherwise
 */

import { existsSync, statSync, openSync, readSync, closeSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { execSync } from 'node:child_process';
import { readStdin } from './lib/stdin.mjs';

const WARNING_THRESHOLD = parseInt(process.env.OMC_PREEMPTIVE_COMPACTION_THRESHOLD || '70', 10);
const CRITICAL_THRESHOLD = 90;
const COOLDOWN_MS = 60_000; // 1 minute between warnings per cwd

/**
 * Resolve a transcript path that may be mismatched in worktree sessions.
 * Reuses the same resolution logic as context-guard-stop.mjs.
 */
function resolveTranscriptPath(transcriptPath, cwd) {
  if (!transcriptPath) return transcriptPath;
  try {
    if (existsSync(transcriptPath)) return transcriptPath;
  } catch { /* fallthrough */ }

  // Strategy 1: Strip Claude worktree segment from encoded project directory
  const worktreePattern = /--claude-worktrees-[^/\\]+/;
  if (worktreePattern.test(transcriptPath)) {
    const resolved = transcriptPath.replace(worktreePattern, '');
    try {
      if (existsSync(resolved)) return resolved;
    } catch { /* fallthrough */ }
  }

  // Strategy 2: Detect native git worktree via git-common-dir
  const effectiveCwd = cwd || process.cwd();
  try {
    const gitCommonDir = execSync('git rev-parse --git-common-dir', {
      cwd: effectiveCwd,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();

    const absoluteCommonDir = resolve(effectiveCwd, gitCommonDir);
    const mainRepoRoot = dirname(absoluteCommonDir);

    const worktreeTop = execSync('git rev-parse --show-toplevel', {
      cwd: effectiveCwd,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();

    if (mainRepoRoot !== worktreeTop) {
      const lastSep = transcriptPath.lastIndexOf('/');
      const sessionFile = lastSep !== -1 ? transcriptPath.substring(lastSep + 1) : '';
      if (sessionFile) {
        const configDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
        const projectsDir = join(configDir, 'projects');
        if (existsSync(projectsDir)) {
          const encodedMain = mainRepoRoot.replace(/[/\\]/g, '-');
          const resolvedPath = join(projectsDir, encodedMain, sessionFile);
          try {
            if (existsSync(resolvedPath)) return resolvedPath;
          } catch { /* fallthrough */ }
        }
      }
    }
  } catch { /* not in a git repo or git not available */ }

  return transcriptPath;
}

/**
 * Estimate context usage percentage from the transcript file.
 * Reads the last 4KB to find the most recent input_tokens and context_window.
 */
function estimateContextPercent(transcriptPath) {
  if (!transcriptPath) return 0;

  let fd = -1;
  try {
    const stat = statSync(transcriptPath);
    if (stat.size === 0) return 0;

    fd = openSync(transcriptPath, 'r');
    const readSize = Math.min(4096, stat.size);
    const buf = Buffer.alloc(readSize);
    readSync(fd, buf, 0, readSize, stat.size - readSize);
    closeSync(fd);
    fd = -1;

    const tail = buf.toString('utf-8');

    // Bounded quantifiers to avoid ReDoS on malformed input
    const windowMatch = tail.match(/"context_window"\s{0,5}:\s{0,5}(\d+)/g);
    const inputMatch = tail.match(/"input_tokens"\s{0,5}:\s{0,5}(\d+)/g);

    if (!windowMatch || !inputMatch) return 0;

    const lastWindow = parseInt(windowMatch[windowMatch.length - 1].match(/(\d+)/)[1], 10);
    const lastInput = parseInt(inputMatch[inputMatch.length - 1].match(/(\d+)/)[1], 10);

    if (lastWindow === 0) return 0;
    return Math.round((lastInput / lastWindow) * 100);
  } catch {
    return 0;
  } finally {
    if (fd !== -1) try { closeSync(fd); } catch { /* ignore */ }
  }
}

/**
 * File-based cooldown to prevent warning spam.
 * Uses a temp file per cwd with the last warning timestamp.
 */
function getCooldownPath(cwd) {
  // Encode cwd into a safe filename
  const encoded = (cwd || 'default').replace(/[^a-zA-Z0-9]/g, '_').slice(0, 200);
  return join(tmpdir(), `omc-preemptive-compaction-${encoded}.json`);
}

function isInCooldown(cwd) {
  const cooldownPath = getCooldownPath(cwd);
  try {
    if (!existsSync(cooldownPath)) return false;
    const stat = statSync(cooldownPath);
    return (Date.now() - stat.mtimeMs) < COOLDOWN_MS;
  } catch {
    return false;
  }
}

function touchCooldown(cwd) {
  const cooldownPath = getCooldownPath(cwd);
  try {
    writeFileSync(cooldownPath, JSON.stringify({ ts: Date.now() }), { mode: 0o600 });
  } catch { /* best-effort */ }
}

async function main() {
  // Skip guard
  const skipHooks = (process.env.OMC_SKIP_HOOKS || '').split(',').map(s => s.trim());
  if (process.env.DISABLE_OMC === '1' || skipHooks.includes('preemptive-compaction')) {
    console.log(JSON.stringify({ continue: true, suppressOutput: true }));
    return;
  }

  try {
    const input = await readStdin();
    const data = JSON.parse(input);

    const cwd = data.cwd || data.directory || process.cwd();
    const rawTranscriptPath = data.transcript_path || data.transcriptPath || '';
    const transcriptPath = resolveTranscriptPath(rawTranscriptPath, cwd);
    const pct = estimateContextPercent(transcriptPath);

    // Below warning threshold — no action
    if (pct < WARNING_THRESHOLD) {
      console.log(JSON.stringify({ continue: true, suppressOutput: true }));
      return;
    }

    // In cooldown — suppress to avoid spam
    if (isInCooldown(cwd)) {
      console.log(JSON.stringify({ continue: true, suppressOutput: true }));
      return;
    }

    // Mark cooldown
    touchCooldown(cwd);

    // Build warning message
    const severity = pct >= CRITICAL_THRESHOLD ? 'CRITICAL' : 'WARNING';
    const action = pct >= CRITICAL_THRESHOLD
      ? 'Run /compact NOW to avoid context overflow.'
      : 'Consider running /compact soon to free context space.';

    const message = `[OMC Context ${severity}] Context usage at ${pct}% (threshold: ${WARNING_THRESHOLD}%). ${action}`;

    console.log(JSON.stringify({
      continue: true,
      hookSpecificOutput: {
        hookEventName: 'PostToolUse',
        additionalContext: message,
      },
    }));
  } catch {
    // On any error, silently continue — never break the hook chain
    console.log(JSON.stringify({ continue: true, suppressOutput: true }));
  }
}

main();
