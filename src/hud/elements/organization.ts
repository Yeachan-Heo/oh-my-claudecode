/**
 * OMC HUD - Organization Element
 *
 * Renders the Claude account's organization, e.g. `org:Acme·team`. Useful when
 * switching between personal and team accounts (or between profiles via
 * CLAUDE_CONFIG_DIR) — the statusline makes it obvious which organization the
 * current session bills to before you start a long run.
 *
 * Claude Code does not include organization info in the statusline stdin
 * payload, so the value is read from the local `.claude.json` the CLI writes at
 * login.
 *
 * Only the organization *name* is ever surfaced. The account email, account
 * UUID, and organization UUID stored alongside it are never read.
 */

import { existsSync, readFileSync, statSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { cyan, dim } from '../colors.js';
import { getClaudeConfigDir } from '../../utils/config-dir.js';

/**
 * `.claude.json` also holds per-project history, so it can grow. Skip parsing
 * pathological sizes rather than paying for them on every statusline render.
 */
const MAX_CONFIG_BYTES = 5 * 1024 * 1024;

/** Keep the statusline token short; longer names are elided. */
const MAX_NAME_LENGTH = 28;

/**
 * Read `oauthAccount.organizationName` out of one candidate config file.
 *
 * @returns The trimmed name, or null when the file is missing, too large,
 *          unparseable, or has no organization on record.
 */
function readOrganizationName(filePath: string): string | null {
  try {
    if (!existsSync(filePath)) return null;
    if (statSync(filePath).size > MAX_CONFIG_BYTES) return null;
    const config = JSON.parse(readFileSync(filePath, 'utf-8'));
    const name = config?.oauthAccount?.organizationName;
    if (typeof name !== 'string') return null;
    const trimmed = name.trim();
    return trimmed.length > 0 ? trimmed : null;
  } catch {
    return null;
  }
}

/**
 * Resolve the organization name from the local Claude config.
 *
 * Checks `$CLAUDE_CONFIG_DIR/.claude.json` first so profile-scoped installs
 * report their own organization, then falls back to `~/.claude.json`.
 *
 * @returns The organization name, or null when none is on record (API-key auth,
 *          logged out, or a config without an `oauthAccount` block).
 */
export function getOrganizationName(): string | null {
  const candidates: string[] = [];

  try {
    const configDir = getClaudeConfigDir();
    if (configDir) candidates.push(join(configDir, '.claude.json'));
  } catch {
    // Fall through to the home-directory location.
  }
  candidates.push(join(homedir(), '.claude.json'));

  for (const candidate of candidates) {
    const name = readOrganizationName(candidate);
    if (name) return name;
  }

  return null;
}

/**
 * Collapse the trailing plan qualifier the API appends for team accounts so the
 * token stays narrow: `"Acme (Team)"` becomes `"Acme·team"`.
 */
function compactName(name: string): string {
  const qualified = name.match(/^(.*\S)\s*\(([^()]+)\)$/);
  const compacted = qualified ? `${qualified[1]}·${qualified[2].toLowerCase()}` : name;
  return compacted.length > MAX_NAME_LENGTH
    ? `${compacted.slice(0, MAX_NAME_LENGTH - 1)}…`
    : compacted;
}

/**
 * Render the organization element.
 *
 * Format: `org:Acme·team`
 *
 * @returns Rendered label, or null when no organization is on record.
 */
export function renderOrganization(): string | null {
  const name = getOrganizationName();
  if (!name) return null;
  return `${dim('org:')}${cyan(compactName(name))}`;
}
