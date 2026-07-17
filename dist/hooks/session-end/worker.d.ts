import { type SessionEndActionName } from './cleanup-manifest.js';
export interface SessionEndWorkerPayload {
    directory: string;
    sessionId: string;
}
/** Routing and CA paths are passed to the child, but never copied into a durable manifest. */
export declare function workerEnvironment(): NodeJS.ProcessEnv;
export declare function spawnSessionEndWorker(payload: SessionEndWorkerPayload): boolean;
export declare function executeSessionEndAction(name: SessionEndActionName, payload: SessionEndWorkerPayload, deadlineAt: number): Promise<void>;
export declare function processSessionEndWorker(payload: SessionEndWorkerPayload): Promise<void>;
/** Bounded fair SessionStart recovery based on durable tickets, not a directory page. */
export declare function reconcileSessionEndJobs(directory: string, sessionIds?: readonly string[]): void;
//# sourceMappingURL=worker.d.ts.map