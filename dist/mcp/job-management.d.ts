/**
 * Job Management - MCP tool handlers for background job lifecycle
 *
 * Provides four tools for managing background Codex/Gemini jobs:
 * - wait_for_job: Poll-wait until a background job completes (or times out)
 * - check_job_status: Non-blocking status check for a background job
 * - kill_job: Send a signal to a running background job
 * - list_jobs: List background jobs filtered by status
 *
 * All handlers are provider-scoped: each server hardcodes its provider and
 * passes it as the first argument. Schemas omit provider since it's implicit.
 */
/**
 * Find the status file for a job by provider and jobId.
 * Scans .omc/prompts/ for files matching the naming convention.
 *
 * Handles 0/1/many matches:
 * - 0 matches: returns undefined
 * - 1 match: returns { statusPath, slug }
 * - Many matches: prefers non-terminal (active) status, then newest spawnedAt
 */
export declare function findJobStatusFile(provider: 'codex' | 'gemini', jobId: string, workingDirectory?: string): {
    statusPath: string;
    slug: string;
} | undefined;
/**
 * wait_for_job - block (poll) until a background job reaches a terminal state.
 * Uses exponential backoff: 500ms base, 1.5x factor, 2000ms cap.
 *
 * WARNING: This function blocks the MCP request handler for the duration of the poll.
 * For non-blocking checks, use handleCheckJobStatus instead.
 */
export declare function handleWaitForJob(provider: 'codex' | 'gemini', jobId: string, timeoutMs?: number): Promise<{
    content: Array<{
        type: 'text';
        text: string;
    }>;
    isError?: boolean;
}>;
/**
 * check_job_status - non-blocking status check
 */
export declare function handleCheckJobStatus(provider: 'codex' | 'gemini', jobId: string): Promise<{
    content: Array<{
        type: 'text';
        text: string;
    }>;
    isError?: boolean;
}>;
/**
 * kill_job - send a signal to a running background job
 */
export declare function handleKillJob(provider: 'codex' | 'gemini', jobId: string, signal?: string): Promise<{
    content: Array<{
        type: 'text';
        text: string;
    }>;
    isError?: boolean;
}>;
/**
 * list_jobs - list background jobs with status filter and limit.
 * Provider is hardcoded per-server (passed as first arg).
 */
export declare function handleListJobs(provider: 'codex' | 'gemini', statusFilter?: 'active' | 'completed' | 'failed' | 'all', limit?: number): Promise<{
    content: Array<{
        type: 'text';
        text: string;
    }>;
    isError?: boolean;
}>;
export declare function getJobManagementToolSchemas(_provider?: 'codex' | 'gemini'): ({
    name: string;
    description: string;
    inputSchema: {
        type: "object";
        properties: {
            job_id: {
                type: string;
                description: string;
            };
            timeout_ms: {
                type: string;
                description: string;
            };
            signal?: undefined;
            status_filter?: undefined;
            limit?: undefined;
        };
        required: string[];
    };
} | {
    name: string;
    description: string;
    inputSchema: {
        type: "object";
        properties: {
            job_id: {
                type: string;
                description: string;
            };
            timeout_ms?: undefined;
            signal?: undefined;
            status_filter?: undefined;
            limit?: undefined;
        };
        required: string[];
    };
} | {
    name: string;
    description: string;
    inputSchema: {
        type: "object";
        properties: {
            job_id: {
                type: string;
                description: string;
            };
            signal: {
                type: string;
                enum: string[];
                description: string;
            };
            timeout_ms?: undefined;
            status_filter?: undefined;
            limit?: undefined;
        };
        required: string[];
    };
} | {
    name: string;
    description: string;
    inputSchema: {
        type: "object";
        properties: {
            status_filter: {
                type: string;
                enum: string[];
                description: string;
            };
            limit: {
                type: string;
                description: string;
            };
            job_id?: undefined;
            timeout_ms?: undefined;
            signal?: undefined;
        };
        required: string[];
    };
})[];
//# sourceMappingURL=job-management.d.ts.map