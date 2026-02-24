#!/usr/bin/env node

/**
 * OMC Context Safety Hook (PreToolUse)
 *
 * Blocks expensive operations (TeamCreate, ExitPlanMode) when context usage
 * exceeds a safe threshold. Spawning teams or exiting plan mode at high
 * context leads to unrecoverable extended-thinking loops because the model
 * cannot converge on a next action.
 *
 * Configurable via OMC_CONTEXT_SAFETY_THRESHOLD env var (default: 55%).
 *
 * Hook output:
 *   - Block (exit 2 + stderr message) when context too high for the tool
 *   - Allow ({ continue: true, suppressOutput: true }) otherwise
 */

import { statSync, openSync, readSync, closeSync } from 'node:fs';
import { readStdin } from './lib/stdin.mjs';

const THRESHOLD = parseInt(process.env.OMC_CONTEXT_SAFETY_THRESHOLD || '55', 10);
// TeamCreate was removed from BLOCKED_TOOLS in issue #1006.
// Blocking TeamCreate at high context caused silent fallback to regular subagents,
// defeating the team orchestration pipeline. TeamCreate is lightweight infrastructure
// setup, not expensive model inference, so context pressure is not a concern.
const BLOCKED_TOOLS = new Set(['ExitPlanMode']);

/**
 * Estimate context usage percentage from the transcript file.
 * Reads the last 4KB of the transcript to find the most recent usage entry.
 */
function estimateContextPercent(transcriptPath) {
  if (!transcriptPath) return 0;

  let fd = -1;
  try {
    const stat = statSync(transcriptPath);
    if (stat.size === 0) return 0;

    // Read the last 4KB — covers ~50-100 JSONL entries for recent usage data
    fd = openSync(transcriptPath, 'r');
    const readSize = Math.min(4096, stat.size);
    const buf = Buffer.alloc(readSize);
    readSync(fd, buf, 0, readSize, stat.size - readSize);
    closeSync(fd);
    fd = -1;

    const tail = buf.toString('utf-8');

    // Look for context_window / input_tokens patterns in JSON lines
    // Bounded quantifiers to avoid ReDoS on malformed input
    const windowMatch = tail.match(/"context_window"\s{0,5}:\s{0,5}(\d+)/g);
    const inputMatch = tail.match(/"input_tokens"\s{0,5}:\s{0,5}(\d+)/g);

    if (!windowMatch || !inputMatch) return 0;

    // Take the last occurrence of each
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

async function main() {
  try {
    const input = await readStdin();
    const data = JSON.parse(input);

    const toolName = data.tool_name || data.toolName || '';

    if (!BLOCKED_TOOLS.has(toolName)) {
      console.log(JSON.stringify({ continue: true, suppressOutput: true }));
      return;
    }

    const transcriptPath = data.transcript_path || data.transcriptPath || '';
    const pct = estimateContextPercent(transcriptPath);

    if (pct >= THRESHOLD) {
      process.stderr.write(
        `[OMC] Context at ${pct}% (threshold: ${THRESHOLD}%). ` +
        `Too high for ${toolName}. Run /compact or start a fresh session to free context.\n`
      );
      process.exit(2);
    }

    console.log(JSON.stringify({ continue: true, suppressOutput: true }));
  } catch {
    // On any error, allow the tool to proceed (never block on hook failure)
    console.log(JSON.stringify({ continue: true, suppressOutput: true }));
  }
}

main();
