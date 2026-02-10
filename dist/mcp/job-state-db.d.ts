/**
 * Job State Database - SQLite-based persistent state for Codex/Gemini background jobs
 *
 * Provides a single shared database at .omc/state/jobs.db for both providers.
 * Uses better-sqlite3 with WAL mode for safe concurrent access from multiple
 * MCP server instances. Only job metadata is stored here; prompt/response
 * content remains as files on disk.
 *
 * Follows the same patterns as src/hooks/swarm/state.ts:
 * - Dynamic import of better-sqlite3 with graceful fallback
 * - WAL mode for concurrency
 * - Schema versioning with migrations
 * - Per-worktree db instances keyed by resolved path
 * - All functions return false/null on failure (no throws)
 */
import type BetterSqlite3 from "better-sqlite3";
import type { JobStatus } from "./prompt-persistence.js";
/**
 * Initialize the SQLite job state database.
 * Creates the database file and tables if they don't exist.
 * Uses WAL mode for safe concurrent access from multiple processes.
 *
 * @param cwd - The project working directory (worktree root)
 * @returns true if initialization succeeded, false on failure
 */
export declare function initJobDb(cwd: string): Promise<boolean>;
/**
 * Close the database connection for a specific cwd, or all connections if no cwd provided.
 * Safe to call multiple times; no-ops if already closed.
 *
 * @deprecated When called without cwd, use closeAllJobDbs() instead for explicit intent.
 */
export declare function closeJobDb(cwd?: string): void;
/**
 * Explicitly close all open database connections.
 * Preferred over calling closeJobDb() without arguments.
 */
export declare function closeAllJobDbs(): void;
/**
 * Check if the job database is initialized and connected.
 *
 * @param cwd - Optional cwd to check specific instance; if omitted, checks if any instance exists
 * @returns true if the database is ready for queries
 */
export declare function isJobDbInitialized(cwd?: string): boolean;
/**
 * Get the raw database instance for advanced use.
 *
 * @param cwd - Optional cwd to get specific instance
 * @returns The better-sqlite3 Database instance, or null if not initialized
 */
export declare function getJobDb(cwd?: string): BetterSqlite3.Database | null;
/**
 * Insert or update a job record from a JobStatus object.
 * Maps camelCase JobStatus fields to snake_case database columns.
 * Uses INSERT OR REPLACE (upsert on the composite primary key).
 *
 * @param status - The JobStatus to persist
 * @returns true if the upsert succeeded, false on failure
 */
export declare function upsertJob(status: JobStatus, cwd?: string): boolean;
/**
 * Get a single job by provider and job ID.
 *
 * @param provider - The provider ('codex' or 'gemini')
 * @param jobId - The unique job identifier
 * @returns The JobStatus if found, null otherwise
 */
export declare function getJob(provider: "codex" | "gemini", jobId: string, cwd?: string): JobStatus | null;
/**
 * Get jobs filtered by provider and/or status.
 *
 * @param provider - Filter by provider, or undefined for all providers
 * @param status - Filter by status string
 * @returns Array of matching JobStatus objects, empty array on failure
 */
export declare function getJobsByStatus(provider: "codex" | "gemini" | undefined, status: string, cwd?: string): JobStatus[];
/**
 * Get all active (spawned or running) jobs, optionally filtered by provider.
 *
 * @param provider - Filter by provider, or undefined for all providers
 * @returns Array of active JobStatus objects, empty array on failure
 */
export declare function getActiveJobs(provider?: "codex" | "gemini", cwd?: string): JobStatus[];
/**
 * Get recent jobs within a time window, optionally filtered by provider.
 * Compares spawned_at ISO strings against a cutoff timestamp.
 *
 * @param provider - Filter by provider, or undefined for all providers
 * @param withinMs - Time window in milliseconds (default: 1 hour)
 * @returns Array of recent JobStatus objects, empty array on failure
 */
export declare function getRecentJobs(provider?: "codex" | "gemini", withinMs?: number, cwd?: string): JobStatus[];
/**
 * Partially update a job's fields. Only provided fields are updated;
 * omitted fields are left unchanged.
 *
 * @param provider - The provider ('codex' or 'gemini')
 * @param jobId - The unique job identifier
 * @param updates - Partial JobStatus with fields to update
 * @returns true if the update succeeded, false on failure
 */
export declare function updateJobStatus(provider: "codex" | "gemini", jobId: string, updates: Partial<JobStatus>, cwd?: string): boolean;
/**
 * Delete a job record by provider and job ID.
 *
 * @param provider - The provider ('codex' or 'gemini')
 * @param jobId - The unique job identifier
 * @returns true if deletion succeeded, false on failure
 */
export declare function deleteJob(provider: "codex" | "gemini", jobId: string, cwd?: string): boolean;
/**
 * Migrate existing JSON status files into the SQLite database.
 * Scans the prompts directory for *-status-*.json files, parses each,
 * and upserts into the jobs table. Existing records are overwritten.
 *
 * @param promptsDir - Path to the .omc/prompts/ directory
 * @returns Object with imported and error counts
 */
export declare function migrateFromJsonFiles(promptsDir: string, cwd?: string): {
    imported: number;
    errors: number;
};
/**
 * Delete completed/failed/timeout jobs older than the specified age.
 * Only removes terminal-state jobs; active jobs are never cleaned up.
 *
 * @param maxAgeMs - Maximum age in milliseconds (default: 24 hours)
 * @returns Number of jobs deleted, 0 on failure
 */
export declare function cleanupOldJobs(maxAgeMs?: number, cwd?: string): number;
/**
 * Get aggregate job statistics for monitoring and diagnostics.
 *
 * @returns Object with total, active, completed, and failed counts, or null on failure
 */
export declare function getJobStats(cwd?: string): {
    total: number;
    active: number;
    completed: number;
    failed: number;
} | null;
/**
 * Generate a markdown summary of job state for PreCompact system message injection.
 * Includes active jobs with details and a brief summary of recent completed jobs.
 *
 * @returns Formatted markdown string, or empty string on failure
 */
export declare function getJobSummaryForPreCompact(cwd?: string): string;
//# sourceMappingURL=job-state-db.d.ts.map