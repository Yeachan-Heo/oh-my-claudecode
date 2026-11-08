/**
 * Portable PreCompact checkpoint restore and replay fencing (issue #3817).
 *
 * Marker publication is intentionally fail-closed.  The canonical OMC/state
 * ancestry is revalidated around every sensitive operation. Publication uses
 * a deterministic immutable claim created by no-clobber hard-link CAS from a
 * random O_EXCL stage; the retained stage link is the ownership witness, so no
 * raced pathname cleanup is required on Linux, macOS, or Windows.
 */
import type { CompactCheckpoint } from './index.js';
export declare const CHECKPOINT_MAX_AGE_MS: number;
export declare const CHECKPOINT_MAX_BYTES: number;
export declare const RESTORE_CONTEXT_MAX_CHARS = 1200;
type MarkerStatus = 'written' | 'existing' | 'contended' | 'unsupported' | 'failed' | 'invalid_session_id';
export type RestoreMarkerStatus = MarkerStatus;
export interface RestoredCheckpointContext {
    text: string;
    marker_status: RestoreMarkerStatus;
}
export type RestoreCandidate = {
    ok: true;
    checkpoint: CompactCheckpoint;
    path: string;
    mtimeMs: number;
    contentSha256: string;
} | {
    ok: false;
    reason: 'missing' | 'no_checkpoints' | 'stale' | 'oversized' | 'malformed' | 'already_restored' | 'invalid_session_id';
    path?: string;
    detail?: string;
};
export declare function markCheckpointRestored(directory: string, sessionId: string, checkpointPath: string, checkpointCreatedAt?: string, checkpointMtimeMs?: number, checkpointSha256?: string): RestoreMarkerStatus;
export declare function findLatestCheckpointForRestore(directory: string, sessionId: string): RestoreCandidate;
export declare function formatCheckpointRestoreContext(checkpoint: CompactCheckpoint, path: string): string;
export declare function restorePreCompactCheckpoint(directory: string, sessionId: string): RestoredCheckpointContext | null;
export {};
//# sourceMappingURL=restore.d.ts.map