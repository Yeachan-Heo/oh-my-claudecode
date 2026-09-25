#!/usr/bin/env node

/**
 * PreToolUse Hook: git guardrails (opt-in).
 *
 * Blocks destructive git operations from agent-driven Bash calls with an
 * authority message. Disabled by default; enable with OMC_GIT_GUARDRAILS=1
 * (OMC_GIT_GUARDRAILS=0 always wins, even over =1 from a parent scope).
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

import { readStdin } from './lib/stdin.mjs';

const GUARDS = [
  { pattern: /\bgit\s+push\b/, label: 'git push' },
  { pattern: /\bgit\s+reset\b[^|;&]*--hard\b/, label: 'git reset --hard' },
  { pattern: /\bgit\s+clean\b[^|;&]*(--force\b|-[a-z]*f)/, label: 'git clean -f' },
  { pattern: /\bgit\s+branch\s+(-D\b|--delete\s+--force\b)/, label: 'git branch -D' },
  { pattern: /\bgit\s+checkout\s+(--\s+)?\.\s*$/, label: 'git checkout . (working-tree discard)' },
  { pattern: /\bgit\s+restore\s+(\.(\s|$)|--\s+\.(\s|$))/, label: 'git restore . (working-tree discard)' },
];

function guardMessage(label) {
  return [
    `Git guardrail: blocked "${label}".`,
    'You do not have authority for this operation - it destroys or publishes state the user owns.',
    'Ask the user to run it themselves, or to explicitly approve it by setting OMC_GIT_GUARDRAILS=0 for this session.',
  ].join('\n');
}

function commandFromPayload(payload) {
  if (!payload || typeof payload !== 'object') return '';
  const toolInput = payload.tool_input;
  if (!toolInput || typeof toolInput !== 'object') return '';
  return typeof toolInput.command === 'string' ? toolInput.command : '';
}

async function main() {
  if (process.env.OMC_GIT_GUARDRAILS === '0') process.exit(0);
  if (process.env.OMC_GIT_GUARDRAILS !== '1') process.exit(0);

  const raw = await readStdin(3000);
  let payload = null;
  try {
    payload = JSON.parse(raw);
  } catch {
    process.exit(0);
  }

  const command = commandFromPayload(payload);
  if (!command) process.exit(0);

  for (const guard of GUARDS) {
    if (guard.pattern.test(command)) {
      process.stderr.write(`${guardMessage(guard.label)}\n`);
      process.exit(2);
    }
  }
  process.exit(0);
}

await main();
