import { type GraphState, type JsonValue } from './runtime-types.js';
export type GraphFenceScope = 'active' | 'pending_patch_base';
export interface GraphStateFence {
    session_id: string;
    run_id: string;
    revision_id: string;
    revision_hash: string;
    dispatch_generation: number;
    commit_sequence: number;
}
export interface GraphMutationRequest {
    transition_id: string;
    operation: string;
    operation_fingerprint: string;
    expected: GraphStateFence;
    fence_scope?: GraphFenceScope;
}
export interface GraphMutationValue<T extends JsonValue> {
    next: GraphState;
    result: T;
}
export interface GraphMutationResult<T extends JsonValue> {
    state: GraphState;
    result: T;
    replayed: boolean;
}
export interface GraphStateStoreDependencies {
    fileExists(path: string): boolean;
    readText(path: string): string;
    /**
     * Reads the OCC journal's authoritative current committed state (the
     * max-complete journal entry's state). Under (B) the journal - NOT the
     * canonical file - is the source of truth; the canonical file is a derived
     * cache re-published on each commit. Returns null when the journal is empty
     * or on an unreadable journal directory (fail closed).
     */
    readCurrent(path: string): unknown;
    /**
     * OCC (optimistic concurrency control) commit. Runs `mutate(currentState,
     * ownerToken)` purely against the OCC-validated current committed state and
     * commits it atomically (O_EXCL claim + parent-validation). Returns the
     * committed { state, result } or null on fork-exhaustion / fail-closed I/O.
     * Replaces the old lease-lock + writeAtomic publish (B11 root cure): a stale
     * writer that forks off an old parent is re-sequenced AFTER its successor
     * instead of overwriting it.
     */
    occCommit<TState, TResult>(path: string, mutate: (currentState: unknown, ownerToken: string) => {
        state: TState;
        result: TResult;
    } | null, options?: {
        ownerToken?: string;
    }): {
        state: TState;
        result: TResult;
    } | null;
    now?(): string;
}
export interface GraphStateStoreOptions {
    sessionId: string;
    worktreeRoot?: string;
    dependencies?: Partial<GraphStateStoreDependencies>;
}
export declare class GraphStoreError extends Error {
    readonly code: string;
    constructor(code: string, message: string);
}
export declare class GraphStateStore {
    readonly sessionId: string;
    readonly worktreeRoot: string | undefined;
    readonly path: string;
    private readonly readPath;
    private readonly dependencies;
    constructor(options: GraphStateStoreOptions);
    read(): GraphState | null;
    create(state: GraphState): GraphState;
    mutate<T extends JsonValue>(request: GraphMutationRequest, callback: (state: GraphState, renew: () => void) => GraphMutationValue<T>): GraphMutationResult<T>;
    private assertStateSize;
}
//# sourceMappingURL=store.d.ts.map