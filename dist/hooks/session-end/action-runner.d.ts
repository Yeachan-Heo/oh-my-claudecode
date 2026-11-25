import type { SessionEndActionName, SessionEndActionState, SessionEndJobV1 } from './cleanup-manifest.js';
export interface ActionRunContext {
    directory: string;
    sessionId: string;
    job: SessionEndJobV1;
    actionName: SessionEndActionName;
    action: SessionEndActionState;
    ownerNonce: string;
    runnerNonce: string;
    deadlineAt: number;
}
export interface ActionRunResult {
    code: string;
    completed: boolean;
}
/** Each deferred action runs in its own detached process group. The manifest remains the only authority for claim/result transitions. */
export declare function runSessionEndAction(context: ActionRunContext, _execute: () => Promise<void>): Promise<ActionRunResult>;
//# sourceMappingURL=action-runner.d.ts.map