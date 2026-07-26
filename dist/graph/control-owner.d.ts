import { type GraphPlatformAdapter } from './platform.js';
import type { ControlChildRegistration, ControlLineageIdentity, ControlOwnerState, GraphClaimLineage, GraphControlMode, GraphDriverLease } from './runtime-types.js';
export type ControlModeClassification = 'root' | 'non_owner' | 'unknown';
export declare function classifyControlMode(mode: string): ControlModeClassification;
export declare class ControlOwnerError extends Error {
    readonly code: string;
    constructor(code: string, message: string);
}
export interface ControlOwnerDependencies {
    fileExists(path: string): boolean;
    readText(path: string): string;
    writeAtomic(path: string, value: unknown): void;
    withExclusiveLock<T>(path: string, callback: (renew?: () => void) => T): {
        acquired: boolean;
        value: T | undefined;
    };
}
export interface ControlOwnerStoreOptions {
    sessionId: string;
    worktreeRoot?: string;
    platform?: GraphPlatformAdapter;
    dependencies?: Partial<ControlOwnerDependencies>;
}
export interface ReserveRootInput {
    mode: GraphControlMode;
    run_id: string;
    nonce: string;
    reserved_at: string;
    graph_revision?: {
        revision_id: string;
        revision_hash: string;
    };
}
export interface PromoteRootInput {
    mode: GraphControlMode;
    run_id: string;
    nonce: string;
    promoted_at: string;
    driver_lease: GraphDriverLease;
}
export interface RegisterChildInput extends Omit<ControlChildRegistration, 'registered_at'> {
    registered_at: string;
}
export interface GraphReleaseDisposition {
    graph_status: 'paused' | 'failed' | 'cancelled' | 'succeeded';
    claims_fenced: boolean;
    children_drained: boolean;
}
export interface ReleaseRootInput {
    mode: GraphControlMode;
    run_id: string;
    nonce: string;
    disposition: GraphReleaseDisposition;
    released_at: string;
}
export interface LegacyControlCandidate {
    mode: GraphControlMode;
    session_id?: string;
    run_id?: string;
    active: boolean;
    terminal?: boolean;
    parent?: ControlLineageIdentity;
    linked_ultrawork?: boolean;
    linked_to_ralph?: boolean;
    graph_revision?: {
        revision_id: string;
        revision_hash: string;
    };
    graph_claim?: GraphClaimLineage;
}
export interface AdoptLegacyRootsInput {
    candidates: LegacyControlCandidate[];
    nonce: string;
    adopted_at: string;
}
export declare class ControlOwnerStore {
    readonly sessionId: string;
    readonly worktreeRoot: string | undefined;
    readonly path: string;
    private readonly readPath;
    private readonly platform;
    private readonly dependencies;
    constructor(options: ControlOwnerStoreOptions);
    read(): ControlOwnerState | null;
    reserveRoot(input: ReserveRootInput): ControlOwnerState;
    promoteRoot(input: PromoteRootInput): ControlOwnerState;
    registerChild(input: RegisterChildInput): ControlOwnerState;
    releaseRoot(input: ReleaseRootInput): {
        state: ControlOwnerState | null;
        released: boolean;
    };
    reservePausedGraph(input: {
        run_id: string;
        revision_id: string;
        revision_hash: string;
        nonce: string;
        graph_state: {
            session_id: string;
            run_id: string;
            revision_id: string;
            status: 'paused';
        };
        reserved_at: string;
    }): ControlOwnerState;
    recoverGraphReservation(input: {
        session_id: string;
        run_id: string;
        revision_id: string;
        revision_hash: string;
        status: 'draft' | 'awaiting_approval' | 'running' | 'waiting_human' | 'waiting_patch_approval' | 'reconciling' | 'paused' | 'failed' | 'cancelled' | 'succeeded';
        reservation_nonce: string;
        observed_at: string;
        driver_lease: GraphDriverLease;
    }): {
        state: ControlOwnerState;
        action: 'promoted' | 'released' | 'waiting' | 'already_active';
    };
    adoptLegacyRoots(input: AdoptLegacyRootsInput): ControlOwnerState;
    private emptyState;
    private requireExactRoot;
    private withRoot;
    private mutate;
}
//# sourceMappingURL=control-owner.d.ts.map