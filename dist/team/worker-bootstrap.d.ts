import type { CliAgentType } from './model-contract.js';
export interface WorkerBootstrapParams {
    teamName: string;
    workerName: string;
    agentType: CliAgentType;
    tasks: Array<{
        id: string;
        subject: string;
        description: string;
    }>;
    bootstrapInstructions?: string;
    cwd: string;
}
export declare function generateTriggerMessage(teamName: string, workerName: string): string;
export declare function generateMailboxTriggerMessage(teamName: string, workerName: string, count?: number): string;
/**
 * Generate the worker overlay markdown.
 * This is injected as AGENTS.md content for the worker agent.
 * CRITICAL: All task content is sanitized via sanitizePromptContent() before embedding.
 * Does NOT mutate the project AGENTS.md.
 */
export declare function generateWorkerOverlay(params: WorkerBootstrapParams): string;
/**
 * Write the initial inbox file for a worker.
 */
export declare function composeInitialInbox(teamName: string, workerName: string, content: string, cwd: string): Promise<void>;
/**
 * Append a message to the worker inbox.
 */
export declare function appendToInbox(teamName: string, workerName: string, message: string, cwd: string): Promise<void>;
export { getWorkerEnv } from './model-contract.js';
/**
 * Ensure worker state directory exists.
 */
export declare function ensureWorkerStateDir(teamName: string, workerName: string, cwd: string): Promise<void>;
/**
 * Write worker overlay as an AGENTS.md file in the worker state dir.
 * This is separate from the project AGENTS.md — it will be passed to the worker via inbox.
 */
export declare function writeWorkerOverlay(params: WorkerBootstrapParams): Promise<string>;
//# sourceMappingURL=worker-bootstrap.d.ts.map