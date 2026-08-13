/**
 * PreCompact Checkpoint Restore (issue #3730)
 *
 * The PreCompact hook writes checkpoints under `.omc/state/checkpoints/`
 * (see ./index.ts) but historically nothing read them back: the pre-compact
 * `systemMessage` fired once before compaction and the checkpoint file was
 * write-only. After auto-compact the session continues with a native summary,
 * and OMC-owned state (active mode progress, TODO counts, plan anchors) was
 * gone from context.
 *
 * This module restores the newest matching checkpoint after compaction.
 *
 * Contract:
 * - Restore is bound to the compaction lifecycle: the caller (SessionStart
 *   hook) invokes this only when the session-start source indicates a
 *   post-compaction resume (`source === 'compact'`). It never runs on plain
 *   startup/resume/clear.
 * - Newest-wins: among matching checkpoints the most recent `created_at` wins.
 * - Bounded: checkpoints older than CHECKPOINT_MAX_AGE_MS or larger than
 *   CHECKPOINT_MAX_BYTES are ignored.
 * - Fail-open: any missing/malformed/oversized/stale checkpoint yields
 *   `{ ok: false, reason }` with a useful diagnostic; the caller continues.
 * - No replay: a checkpoint already restored for a session is not injected
 *   again (marker file, session-scoped).
 * - No cross-project leakage: lookup is always scoped to the checkpoint
 *   directory derived from the caller's own directory (getOmcRoot).
 * - Restore is read-only with respect to the checkpoint file itself; only a
 *   small session-scoped marker records that a restore happened.
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'fs';
import { join } from 'path';
import { getOmcRoot } from '../../lib/worktree-paths.js';
import type { CompactCheckpoint } from './index.js';

// ============================================================================
// Constants
// ============================================================================

/** Checkpoints older than this are considered stale and never restored. */
export const CHECKPOINT_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24h, matches session-end cleanup

/** Checkpoint files larger than this are rejected without parsing. */
export const CHECKPOINT_MAX_BYTES = 256 * 1024;

/** Restore context is capped to keep SessionStart budget intact. */
export const RESTORE_CONTEXT_MAX_CHARS = 1200;

/** Only files matching this pattern are checkpoint candidates. */
const CHECKPOINT_FILE_PATTERN = /^checkpoint-.+\.json$/;

const RESTORE_MARKER_DIR = 'checkpoints-restored';

/**
 * Mirrors SESSION_ID_REGEX from src/lib/worktree-paths.ts::validateSessionId.
 * The session ID becomes a path segment under the restore-marker directory,
 * so anything outside this allowlist must be rejected before path join.
 */
const SESSION_ID_ALLOWLIST = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,255}$/;

function isValidSessionId(sessionId: string): boolean {
  return typeof sessionId === 'string' && SESSION_ID_ALLOWLIST.test(sessionId);
}

// ============================================================================
// Types
// ============================================================================

export type RestoreCandidate =
  | {
      ok: true;
      checkpoint: CompactCheckpoint;
      path: string;
    }
  | {
      ok: false;
      reason:
        | 'missing' // no checkpoint directory
        | 'no_checkpoints' // directory exists but has no candidates
        | 'stale' // newest candidate is older than the age bound
        | 'oversized' // candidate exceeds the size bound
        | 'malformed' // candidate is not parseable checkpoint JSON
        | 'already_restored' // newest candidate was already restored this session
        | 'invalid_session_id'; // session ID failed allowlist validation
      path?: string;
      detail?: string;
    };

// ============================================================================
// Restore marker (replay guard)
// ============================================================================

function getRestoreMarkerPath(directory: string, sessionId: string): string {
  return join(
    getOmcRoot(directory),
    'state',
    RESTORE_MARKER_DIR,
    sessionId,
    'restored.json',
  );
}

/**
 * Record that a checkpoint was restored for a session.
 * Session-scoped: different sessions may restore the same checkpoint.
 * Never throws — replay protection must not break restore.
 */
export function markCheckpointRestored(
  directory: string,
  sessionId: string,
  checkpointPath: string,
): void {
  if (!isValidSessionId(sessionId)) {
    return; // never write a marker for an unvalidated session ID
  }
  try {
    const markerPath = getRestoreMarkerPath(directory, sessionId);
    mkdirSync(join(markerPath, '..'), { recursive: true });
    writeFileSync(
      markerPath,
      JSON.stringify({ restored_at: new Date().toISOString(), checkpoint: checkpointPath }),
      'utf-8',
    );
  } catch {
    // Fail-open: if the marker cannot be written, the worst case is a
    // duplicate injection on an extremely unlikely double fire of the same
    // session-start event, which is benign advisory context.
  }
}

function isCheckpointRestored(
  directory: string,
  sessionId: string,
  checkpointPath: string,
): boolean {
  try {
    const markerPath = getRestoreMarkerPath(directory, sessionId);
    if (!existsSync(markerPath)) {
      return false;
    }
    const marker = JSON.parse(readFileSync(markerPath, 'utf-8'));
    return marker?.checkpoint === checkpointPath;
  } catch {
    return false;
  }
}

// ============================================================================
// Candidate discovery
// ============================================================================

interface CandidateFile {
  name: string;
  path: string;
  mtimeMs: number;
}

function listCheckpointCandidates(checkpointDir: string): CandidateFile[] {
  let entries: string[];
  try {
    entries = readdirSync(checkpointDir);
  } catch {
    return [];
  }

  const candidates: CandidateFile[] = [];
  for (const name of entries) {
    if (!CHECKPOINT_FILE_PATTERN.test(name)) {
      continue;
    }
    const path = join(checkpointDir, name);
    try {
      const stat = statSync(path);
      if (!stat.isFile()) {
        continue;
      }
      candidates.push({ name, path, mtimeMs: stat.mtimeMs });
    } catch {
      // Unreadable entry — skip it.
    }
  }

  return candidates;
}

function parseCheckpoint(path: string): CompactCheckpoint | null {
  let raw: string;
  try {
    const stat = statSync(path);
    if (!Number.isFinite(stat.size) || stat.size > CHECKPOINT_MAX_BYTES) {
      return null;
    }
    raw = readFileSync(path, 'utf-8');
    if (raw.length > CHECKPOINT_MAX_BYTES) {
      return null;
    }
  } catch {
    return null;
  }

  try {
    const parsed = JSON.parse(raw) as CompactCheckpoint;
    if (typeof parsed?.created_at !== 'string') {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function isWithinAgeBound(createdAt: string): boolean {
  const created = Date.parse(createdAt);
  if (!Number.isFinite(created)) {
    return false;
  }
  const age = Date.now() - created;
  return age >= 0 && age <= CHECKPOINT_MAX_AGE_MS;
}

interface ScoredCandidate {
  name: string;
  path: string;
  mtimeMs: number;
  checkpoint: CompactCheckpoint;
}

/**
 * Sort candidates newest-first. The authoritative order key is the
 * checkpoint's `created_at` field (parsed from JSON). File mtime is a
 * tiebreaker only, because files written in quick succession may share
 * the same mtime millisecond.
 */
function sortNewestFirst(candidates: ScoredCandidate[]): ScoredCandidate[] {
  return candidates.sort((a, b) => {
    const ta = Date.parse(a.checkpoint.created_at);
    const tb = Date.parse(b.checkpoint.created_at);
    if (Number.isFinite(ta) && Number.isFinite(tb) && ta !== tb) {
      return tb - ta;
    }
    return b.mtimeMs - a.mtimeMs;
  });
}

/**
 * Find the newest checkpoint eligible for restore in this directory/session.
 *
 * Returns `ok: false` with a reason on every failure mode; never throws.
 */
export function findLatestCheckpointForRestore(
  directory: string,
  sessionId: string,
): RestoreCandidate {
  // Session ID becomes a path segment in the replay-marker directory. Reject
  // anything the canonical session-ID contract rejects so a malicious ID
  // cannot traverse out of .omc/state/checkpoints-restored/.
  if (!isValidSessionId(sessionId)) {
    return { ok: false, reason: 'invalid_session_id' };
  }

  const checkpointDir = join(getOmcRoot(directory), 'state', 'checkpoints');

  if (!existsSync(checkpointDir)) {
    return { ok: false, reason: 'missing' };
  }

  const raw = listCheckpointCandidates(checkpointDir);
  if (raw.length === 0) {
    return { ok: false, reason: 'no_checkpoints' };
  }

  // Parse every candidate; keep parseable ones. Malformed candidates are
  // dropped rather than failing the whole restore — the newest *parseable*
  // checkpoint is the restore target.
  const scored: ScoredCandidate[] = [];
  let newestUnparseable: CandidateFile | null = null;
  for (const c of raw) {
    const checkpoint = parseCheckpoint(c.path);
    if (checkpoint) {
      scored.push({ name: c.name, path: c.path, mtimeMs: c.mtimeMs, checkpoint });
    } else if (!newestUnparseable || c.mtimeMs > newestUnparseable.mtimeMs) {
      newestUnparseable = c;
    }
  }

  if (scored.length === 0) {
    const c = newestUnparseable;
    return {
      ok: false,
      reason: 'malformed',
      path: c?.path,
      detail: c ? `could not parse ${c.name} (or it exceeds ${CHECKPOINT_MAX_BYTES} bytes)` : undefined,
    };
  }

  sortNewestFirst(scored);

  // Walk newest-to-oldest. The replay guard is per-file-per-session: a
  // checkpoint already injected to this session is skipped, but a different
  // (older) checkpoint is a legitimate restore target — it represents state
  // the session has not yet seen injected.
  //
  // Age and malformed candidates are graded failure modes that report the
  // relevant checkpoint path so callers get actionable diagnostics.
  const newestOverall = scored[0];

  for (const candidate of scored) {
    if (sessionId && isCheckpointRestored(directory, sessionId, candidate.path)) {
      continue;
    }
    // First non-restored candidate.
    if (!isWithinAgeBound(candidate.checkpoint.created_at)) {
      return {
        ok: false,
        reason: 'stale',
        path: candidate.path,
        detail: `checkpoint ${candidate.name} older than ${CHECKPOINT_MAX_AGE_MS}ms`,
      };
    }
    return { ok: true, checkpoint: candidate.checkpoint, path: candidate.path };
  }

  // Every parseable candidate was already restored for this session.
  return {
    ok: false,
    reason: 'already_restored',
    path: newestOverall.path,
    detail: `all ${scored.length} checkpoint(s) already restored for session ${sessionId}`,
  };
}

// ============================================================================
// Restore context formatting
// ============================================================================

function truncate(text: string, max: number): string {
  if (text.length <= max) {
    return text;
  }
  return `${text.slice(0, max - 1)}…`;
}

/**
 * Format a restored checkpoint as bounded, advisory SessionStart context.
 *
 * Mirrors the durable anchors the writer records (modes, TODOs, plan refs) —
 * it does not re-serialize conversation content or native summaries.
 */
export function formatCheckpointRestoreContext(
  checkpoint: CompactCheckpoint,
  path: string,
): string {
  const lines: string[] = [
    '[PRECOMPACT CHECKPOINT RESTORED]',
    '',
    `Checkpoint: ${checkpoint.created_at} (trigger: ${checkpoint.trigger})`,
    'Source: PreCompact checkpoint written before the last compaction.',
  ];

  const modes = checkpoint.active_modes ?? {};
  const modeEntries = Object.entries(modes).filter(([, v]) => v != null) as Array<
    [string, NonNullable<(typeof modes)[keyof typeof modes]>]
  >;
  if (modeEntries.length > 0) {
    lines.push('', 'Active modes at compaction time:');
    for (const [name, mode] of modeEntries) {
      if ('iteration' in mode && typeof mode.iteration === 'number') {
        lines.push(`- ${name} (iteration ${mode.iteration})`);
      } else if ('cycle' in mode && typeof mode.cycle === 'number') {
        lines.push(`- ${name} (cycle ${mode.cycle})`);
      } else if ('phase' in mode && typeof mode.phase === 'string') {
        lines.push(`- ${name} (phase ${mode.phase})`);
      } else {
        lines.push(`- ${name}`);
      }
    }
  }

  const todos = checkpoint.todo_summary;
  const todoTotal = (todos?.pending ?? 0) + (todos?.in_progress ?? 0) + (todos?.completed ?? 0);
  if (todoTotal > 0) {
    lines.push(
      '',
      `TODOs at compaction time: ${todos.pending} pending, ${todos.in_progress} in progress, ${todos.completed} completed.`,
    );
  }

  const refs = checkpoint.plan_refs;
  if (refs?.prd) {
    const prd = refs.prd;
    lines.push(
      '',
      `Active PRD: ${prd.title ?? 'untitled'} (status: ${prd.status ?? 'unknown'}, stories: ${prd.stories_completed ?? 0}/${prd.stories_total ?? 0})`,
    );
    lines.push(`PRD file: ${prd.path}`);
  }
  if (refs?.boulder) {
    const boulder = refs.boulder;
    lines.push(
      '',
      `Active plan (boulder): ${boulder.plan_name ?? 'unnamed'} — ${boulder.progress?.completed ?? 0}/${boulder.progress?.total ?? 0} steps done.`,
    );
    lines.push(`Plan file: ${boulder.active_plan}`);
  }

  if (checkpoint.wisdom_exported) {
    lines.push('', 'Plan wisdom was exported before compaction (see .omc/state/checkpoints/wisdom-*.md).');
  }

  lines.push(
    '',
    'Treat this as prior-session context only. Prioritize the current user request; consult the plan/PRD files above before resuming long-running work.',
    `Raw checkpoint: ${path}`,
  );

  return truncate(lines.join('\n'), RESTORE_CONTEXT_MAX_CHARS);
}
