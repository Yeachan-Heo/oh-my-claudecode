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
 * - No symlink traversal: the canonical OMC root, state directory, checkpoint
 *   directory, and candidate file must remain stable regular paths.
 * - Descriptor-bound reads: checkpoint bytes are read through an O_NOFOLLOW
 *   descriptor and verified with fstat before parsing.
 * - Restore is read-only with respect to the checkpoint file itself; only a
 *   small session-scoped marker records that a restore happened.
 */
import type { CompactCheckpoint } from './index.js';
/** Checkpoints older than this are considered stale and never restored. */
export declare const CHECKPOINT_MAX_AGE_MS: number;
/** Checkpoint files larger than this are rejected without parsing. */
export declare const CHECKPOINT_MAX_BYTES: number;
/** Restore context is capped to keep SessionStart budget intact. */
export declare const RESTORE_CONTEXT_MAX_CHARS = 1200;
export type RestoreCandidate = {
    ok: true;
    checkpoint: CompactCheckpoint;
    path: string;
    mtimeMs: number;
} | {
    ok: false;
    reason: 'missing' | 'no_checkpoints' | 'stale' | 'oversized' | 'malformed' | 'already_restored' | 'invalid_session_id';
    path?: string;
    detail?: string;
};
export type RestoreMarkerStatus = 'written' | 'existing' | 'contended' | 'unsupported' | 'failed' | 'invalid_session_id';
export interface RestoredCheckpointContext {
    text: string;
    marker_status: RestoreMarkerStatus;
}
/**
 * Record that a checkpoint was restored for a session.
 * Session-scoped: different sessions may restore the same checkpoint.
 * Never throws — replay protection must not break restore.
 */
export declare function markCheckpointRestored(directory: string, sessionId: string, checkpointPath: string, checkpointCreatedAt?: string, checkpointMtimeMs?: number): RestoreMarkerStatus;
/**
 * Find the newest checkpoint eligible for restore in this directory/session.
 *
 * Returns `ok: false` with a reason on every failure mode; never throws.
 */
export declare function findLatestCheckpointForRestore(directory: string, sessionId: string): RestoreCandidate;
/**
 * Find and render the newest checkpoint only after replay-marker publication
 * succeeds. An existing marker is accepted only when its securely read
 * checkpoint path exactly matches the candidate; unsupported or failed marker
 * publication never exposes checkpoint text to the caller.
 */
export declare function restorePreCompactCheckpoint(directory: string, sessionId: string): RestoredCheckpointContext | null;
/**
 * Format a restored checkpoint as bounded, advisory SessionStart context.
 *
 * Mirrors the durable anchors the writer records (modes, TODOs, plan refs) —
 * it does not re-serialize conversation content or native summaries.
 */
export declare function formatCheckpointRestoreContext(checkpoint: CompactCheckpoint, path: string): string;
//# sourceMappingURL=restore.d.ts.map