// src/team/conflict-mailbox.ts
//
// Formats and delivers merge/rebase conflict notifications for omc-teams CLI workers.
//
// NOTE: Markdown inbox is canonical for omc-teams CLI; JSONL is for native /team MCP workers
// (out of scope here). Worker inbox: .omc/state/team/{team}/workers/{worker}/inbox.md.
// Leader inbox: .omc/state/team/{team}/leader/inbox.md (see leader-inbox.ts).
//
// This module is 100% pure (formatMergeConflictForLeader, formatRebaseConflictForWorker).
// Delivery functions delegate to appendToLeaderInbox / appendToInbox respectively.

import { appendToInbox } from './worker-bootstrap.js';
import { appendToLeaderInbox } from './leader-inbox.js';

// ---------------------------------------------------------------------------
// Pure formatters
// ---------------------------------------------------------------------------

/**
 * Sanitize a single conflicting-file path before interpolation into a markdown
 * mailbox message. Paths come from `git status --porcelain` output and could
 * contain backticks, newlines, or carriage returns that would break the
 * markdown structure or be interpreted as additional instructions by the
 * leader's LLM. Replace each unsafe character with `?` so the message remains
 * informative without enabling prompt injection.
 */
function sanitizeConflictPath(path: string): string {
  return path.replace(/[`\r\n]/g, '?');
}

export interface MergeConflictArgs {
  workerName: string;
  workerBranch: string;
  leaderBranch: string;
  conflictingFiles: string[];
  mergeBaseSha: string;
  observedAt: number;
}

export interface RebaseConflictArgs {
  workerName: string;
  workerBranch: string;
  leaderBranch: string;
  conflictingFiles: string[];
  baseSha: string;
  worktreePath: string;
  observedAt: number;
}

/**
 * Format a merge conflict notification destined for the leader inbox.
 * Pure: same input → same output.
 */
export function formatMergeConflictForLeader(args: MergeConflictArgs): string {
  const { workerName, workerBranch, leaderBranch, conflictingFiles, mergeBaseSha, observedAt } = args;
  const ts = new Date(observedAt).toISOString();
  const safeFiles = conflictingFiles.map(sanitizeConflictPath);
  const fileList = safeFiles.map((f) => `- \`${f}\``).join('\n');
  return `### Merge conflict: ${workerName} → ${leaderBranch}

**Worker branch:** \`${workerBranch}\`
**Leader branch:** \`${leaderBranch}\`
**Merge base:** \`${mergeBaseSha}\`
**Observed at:** ${ts}

**Conflicting files:**
${fileList}

**Leader: choose strategy.** To resolve, run:

\`\`\`sh
git checkout ${leaderBranch} && git merge --no-ff ${workerBranch}
# resolve conflicts in the files listed above
git add ${safeFiles.join(' ')}
git commit
\`\`\`

Or abort with \`git merge --abort\` to defer resolution.`;
}

/**
 * Format a rebase conflict notification destined for a worker inbox.
 * Pure: same input → same output.
 */
export function formatRebaseConflictForWorker(args: RebaseConflictArgs): string {
  const { workerName, workerBranch, leaderBranch, conflictingFiles, baseSha, worktreePath, observedAt } = args;
  const ts = new Date(observedAt).toISOString();
  const safeFiles = conflictingFiles.map(sanitizeConflictPath);
  const fileList = safeFiles.map((f) => `- \`${f}\``).join('\n');
  return `### Rebase conflict: ${workerName} onto ${leaderBranch}

**Worker branch:** \`${workerBranch}\`
**Base branch:** \`${leaderBranch}\`
**Base SHA:** \`${baseSha}\`
**Worktree:** \`${worktreePath}\`
**Observed at:** ${ts}

**Conflicting files:**
${fileList}

Resolve conflicts in your own pane, then \`git add <files>\` and \`git rebase --continue\`.
Cadence stays paused until \`.git/rebase-merge\` is gone.

Or run \`git rebase --abort\` to bail and return to the pre-rebase state.`;
}

// ---------------------------------------------------------------------------
// Delivery functions
// ---------------------------------------------------------------------------

export interface DeliverMergeConflictArgs {
  teamName: string;
  cwd: string;
  message: string;
}

export interface DeliverRebaseConflictArgs {
  teamName: string;
  workerName: string;
  cwd: string;
  message: string;
}

/**
 * Deliver a merge conflict message to the leader inbox.
 * Delegates to leader-inbox.appendToLeaderInbox.
 */
export async function deliverMergeConflictToLeader(args: DeliverMergeConflictArgs): Promise<void> {
  const { teamName, cwd, message } = args;
  await appendToLeaderInbox(teamName, message, cwd);
}

/**
 * Deliver a rebase conflict message to a worker inbox.
 * Delegates to worker-bootstrap.appendToInbox.
 */
export async function deliverRebaseConflictToWorker(args: DeliverRebaseConflictArgs): Promise<void> {
  const { teamName, workerName, cwd, message } = args;
  await appendToInbox(teamName, workerName, message, cwd);
}
