#!/usr/bin/env node

/**
 * OMC Context Guard Hook (Stop)
 *
 * Suggests session refresh when context usage exceeds a warning threshold.
 * This complements persistent-mode.cjs — it fires BEFORE modes like Ralph
 * or Ultrawork process the stop, providing an early warning.
 *
 * Configurable via OMC_CONTEXT_GUARD_THRESHOLD env var (default: 75%).
 *
 * Safety rules:
 *   - Never block context_limit stops (would cause compaction deadlock)
 *   - Never block user-requested stops (respect Ctrl+C / cancel)
 *   - Max 2 blocks per transcript (retry guard prevents infinite loops)
 *
 * Hook output:
 *   - { decision: "block", reason: "..." } when context too high
 *   - { continue: true, suppressOutput: true } otherwise
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { execSync } from 'node:child_process';
import { readStdin } from './lib/stdin.mjs';

const THRESHOLD = parseInt(process.env.OMC_CONTEXT_GUARD_THRESHOLD || '75', 10);
const MAX_BLOCKS = 2;

/**
 * Detect if stop was triggered by context-limit related reasons.
 * Mirrors the logic in persistent-mode.cjs to stay consistent.
 */
function isContextLimitStop(data) {
  const reason = (data.stop_reason || data.stopReason || '').toLowerCase();
  const contextPatterns = [
    'context_limit', 'context_window', 'context_exceeded',
    'context_full', 'max_context', 'token_limit',
    'max_tokens', 'conversation_too_long', 'input_too_long',
  ];

  if (contextPatterns.some(p => reason.includes(p))) return true;

  const endTurnReason = (data.end_turn_reason || data.endTurnReason || '').toLowerCase();
  if (endTurnReason && contextPatterns.some(p => endTurnReason.includes(p))) return true;

  return false;
}

/**
 * Detect if stop was triggered by user abort.
 */
function isUserAbort(data) {
  if (data.user_requested || data.userRequested) return true;

  const reason = (data.stop_reason || data.stopReason || '').toLowerCase();
  const exactPatterns = ['aborted', 'abort', 'cancel', 'interrupt'];
  const substringPatterns = ['user_cancel', 'user_interrupt', 'ctrl_c', 'manual_stop'];

  return (
    exactPatterns.some(p => reason === p) ||
    substringPatterns.some(p => reason.includes(p))
  );
}

/**
 * Resolve a transcript path that may be mismatched in worktree sessions (issue #1094).
 * When Claude Code runs inside .claude/worktrees/X, the encoded project directory
 * contains `--claude-worktrees-X` which doesn't exist. Strip it to find the real path.
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

  // Strategy 2: Detect native git worktree via git-common-dir.
  // When CWD is a linked worktree (created by `git worktree add`), the
  // transcript path encodes the worktree CWD, but the file lives under
  // the main repo's encoded path.
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
  } catch { /* not in a git repo or git not available — skip */ }

  return transcriptPath;
}

/**
 * Estimate context usage percentage from the transcript file.
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
 * Retry guard: track how many times we've blocked this transcript.
 * Prevents infinite block loops by capping at MAX_BLOCKS.
 */
function getBlockCount(sessionId) {
  if (!sessionId) return 0;
  const guardFile = join(tmpdir(), `omc-context-guard-${sessionId}.json`);
  try {
    if (existsSync(guardFile)) {
      const data = JSON.parse(readFileSync(guardFile, 'utf-8'));
      return data.blockCount || 0;
    }
  } catch { /* ignore */ }
  return 0;
}

function incrementBlockCount(sessionId) {
  if (!sessionId) return;
  const guardFile = join(tmpdir(), `omc-context-guard-${sessionId}.json`);
  try {
    let count = 0;
    if (existsSync(guardFile)) {
      const data = JSON.parse(readFileSync(guardFile, 'utf-8'));
      count = data.blockCount || 0;
    }
    writeFileSync(guardFile, JSON.stringify({ blockCount: count + 1 }));
  } catch { /* ignore */ }
}

async function main() {
  try {
    const input = await readStdin();
    const data = JSON.parse(input);

    // CRITICAL: Never block context-limit stops (compaction deadlock)
    if (isContextLimitStop(data)) {
      console.log(JSON.stringify({ continue: true, suppressOutput: true }));
      return;
    }

    // Respect user abort
    if (isUserAbort(data)) {
      console.log(JSON.stringify({ continue: true, suppressOutput: true }));
      return;
    }

    const sessionId = data.session_id || data.sessionId || '';
    const rawTranscriptPath = data.transcript_path || data.transcriptPath || '';
    const transcriptPath = resolveTranscriptPath(rawTranscriptPath, data.cwd);
    const pct = estimateContextPercent(transcriptPath);

    if (pct >= THRESHOLD) {
      // Check retry guard
      const blockCount = getBlockCount(sessionId);
      if (blockCount >= MAX_BLOCKS) {
        // Already blocked enough times — let it through
        console.log(JSON.stringify({ continue: true, suppressOutput: true }));
        return;
      }

      incrementBlockCount(sessionId);

      console.log(JSON.stringify({
        decision: 'block',
        reason: `[OMC] Context at ${pct}% (threshold: ${THRESHOLD}%). ` +
          `Quality degrades at high context. Run /compact or start a fresh session. ` +
          `(Block ${blockCount + 1}/${MAX_BLOCKS})`
      }));
      return;
    }

    console.log(JSON.stringify({ continue: true, suppressOutput: true }));
  } catch {
    // On any error, allow stop (never block on hook failure)
    console.log(JSON.stringify({ continue: true, suppressOutput: true }));
  }
}

main();
