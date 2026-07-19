import { type SessionEndActionName } from './cleanup-manifest.js';
export interface SessionEndWorkerPayload {
    directory: string;
    sessionId: string;
}
/** Durable OpenClaw routing is supplied from the manifest to the action runner, never from worker ambient state. */
export declare function workerEnvironment(): NodeJS.ProcessEnv;
export declare function spawnSessionEndWorker(payload: SessionEndWorkerPayload): boolean;
export declare function executeSessionEndAction(name: SessionEndActionName, payload: SessionEndWorkerPayload, deadlineAt: number): Promise<void>;
export declare function processSessionEndWorker(payload: SessionEndWorkerPayload): Promise<void>;
/** Bounded fair SessionStart recovery based on durable tickets, not a directory page. */
export declare function reconcileSessionEndJobs(directory: string, sessionIds?: readonly string[]): void;
//# sourceMappingURL=worker.d.ts.map