/**
 * Prompt Persistence - Audit trail for external model prompts and responses
 *
 * Writes assembled prompts and model responses to .omc/prompts/ before/after
 * sending to Codex/Gemini, providing visibility, debugging, and compliance audit trail.
 */
/**
 * Convert text to a filesystem-safe slug for filename
 *
 * @param text - The text to slugify (typically the user prompt)
 * @param maxWords - Maximum number of words to include (default 4)
 * @returns A filesystem-safe slug
 */
export declare function slugify(text: string, maxWords?: number): string;
/**
 * Generate a short unique identifier
 *
 * @returns 8-character hex string
 */
export declare function generatePromptId(): string;
/**
 * Options for persisting a prompt
 */
export interface PersistPromptOptions {
    provider: 'codex' | 'gemini';
    agentRole: string;
    model: string;
    files?: string[];
    prompt: string;
    fullPrompt: string;
    workingDirectory?: string;
}
/**
 * Options for persisting a response
 */
export interface PersistResponseOptions {
    provider: 'codex' | 'gemini';
    agentRole: string;
    model: string;
    promptId: string;
    slug: string;
    response: string;
    usedFallback?: boolean;
    fallbackModel?: string;
    workingDirectory?: string;
}
/**
 * Result from persisting a prompt
 */
export interface PersistPromptResult {
    filePath: string;
    id: string;
    slug: string;
}
/**
 * Job status for background execution tracking
 */
export interface JobStatus {
    provider: 'codex' | 'gemini';
    jobId: string;
    slug: string;
    status: 'spawned' | 'running' | 'completed' | 'failed' | 'timeout';
    pid?: number;
    promptFile: string;
    responseFile: string;
    model: string;
    agentRole: string;
    spawnedAt: string;
    completedAt?: string;
    error?: string;
    usedFallback?: boolean;
    fallbackModel?: string;
    killedByUser?: boolean;
}
/**
 * Metadata passed to background execution functions
 */
export interface BackgroundJobMeta {
    provider: 'codex' | 'gemini';
    jobId: string;
    slug: string;
    agentRole: string;
    model: string;
    promptFile: string;
    responseFile: string;
}
/**
 * Get the prompts directory path under the worktree
 */
export declare function getPromptsDir(workingDirectory?: string): string;
/**
 * Persist a prompt to disk with YAML frontmatter
 *
 * @param options - The prompt details to persist
 * @returns The file path and metadata, or undefined on failure
 */
export declare function persistPrompt(options: PersistPromptOptions): PersistPromptResult | undefined;
/**
 * Get the expected response file path without writing it
 * Useful for returning the path immediately before background execution completes
 *
 * @param provider - The provider (codex or gemini)
 * @param slug - The slug from the prompt
 * @param promptId - The ID from the prompt
 * @param workingDirectory - Optional working directory
 * @returns The expected file path for the response
 */
export declare function getExpectedResponsePath(provider: 'codex' | 'gemini', slug: string, promptId: string, workingDirectory?: string): string;
/**
 * Persist a model response to disk with YAML frontmatter
 *
 * @param options - The response details to persist
 * @returns The file path, or undefined on failure
 */
export declare function persistResponse(options: PersistResponseOptions): string | undefined;
/**
 * Get the status file path for a background job
 */
export declare function getStatusFilePath(provider: 'codex' | 'gemini', slug: string, promptId: string, workingDirectory?: string): string;
/**
 * Write job status atomically (temp file + rename)
 */
export declare function writeJobStatus(status: JobStatus, workingDirectory?: string): void;
/**
 * Look up the working directory that was used when a job was created.
 * Returns undefined if the job was created in the server's CWD (no override).
 */
export declare function getJobWorkingDir(provider: 'codex' | 'gemini', jobId: string): string | undefined;
/**
 * Read job status from disk
 */
export declare function readJobStatus(provider: 'codex' | 'gemini', slug: string, promptId: string, workingDirectory?: string): JobStatus | undefined;
/**
 * Check if a background job's response is ready
 */
export declare function checkResponseReady(provider: 'codex' | 'gemini', slug: string, promptId: string, workingDirectory?: string): {
    ready: boolean;
    responsePath: string;
    status?: JobStatus;
};
/**
 * Read a completed response, stripping YAML frontmatter
 */
export declare function readCompletedResponse(provider: 'codex' | 'gemini', slug: string, promptId: string, workingDirectory?: string): {
    response: string;
    status: JobStatus;
} | undefined;
/**
 * List all active (spawned or running) background jobs
 */
export declare function listActiveJobs(provider?: 'codex' | 'gemini', workingDirectory?: string): JobStatus[];
/**
 * Mark stale background jobs (older than maxAgeMs) as timed out
 */
export declare function cleanupStaleJobs(maxAgeMs: number, workingDirectory?: string): number;
//# sourceMappingURL=prompt-persistence.d.ts.map