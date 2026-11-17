/**
 * Wiki Session Hooks
 *
 * SessionStart: load wiki context, inject relevant pages, lazy index rebuild,
 *   feed project-memory into wiki environment.md
 * SessionEnd: bounded append-only capture of session metadata
 * PreCompact: inject wiki summary for compaction survival
 */
export interface WikiSessionEndCaptureIntent {
    kind: 'wiki-session-end-capture';
    root: string;
    sessionId: string;
    filename: string;
    capturedAt: string;
    /** Durable intent identity; safe to persist because it is a one-way digest. */
    captureKey?: string;
}
export interface WikiSessionEndCommitOptions {
    /** Absolute deadline in epoch milliseconds for a worker-owned commit. */
    deadlineAt?: number;
    /** Maximum time to wait for the existing wiki lock. */
    lockTimeoutMs?: number;
}
/**
 * Build a JSON-safe SessionEnd capture intent without taking the wiki lock or
 * mutating the filesystem. The manifest worker durably owns and commits it.
 */
export declare function buildWikiSessionEndCaptureIntent(data: {
    cwd?: string;
    session_id?: string;
}): WikiSessionEndCaptureIntent | null;
/**
 * Commit a capture intent under the existing wiki lock. Replaying the same
 * intent never duplicates its page or its log entry.
 */
export declare function commitWikiSessionEndCaptureIntent(intent: WikiSessionEndCaptureIntent, options?: WikiSessionEndCommitOptions): boolean;
/**
 * SessionStart hook: inject wiki context into session.
 *
 * 1. Read wiki index, rebuild if stale
 * 2. Feed project-memory into environment.md if newer
 * 3. Return context summary for injection
 */
export declare function onSessionStart(data: {
    cwd?: string;
}): {
    additionalContext?: string;
};
/**
 * SessionEnd foreground compatibility hook. It deliberately constructs no
 * writes and never acquires the wiki lock; the session wrapper enqueues the
 * intent for the manifest worker to commit.
 */
export declare function onSessionEnd(_data: {
    cwd?: string;
    session_id?: string;
}): {
    continue: boolean;
};
/**
 * PreCompact hook: inject wiki summary for compaction survival.
 */
export declare function onPreCompact(data: {
    cwd?: string;
}): {
    additionalContext?: string;
};
//# sourceMappingURL=session-hooks.d.ts.map