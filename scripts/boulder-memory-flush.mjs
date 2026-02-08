#!/usr/bin/env node

/**
 * Boulder Memory Flush Hook (PreCompact)
 *
 * When context is about to be compacted, this hook injects a prompt
 * telling Claude to save important context to the notepad before
 * the compaction happens. This preserves critical decisions and
 * progress across context boundaries.
 *
 * Concept ported from openclaw's pre-compaction memory flush.
 */

import { existsSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Import timeout-protected stdin reader (prevents hangs on Linux, see issue #240)
let readStdin;
try {
  const mod = await import(join(__dirname, 'lib', 'stdin.mjs'));
  readStdin = mod.readStdin;
} catch {
  // Fallback: inline timeout-protected readStdin if lib module is missing
  readStdin = (timeoutMs = 5000) => new Promise((resolve) => {
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

function readJsonFile(path) {
  try {
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    return null;
  }
}

async function main() {
  try {
    const input = await readStdin();
    let data = {};
    try { data = JSON.parse(input); } catch {}

    const directory = data.cwd || data.directory || process.cwd();

    // Check for active boulder state
    const boulderPath = join(directory, '.omc', 'boulder.json');
    const boulder = readJsonFile(boulderPath);

    // Check for active ralplan state
    const ralplanPath = join(directory, '.omc', 'state', 'ralplan-state.json');
    const ralplan = readJsonFile(ralplanPath);

    const hasActiveBoulder = boulder?.active_plan;
    const hasActiveRalplan = ralplan?.active;

    if (!hasActiveBoulder && !hasActiveRalplan) {
      // No active work session, passthrough
      console.log(JSON.stringify({ continue: true }));
      return;
    }

    // Build plan progress info
    let planInfo = '';
    if (hasActiveBoulder) {
      const planPath = join(directory, boulder.active_plan);
      if (existsSync(planPath)) {
        const content = readFileSync(planPath, 'utf-8');
        const unchecked = (content.match(/^[-*]\s*\[\s*\]/gm) || []).length;
        const checked = (content.match(/^[-*]\s*\[[xX]\]/gm) || []).length;
        planInfo = `\nActive plan: ${boulder.plan_name} (${checked}/${checked + unchecked} tasks done)`;
      }
    }

    const flushPrompt = `[PRE-COMPACTION MEMORY FLUSH]
Context is about to be compacted. BEFORE continuing, save important context:${planInfo}

1. Use mcp__t__notepad_write_working to save:
   - Key decisions made in this session
   - Important code patterns or findings discovered
   - Current task progress and what to do next
   - Any blockers or unresolved issues

2. If there is a critical discovery that MUST survive compaction,
   use mcp__t__notepad_write_priority (max 2000 chars, replaces existing).

3. If working on a plan (.omc/plans/*.md), update the plan file to reflect
   current progress (mark completed tasks with - [x]).

After saving, continue with your work.`;

    console.log(JSON.stringify({
      continue: true,
      hookSpecificOutput: {
        hookEventName: 'PreCompact',
        additionalContext: flushPrompt
      }
    }));
  } catch (error) {
    // Never block on errors
    console.error('[boulder-memory-flush] Error:', error.message);
    console.log(JSON.stringify({ continue: true }));
  }
}

main();
