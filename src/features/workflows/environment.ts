/**
 * Dynamic Workflows Integration — Live environment resolution
 *
 * Best-effort reading of the live Claude Code version and disable settings,
 * fed into detectWorkflowCapability. Every probe degrades gracefully: an
 * unknown version or unreadable settings file yields a conservative
 * "unavailable" result (capability detection treats an unknown version as not
 * meeting the minimum), so OMC simply falls back to its own orchestration.
 */

import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';
import { join } from 'path';

import { getClaudeConfigDir } from '../../utils/config-dir.js';
import { parseJsonc } from '../../utils/jsonc.js';
import { detectWorkflowCapability } from './capability.js';
import type { WorkflowCapability } from './types.js';

/** Extract a dotted version (e.g. "2.1.160") from arbitrary CLI output. */
export function parseClaudeVersion(output: string): string | null {
  const match = output.match(/(\d+\.\d+\.\d+)/);
  return match ? match[1] : null;
}

/**
 * Best-effort read of the installed Claude Code version.
 * Order: `CLAUDE_CODE_VERSION` env, then `claude --version`. Returns null on
 * any failure (missing binary, timeout, unparseable output).
 */
export function readClaudeCodeVersion(): string | null {
  const fromEnv = process.env.CLAUDE_CODE_VERSION;
  if (fromEnv) {
    const parsed = parseClaudeVersion(fromEnv);
    if (parsed) return parsed;
  }
  try {
    const output = String(
      execFileSync('claude', ['--version'], {
        encoding: 'utf-8',
        timeout: 5000,
        stdio: ['ignore', 'pipe', 'ignore'],
      }),
    );
    return parseClaudeVersion(output);
  } catch {
    return null;
  }
}

/** Best-effort read of `disableWorkflows` from ~/.claude/settings.json. */
export function readWorkflowsDisabledSetting(): boolean {
  try {
    const settingsPath = join(getClaudeConfigDir(), 'settings.json');
    const raw = readFileSync(settingsPath, 'utf-8');
    const parsed = parseJsonc(raw) as { disableWorkflows?: unknown } | null;
    return parsed?.disableWorkflows === true;
  } catch {
    return false;
  }
}

export interface ResolveLiveCapabilityOptions {
  /** Skip the `claude --version` CLI probe (e.g. in tests or hot paths). */
  skipVersionProbe?: boolean;
}

/**
 * Resolve the workflow capability from the live environment. Convenience
 * wrapper combining the version + settings probes with detectWorkflowCapability.
 */
export function resolveLiveWorkflowCapability(
  options: ResolveLiveCapabilityOptions = {},
): WorkflowCapability {
  const version = options.skipVersionProbe ? null : readClaudeCodeVersion();
  const settingsDisabled = readWorkflowsDisabledSetting();
  return detectWorkflowCapability({ version, settingsDisabled });
}
