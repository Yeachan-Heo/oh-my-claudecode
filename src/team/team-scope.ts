// src/team/team-scope.ts

/**
 * Worktree-scope token for isolating team namespaces across sibling git
 * worktrees of the same repository.
 *
 * Why this exists
 * ---------------
 * Team-scoped paths (`~/.claude/teams/<team>/...`, tmux session names,
 * `.omc/worktrees/<team>/<worker>`, branch `omc-team/<team>/<worker>`,
 * `.omc/state/team-bridge/<team>/...`) are ALL keyed solely on `teamName`.
 * If a user runs `/team N:executor "task"` with the same team name from two
 * sibling worktrees of the same repo, every one of those namespaces collides.
 *
 * This module provides a deterministic 8-char hex token derived from the
 * ABSOLUTE worktree path — NOT the primary-root-collapsed identifier from
 * `getProjectIdentifier()`. By design we want sibling worktrees to receive
 * different tokens; `getProjectIdentifier()` intentionally collapses them so
 * cross-worktree state can be shared, which is exactly what we need to bypass.
 *
 * Token contract
 * --------------
 * - Stable: same worktree path -> same token across calls and processes.
 * - Distinct: different worktree paths -> different tokens (with overwhelming
 *   probability for any practical number of worktrees).
 * - Safe: matches /^[0-9a-f]{8}$/ — embeddable in tmux session names,
 *   filesystem paths (case-insensitive FS friendly), and git branch names.
 *
 * Process inheritance
 * -------------------
 * The lead process and its spawned worker processes must agree on the same
 * scope token, but the worker runs inside a per-worker git worktree where
 * `getWorktreeRoot()` resolves to a DIFFERENT path. To bridge that gap, the
 * lead exports `OMC_TEAM_SCOPE_TOKEN` into each worker's environment at spawn
 * time. When that env var is present, this module returns it verbatim instead
 * of recomputing from `process.cwd()`.
 */

import { createHash } from 'crypto';
import { getWorktreeRoot } from '../lib/worktree-paths.js';

/** Length of the hex-encoded scope token. 8 chars = 32 bits. */
const TOKEN_LENGTH = 8;

/** Env var that pins the scope token for a child process (set by the lead). */
export const SCOPE_ENV_VAR = 'OMC_TEAM_SCOPE_TOKEN';

const TOKEN_RE = /^[0-9a-f]{8}$/;

/** Validate that a value is a well-formed scope token. */
export function isValidScopeToken(value: unknown): value is string {
  return typeof value === 'string' && TOKEN_RE.test(value);
}

/**
 * Compute the worktree-scope token.
 *
 * Resolution order:
 *   1. `process.env.OMC_TEAM_SCOPE_TOKEN` if it is a well-formed token.
 *   2. SHA-256 (8 hex chars) of `workingDirectory`, if provided.
 *   3. SHA-256 (8 hex chars) of `getWorktreeRoot(process.cwd()) || process.cwd()`.
 *
 * @param workingDirectory - Absolute path inside a worktree. Optional.
 * @returns 8-char lowercase hex digest.
 */
export function getWorktreeScopeToken(workingDirectory?: string): string {
  const fromEnv = process.env[SCOPE_ENV_VAR];
  if (isValidScopeToken(fromEnv)) return fromEnv;

  const root = workingDirectory || getWorktreeRoot() || process.cwd();
  return createHash('sha256').update(root).digest('hex').slice(0, TOKEN_LENGTH);
}
