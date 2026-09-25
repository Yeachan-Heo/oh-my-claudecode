#!/usr/bin/env node

/**
 * PreToolUse Hook: git guardrails.
 *
 * Blocks destructive git operations from agent-driven Bash calls with an
 * authority message. Two ways on:
 *   - OMC_GIT_GUARDRAILS=1                    (always on, any session)
 *   - an active unattended mode (ralph, autopilot, team, ultragoal)
 *     discovered from the mode state files    (dark-run default)
 * OMC_GIT_GUARDRAILS=0 always wins over both. Without either, the hook
 * exits silently.
 *
 * Blocked operations (exit code 2, stderr shown to the model):
 *   git push                      - publishing history is not an agent decision
 *   git reset --hard              - destroys uncommitted work
 *   git clean -f / --force        - destroys untracked files
 *   git branch -D                 - force-deletes a branch
 *   git checkout/restore .        - discards working-tree changes
 *
 * A guardrail must bite to count: feed it a planted violation and watch it
 * block before trusting it in a session (see refit's landing rule).
 */

import { existsSync, readFileSync } from 'fs';
import { readStdin } from './lib/stdin.mjs';
import { resolveSessionStatePathsForHook } from './lib/state-root.mjs';

const GUARDS = [
  { pattern: /\bgit\s+push\b/, label: 'git push' },
  { pattern: /\bgit\s+reset\b[^|;&]*--hard\b/, label: 'git reset --hard' },
  { pattern: /\bgit\s+clean\b[^|;&]*(--force\b|-[a-z]*f)/, label: 'git clean -f' },
  { pattern: /\bgit\s+branch\s+(-D\b|--delete\s+--force\b)/, label: 'git branch -D' },
  { pattern: /\bgit\s+checkout\s+(--\s+)?\.\s*$/, label: 'git checkout . (working-tree discard)' },
  { pattern: /\bgit\s+restore\s+(\.(\s|$)|--\s+\.(\s|$))/, label: 'git restore . (working-tree discard)' },
];

const GUARDED_MODES = ['ralph', 'autopilot', 'team', 'ultragoal'];

function guardMessage(label, activeMode) {
  const lines = [`Git guardrail: blocked "${label}".`, 'You do not have authority for this operation - it destroys or publishes state the user owns.'];
  if (activeMode) {
    lines.push(`Guardrails are on by default while an unattended ${activeMode} run is active; set OMC_GIT_GUARDRAILS=0 to opt out, or ask the user to run this command.`);
  } else {
    lines.push('Ask the user to run it themselves, or to explicitly approve it by setting OMC_GIT_GUARDRAILS=0 for this session.');
  }
  return lines.join('\n');
}

function commandFromPayload(payload) {
  if (!payload || typeof payload !== 'object') return '';
  const toolInput = payload.tool_input;
  if (!toolInput || typeof toolInput !== 'object') return '';
  return typeof toolInput.command === 'string' ? toolInput.command : '';
}

async function activeUnattendedMode(directory, sessionId) {
  for (const mode of GUARDED_MODES) {
    try {
      const { readPath } = await resolveSessionStatePathsForHook(directory, mode, sessionId);
      if (!readPath || !existsSync(readPath)) continue;
      const state = JSON.parse(readFileSync(readPath, 'utf8'));
      if (state && state.active === true) return mode;
    } catch {
      // unreadable state files never block the hook path; the next mode is probed
    }
  }
  return null;
}

async function main() {
  if (process.env.OMC_GIT_GUARDRAILS === '0') process.exit(0);

  const raw = await readStdin(3000);
  let payload = null;
  try {
    payload = JSON.parse(raw);
  } catch {
    process.exit(0);
  }

  const explicit = process.env.OMC_GIT_GUARDRAILS === '1';
  let activeMode = null;
  if (!explicit) {
    const directory = typeof payload.cwd === 'string' && payload.cwd ? payload.cwd : process.cwd();
    const sessionId = typeof payload.session_id === 'string' ? payload.session_id : undefined;
    activeMode = await activeUnattendedMode(directory, sessionId);
    if (!activeMode) process.exit(0);
  }

  const command = commandFromPayload(payload);
  if (!command) process.exit(0);

  for (const guard of GUARDS) {
    if (guard.pattern.test(command)) {
      process.stderr.write(`${guardMessage(guard.label, activeMode)}\n`);
      process.exit(2);
    }
  }
  process.exit(0);
}

await main();
