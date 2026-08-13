// PreCompact checkpoint restore helper (issue #3730).
//
// Self-contained: no dist dependency. This is imported by session-start.mjs
// so it must work in a clean checkout without a build step. The TypeScript
// module at src/hooks/pre-compact/restore.ts mirrors this logic for library
// consumers and unit tests.

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';

const CHECKPOINT_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const CHECKPOINT_MAX_BYTES = 256 * 1024;
const RESTORE_CONTEXT_MAX_CHARS = 1200;
const CHECKPOINT_FILE_PATTERN = /^checkpoint-.+\.json$/;

// Mirrors SESSION_ID_REGEX from src/lib/worktree-paths.ts::validateSessionId.
// A valid session ID is alphanumeric (first char) followed by alphanumeric /
// hyphen / underscore, max 256 chars. This blocks path-traversal attempts
// (`../`, absolute paths, separators) before they reach path join.
const SESSION_ID_ALLOWLIST = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,255}$/;

function isValidSessionId(sessionId) {
  return typeof sessionId === 'string' && SESSION_ID_ALLOWLIST.test(sessionId);
}

function getCheckpointDir(omcRoot) {
  return join(omcRoot, 'state', 'checkpoints');
}

function getRestoreMarkerPath(omcRoot, sessionId) {
  return join(omcRoot, 'state', 'checkpoints-restored', sessionId, 'restored.json');
}

function isCheckpointRestored(omcRoot, sessionId, checkpointPath) {
  try {
    const markerPath = getRestoreMarkerPath(omcRoot, sessionId);
    if (!existsSync(markerPath)) return false;
    const marker = JSON.parse(readFileSync(markerPath, 'utf-8'));
    return marker?.checkpoint === checkpointPath;
  } catch {
    return false;
  }
}

function markCheckpointRestored(omcRoot, sessionId, checkpointPath) {
  try {
    const markerPath = getRestoreMarkerPath(omcRoot, sessionId);
    mkdirSync(join(markerPath, '..'), { recursive: true });
    writeFileSync(
      markerPath,
      JSON.stringify({ restored_at: new Date().toISOString(), checkpoint: checkpointPath }),
      'utf-8',
    );
  } catch {
    // Fail-open: replay protection must not break restore.
  }
}

function parseCheckpoint(path) {
  try {
    const stat = statSync(path);
    if (!Number.isFinite(stat.size) || stat.size > CHECKPOINT_MAX_BYTES) return null;
    const raw = readFileSync(path, 'utf-8');
    if (raw.length > CHECKPOINT_MAX_BYTES) return null;
    const parsed = JSON.parse(raw);
    if (typeof parsed?.created_at !== 'string') return null;
    return parsed;
  } catch {
    return null;
  }
}

function isWithinAgeBound(createdAt) {
  const created = Date.parse(createdAt);
  if (!Number.isFinite(created)) return false;
  const age = Date.now() - created;
  return age >= 0 && age <= CHECKPOINT_MAX_AGE_MS;
}

function truncate(text, max) {
  if (text.length <= max) return text;
  return text.slice(0, max - 1) + '…';
}

function formatRestoreContext(checkpoint, path) {
  const lines = [
    '[PRECOMPACT CHECKPOINT RESTORED]',
    '',
    `Checkpoint: ${checkpoint.created_at} (trigger: ${checkpoint.trigger})`,
    'Source: PreCompact checkpoint written before the last compaction.',
  ];

  const modes = checkpoint.active_modes || {};
  const entries = Object.entries(modes).filter(([, v]) => v != null);
  if (entries.length > 0) {
    lines.push('', 'Active modes at compaction time:');
    for (const [name, mode] of entries) {
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

  const todos = checkpoint.todo_summary || {};
  const todoTotal = (todos.pending || 0) + (todos.in_progress || 0) + (todos.completed || 0);
  if (todoTotal > 0) {
    lines.push('', `TODOs at compaction time: ${todos.pending} pending, ${todos.in_progress} in progress, ${todos.completed} completed.`);
  }

  const refs = checkpoint.plan_refs;
  if (refs?.prd) {
    const prd = refs.prd;
    lines.push('', `Active PRD: ${prd.title || 'untitled'} (status: ${prd.status || 'unknown'}, stories: ${prd.stories_completed || 0}/${prd.stories_total || 0})`);
    lines.push(`PRD file: ${prd.path}`);
  }
  if (refs?.boulder) {
    const boulder = refs.boulder;
    lines.push('', `Active plan (boulder): ${boulder.plan_name || 'unnamed'} — ${(boulder.progress?.completed) || 0}/${(boulder.progress?.total) || 0} steps done.`);
    lines.push(`Plan file: ${boulder.active_plan}`);
  }

  if (checkpoint.wisdom_exported) {
    lines.push('', 'Plan wisdom was exported before compaction (see .omc/state/checkpoints/wisdom-*.md).');
  }

  lines.push('', 'Treat this as prior-session context only. Prioritize the current user request; consult the plan/PRD files above before resuming long-running work.', `Raw checkpoint: ${path}`);

  return truncate(lines.join('\n'), RESTORE_CONTEXT_MAX_CHARS);
}

/**
 * Find and restore the newest PreCompact checkpoint for a session.
 * Returns null if no restore happened (fail-open).
 *
 * @param {string} omcRoot - resolved .omc root directory
 * @param {string} sessionId - session ID for replay guard
 * @returns {{ text: string } | null}
 */
export function restorePreCompactCheckpoint(omcRoot, sessionId) {
  try {
    // Session ID is used to build the replay-marker path. Reject anything the
    // canonical session-ID contract rejects so a malicious ID cannot traverse
    // out of .omc/state/checkpoints-restored/.
    if (!isValidSessionId(sessionId)) return null;

    const checkpointDir = getCheckpointDir(omcRoot);
    if (!existsSync(checkpointDir)) return null;

    let entries;
    try {
      entries = readdirSync(checkpointDir);
    } catch {
      return null;
    }

    // Collect and parse candidates
    const candidates = [];
    for (const name of entries) {
      if (!CHECKPOINT_FILE_PATTERN.test(name)) continue;
      const path = join(checkpointDir, name);
      try {
        const stat = statSync(path);
        if (!stat.isFile()) continue;
        const checkpoint = parseCheckpoint(path);
        if (checkpoint) {
          candidates.push({ name, path, mtimeMs: stat.mtimeMs, checkpoint });
        }
      } catch {
        // skip unreadable
      }
    }

    if (candidates.length === 0) return null;

    // Sort newest-first by created_at, then mtime
    candidates.sort((a, b) => {
      const ta = Date.parse(a.checkpoint.created_at);
      const tb = Date.parse(b.checkpoint.created_at);
      if (Number.isFinite(ta) && Number.isFinite(tb) && ta !== tb) return tb - ta;
      return b.mtimeMs - a.mtimeMs;
    });

    // Walk newest-to-oldest, skipping already-restored
    for (const candidate of candidates) {
      if (sessionId && isCheckpointRestored(omcRoot, sessionId, candidate.path)) continue;
      if (!isWithinAgeBound(candidate.checkpoint.created_at)) continue;
      // First non-restored, within-age candidate
      const text = formatRestoreContext(candidate.checkpoint, candidate.path);
      if (sessionId) markCheckpointRestored(omcRoot, sessionId, candidate.path);
      return { text };
    }

    return null;
  } catch {
    // Restore is advisory: never break session start.
    return null;
  }
}
