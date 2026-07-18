export type SessionEndActionName = 'foreground-cleanup' | 'wiki-capture' | 'team-cleanup' | 'python-cleanup' | 'reply-cleanup' | 'callback' | 'notification' | 'openclaw';
export type ActionStatus = 'pending' | 'claimed' | 'retryable' | 'completed' | 'expired';
export interface SessionEndActionState {
    class: 'required' | 'best-effort';
    phase: 'deferred-required' | 'deferred-best-effort';
    status: ActionStatus;
    attempts: number;
    idempotencyKey: string;
    payload: Record<string, unknown>;
    budgetMs: number;
    claimantNonce?: string;
    claimedAt?: string;
    runner?: {
        attempt: number;
        runnerNonce: string;
        phase: 'reserved' | 'started' | 'armed' | 'result-recorded' | 'terminal';
        deadlineAt: string;
    };
    lastOutcomeCode?: string;
    completedAt?: string;
}
export interface ProducerSlot {
    state: 'absent' | 'prepared' | 'sealed' | 'no-op';
    intentKey?: string;
    payloadDigest?: string;
    sealedAt?: string;
    sealedBy?: 'foreground' | 'recovery' | 'wiki-producer';
}
export interface WorkerOwner {
    nonce: string;
    pid: number;
    processStartIdentity: string;
    claimedAt: string;
    heartbeatAt: string;
    leaseExpiresAt: string;
    runDeadlineAt: string;
    leaseGeneration: number;
    claimedFromRevision: number;
}
export interface SessionEndJobV1 {
    version: 1;
    jobId: string;
    sessionId: string;
    scopeKey: string;
    revision: number;
    createdAt: string;
    updatedAt: string;
    producerGraceExpiresAt: string;
    bestEffortDeadlineAt: string;
    producers: {
        core: ProducerSlot;
        wiki: ProducerSlot;
    };
    actions: Record<SessionEndActionName, SessionEndActionState>;
    owner: WorkerOwner | null;
    phase: 'collecting' | 'ready' | 'processing' | 'recoverable-failure' | 'complete';
    completion?: {
        completedAt: string;
        terminalDigest: string;
        terminalRevision: number;
    };
}
export interface OpenClawRoutingSnapshot {
    openClawConfig?: string;
    replyChannel?: string;
    replyTarget?: string;
    replyThread?: string;
    tmux?: string;
    tmuxPane?: string;
}
export interface DiscoveryTicket {
    sessionId: string;
    claimNonce?: string;
    leaseExpiresAt?: string;
    attempts: number;
    retryAt: string;
    acknowledgedAt?: string;
}
export declare function sessionEndJobPath(directory: string, sessionId: string): string;
export declare function sessionEndJobsDirectory(directory: string): string;
/** Terminality is solely a manifest property. Discovery tickets are deliberately excluded. */
export declare function isManifestTerminal(job: SessionEndJobV1): boolean;
export declare function readSessionEndJob(directory: string, sessionId: string): SessionEndJobV1 | null;
/** Locked expected-revision CAS with an exact post-write reread. */
export declare function mutateSessionEndJob(directory: string, sessionId: string, expectedRevision: number, mutate: (job: SessionEndJobV1) => void): SessionEndJobV1 | null;
export declare function prepareCoreManifest(directory: string, sessionId: string, payload: Record<string, unknown>): SessionEndJobV1 | null;
/** Foreground cleanup is idempotent local work; its durable result is the prerequisite for producer-grace sealing. */
export declare function completeForegroundCleanup(directory: string, sessionId: string, outcome: Record<string, unknown>): SessionEndJobV1 | null;
export declare function completeForegroundCleanupAndSealCore(directory: string, sessionId: string, outcome: Record<string, unknown>): SessionEndJobV1 | null;
export declare function sealCoreManifest(directory: string, sessionId: string): SessionEndJobV1 | null;
export declare function sealWikiManifest(directory: string, sessionId: string, payload?: Record<string, unknown>): SessionEndJobV1 | null;
export declare function claimSessionEndJob(directory: string, sessionId: string, nonce: string, identity: string, deadlineAt: number): SessionEndJobV1 | null;
export declare function renewSessionEndLease(directory: string, sessionId: string, nonce: string, generation: number, deadlineAt: number): SessionEndJobV1 | null;
/** Reaping is intentionally separate from a new claim. Caller must establish dead or PID-reused identity. */
export declare function reapStaleSessionEndOwner(directory: string, sessionId: string, expectedNonce: string, expectedGeneration: number, liveness: 'dead' | 'mismatch'): SessionEndJobV1 | null;
export declare function releaseSessionEndJob(directory: string, sessionId: string, nonce: string, generation: number): SessionEndJobV1 | null;
export declare function updateSessionEndJob(directory: string, sessionId: string, expectedOwner: string, mutate: (job: SessionEndJobV1) => void): SessionEndJobV1 | null;
export declare function claimSessionEndAction(directory: string, sessionId: string, ownerNonce: string, name: SessionEndActionName, deadlineAt: number): SessionEndJobV1 | null;
export declare function markSessionEndActionRunner(directory: string, sessionId: string, ownerNonce: string, name: SessionEndActionName, runnerNonce: string, phase: 'started' | 'armed' | 'result-recorded'): SessionEndJobV1 | null;
export declare function finishSessionEndAction(directory: string, sessionId: string, ownerNonce: string, name: SessionEndActionName, runnerNonce: string, completed: boolean, code: string): SessionEndJobV1 | null;
/** Claims fair durable discovery tickets and retires tickets whose manifests are terminal. */
export declare function claimSessionEndDiscoveryTickets(directory: string, limit?: number, leaseMs?: number): Array<{
    sessionId: string;
    nonce: string;
}>;
export declare function releaseSessionEndDiscoveryTicket(directory: string, sessionId: string, nonce: string, spawned: boolean): void;
export declare function acknowledgeSessionEndDiscoveryTicket(directory: string, sessionId: string): void;
/** Compatibility read-only page retained for callers that do not claim tickets. */
export declare function takeSessionEndDiscoveryPage(directory: string, limit?: number): string[];
/** Recovery may seal a prepared core only after foreground cleanup has a durable completed result. */
export declare function recoverPreparedCoreProducer(directory: string, sessionId: string): SessionEndJobV1 | null;
/** A prepared core cannot be recovered once its foreground prerequisite is exhausted after grace. */
export declare function failClosedExhaustedForegroundCleanup(directory: string, sessionId: string): SessionEndJobV1 | null;
/** A wiki-only handoff cannot safely infer the missing core cleanup intent. */
export declare function failClosedMissingCoreProducer(directory: string, sessionId: string): SessionEndJobV1 | null;
//# sourceMappingURL=cleanup-manifest.d.ts.map