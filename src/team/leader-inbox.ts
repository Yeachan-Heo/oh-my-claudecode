// src/team/leader-inbox.ts
//
// Bootstraps and writes to the leader's markdown inbox, mirroring the worker
// appendToInbox pattern from worker-bootstrap.ts:268.
//
// Leader inbox path: .omc/state/team/{sanitizedTeam}/leader/inbox.md
// This resolves C1: leader notifications arrive via file, not tmux send-keys.
// DO NOT register the leader as a member of the team registry (Option C, rejected).

import { appendFile, mkdir, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { dirname, join } from 'path';
import { sanitizeName } from './tmux-session.js';
import { validateResolvedPath } from './fs-utils.js';

const LEADER_INBOX_HEADER = `# Leader Inbox

Runtime notifications (merge conflicts, rebase events, etc.) appear here.
Check this file periodically and after long-running operations.

---
`;

/**
 * Returns the absolute path to the leader inbox file. Pure function.
 * Uses sanitizeName to normalise teamName (prevents traversal characters).
 */
export function leaderInboxPath(teamName: string, cwd: string): string {
  const safe = sanitizeName(teamName);
  return join(cwd, `.omc/state/team/${safe}/leader/inbox.md`);
}

/**
 * Ensures the leader inbox directory and seed file exist.
 * Creates .omc/state/team/{team}/leader/ and seeds inbox.md with a header banner.
 * Returns the absolute path to inbox.md.
 * Idempotent: safe to call multiple times.
 * Validates path is within cwd to prevent traversal.
 */
export async function ensureLeaderInbox(teamName: string, cwd: string): Promise<string> {
  const inboxPath = leaderInboxPath(teamName, cwd);
  validateResolvedPath(inboxPath, cwd);
  await mkdir(dirname(inboxPath), { recursive: true });
  if (!existsSync(inboxPath)) {
    await writeFile(inboxPath, LEADER_INBOX_HEADER, 'utf-8');
  }
  return inboxPath;
}

/**
 * Append a message to the leader inbox.
 * Mirrors appendToInbox for workers: appends `\n\n---\n${message}` to the inbox file.
 * Validates path is within cwd to prevent traversal.
 */
export async function appendToLeaderInbox(teamName: string, message: string, cwd: string): Promise<void> {
  const inboxPath = leaderInboxPath(teamName, cwd);
  validateResolvedPath(inboxPath, cwd);
  await mkdir(dirname(inboxPath), { recursive: true });
  await appendFile(inboxPath, `\n\n---\n${message}`, 'utf-8');
}

/**
 * Returns a one-line directive to append to the leader pane's spawn prompt,
 * telling the leader where to find runtime notifications.
 * Pure function. Returns a workspace-relative path (no `cwd` parameter — the
 * directive is consumed by the leader process which interprets the path
 * relative to its own working directory).
 */
export function extendLeaderBootstrapPrompt(teamName: string): string {
  const safe = sanitizeName(teamName);
  const path = `.omc/state/team/${safe}/leader/inbox.md`;
  return `Runtime notifications appear at ${path} — check this file periodically and after long-running operations.`;
}
