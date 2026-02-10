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
import { existsSync, mkdirSync, readdirSync, readFileSync } from "fs";
import { join, resolve } from "path";
// Schema version - bump when adding migrations
const DB_SCHEMA_VERSION = 1;
// Default max age for cleanup: 24 hours
const DEFAULT_CLEANUP_MAX_AGE_MS = 24 * 60 * 60 * 1000;
// Dynamic import for better-sqlite3 to handle environments where it's not installed
let Database = null;
// Map of resolved worktree root path -> database instance (replaces singleton)
const dbMap = new Map();
// Track the last cwd used for backward-compatible no-arg calls
let _lastCwd = null;
/**
 * Get the database instance for a given cwd.
 * Falls back to the last initialized cwd if none provided.
 */
function getDb(cwd) {
    if (cwd) {
        const resolved = resolve(cwd);
        return dbMap.get(resolved) ?? null;
    }
    // Emit deprecation warning when multiple DBs are open and no cwd provided
    if (dbMap.size > 1) {
        console.warn('[job-state-db] DEPRECATED: getDb() called without explicit cwd while multiple DBs are open. Pass cwd explicitly.');
    }
    // Backward compat: use last initialized cwd
    if (_lastCwd) {
        console.warn('[job-state-db] DEPRECATED: using _lastCwd fallback. Pass cwd explicitly.');
        return dbMap.get(_lastCwd) ?? null;
    }
    // Return any available instance (single-worktree case)
    if (dbMap.size === 1) {
        return dbMap.values().next().value ?? null;
    }
    return null;
}
/**
 * Get the database file path
 */
function getDbPath(cwd) {
    return join(cwd, ".omc", "state", "jobs.db");
}
/**
 * Ensure the state directory exists
 */
function ensureStateDir(cwd) {
    const stateDir = join(cwd, ".omc", "state");
    if (!existsSync(stateDir)) {
        mkdirSync(stateDir, { recursive: true });
    }
}
/**
 * Map a database row (snake_case) to a JobStatus object (camelCase)
 */
function rowToJobStatus(row) {
    return {
        provider: row.provider,
        jobId: row.job_id,
        slug: row.slug,
        status: row.status,
        pid: row.pid ?? undefined,
        promptFile: row.prompt_file,
        responseFile: row.response_file,
        model: row.model,
        agentRole: row.agent_role,
        spawnedAt: row.spawned_at,
        completedAt: row.completed_at ?? undefined,
        error: row.error ?? undefined,
        usedFallback: row.used_fallback === 1 ? true : undefined,
        fallbackModel: row.fallback_model ?? undefined,
        killedByUser: row.killed_by_user === 1 ? true : undefined,
    };
}
// --- DB Lifecycle ---
/**
 * Initialize the SQLite job state database.
 * Creates the database file and tables if they don't exist.
 * Uses WAL mode for safe concurrent access from multiple processes.
 *
 * @param cwd - The project working directory (worktree root)
 * @returns true if initialization succeeded, false on failure
 */
export async function initJobDb(cwd) {
    try {
        // Dynamic import of better-sqlite3 (may not be installed)
        if (!Database) {
            try {
                const betterSqlite3 = await import("better-sqlite3");
                Database = betterSqlite3.default;
            }
            catch (importError) {
                const errorMessage = importError instanceof Error
                    ? importError.message
                    : String(importError);
                console.error("[job-state-db] Failed to load better-sqlite3:", errorMessage);
                console.error("[job-state-db] Install with: npm install better-sqlite3");
                return false;
            }
        }
        if (!Database) {
            return false;
        }
        const resolvedCwd = resolve(cwd);
        // Return early if already initialized for this cwd
        if (dbMap.has(resolvedCwd)) {
            _lastCwd = resolvedCwd;
            return true;
        }
        ensureStateDir(cwd);
        const dbPath = getDbPath(cwd);
        const db = new Database(dbPath);
        // Enable WAL mode for better concurrency (multiple MCP servers)
        db.pragma("journal_mode = WAL");
        // Create tables
        db.exec(`
      -- Schema version tracking
      CREATE TABLE IF NOT EXISTS schema_info (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      -- Job metadata for Codex/Gemini background jobs
      CREATE TABLE IF NOT EXISTS jobs (
        job_id TEXT NOT NULL,
        provider TEXT NOT NULL CHECK (provider IN ('codex', 'gemini')),
        slug TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'spawned' CHECK (status IN ('spawned', 'running', 'completed', 'failed', 'timeout')),
        pid INTEGER,
        prompt_file TEXT NOT NULL,
        response_file TEXT NOT NULL,
        model TEXT NOT NULL,
        agent_role TEXT NOT NULL,
        spawned_at TEXT NOT NULL,
        completed_at TEXT,
        error TEXT,
        used_fallback INTEGER DEFAULT 0,
        fallback_model TEXT,
        killed_by_user INTEGER DEFAULT 0,
        PRIMARY KEY (provider, job_id)
      );

      -- Indexes for common query patterns
      CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
      CREATE INDEX IF NOT EXISTS idx_jobs_provider ON jobs(provider);
      CREATE INDEX IF NOT EXISTS idx_jobs_spawned_at ON jobs(spawned_at);
      CREATE INDEX IF NOT EXISTS idx_jobs_provider_status ON jobs(provider, status);
    `);
        // Check current schema version for future migrations
        const versionStmt = db.prepare("SELECT value FROM schema_info WHERE key = 'version'");
        const versionRow = versionStmt.get();
        const _currentVersion = versionRow ? parseInt(versionRow.value, 10) : 0;
        // Future migrations would go here:
        // if (_currentVersion > 0 && _currentVersion < 2) { ... }
        // Set schema version
        const setVersion = db.prepare("INSERT OR REPLACE INTO schema_info (key, value) VALUES (?, ?)");
        setVersion.run("version", String(DB_SCHEMA_VERSION));
        dbMap.set(resolvedCwd, db);
        _lastCwd = resolvedCwd;
        return true;
    }
    catch (error) {
        console.error("[job-state-db] Failed to initialize database:", error);
        return false;
    }
}
/**
 * Close the database connection for a specific cwd, or all connections if no cwd provided.
 * Safe to call multiple times; no-ops if already closed.
 *
 * @deprecated When called without cwd, use closeAllJobDbs() instead for explicit intent.
 */
export function closeJobDb(cwd) {
    if (cwd) {
        const resolvedCwd = resolve(cwd);
        const db = dbMap.get(resolvedCwd);
        if (db) {
            try {
                db.close();
            }
            catch { /* Ignore close errors */ }
            dbMap.delete(resolvedCwd);
            if (_lastCwd === resolvedCwd)
                _lastCwd = null;
        }
    }
    else {
        if (dbMap.size > 0) {
            console.warn('[job-state-db] DEPRECATED: closeJobDb() called without cwd. Use closeAllJobDbs() for explicit intent.');
        }
        // Close all connections
        for (const [key, db] of dbMap.entries()) {
            try {
                db.close();
            }
            catch { /* Ignore close errors */ }
            dbMap.delete(key);
        }
        _lastCwd = null;
    }
}
/**
 * Explicitly close all open database connections.
 * Preferred over calling closeJobDb() without arguments.
 */
export function closeAllJobDbs() {
    for (const [key, db] of dbMap.entries()) {
        try {
            db.close();
        }
        catch { /* Ignore close errors */ }
        dbMap.delete(key);
    }
    _lastCwd = null;
}
/**
 * Check if the job database is initialized and connected.
 *
 * @param cwd - Optional cwd to check specific instance; if omitted, checks if any instance exists
 * @returns true if the database is ready for queries
 */
export function isJobDbInitialized(cwd) {
    if (cwd) {
        return dbMap.has(resolve(cwd));
    }
    return dbMap.size > 0;
}
/**
 * Get the raw database instance for advanced use.
 *
 * @param cwd - Optional cwd to get specific instance
 * @returns The better-sqlite3 Database instance, or null if not initialized
 */
export function getJobDb(cwd) {
    return getDb(cwd);
}
// --- CRUD Operations ---
/**
 * Insert or update a job record from a JobStatus object.
 * Maps camelCase JobStatus fields to snake_case database columns.
 * Uses INSERT OR REPLACE (upsert on the composite primary key).
 *
 * @param status - The JobStatus to persist
 * @returns true if the upsert succeeded, false on failure
 */
export function upsertJob(status, cwd) {
    const db = getDb(cwd);
    if (!db)
        return false;
    try {
        const stmt = db.prepare(`
      INSERT OR REPLACE INTO jobs (
        job_id, provider, slug, status, pid,
        prompt_file, response_file, model, agent_role,
        spawned_at, completed_at, error,
        used_fallback, fallback_model, killed_by_user
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
        stmt.run(status.jobId, status.provider, status.slug, status.status, status.pid ?? null, status.promptFile, status.responseFile, status.model, status.agentRole, status.spawnedAt, status.completedAt ?? null, status.error ?? null, status.usedFallback ? 1 : 0, status.fallbackModel ?? null, status.killedByUser ? 1 : 0);
        return true;
    }
    catch (error) {
        console.error("[job-state-db] Failed to upsert job:", error);
        return false;
    }
}
/**
 * Get a single job by provider and job ID.
 *
 * @param provider - The provider ('codex' or 'gemini')
 * @param jobId - The unique job identifier
 * @returns The JobStatus if found, null otherwise
 */
export function getJob(provider, jobId, cwd) {
    const db = getDb(cwd);
    if (!db)
        return null;
    try {
        const stmt = db.prepare("SELECT * FROM jobs WHERE provider = ? AND job_id = ?");
        const row = stmt.get(provider, jobId);
        if (!row)
            return null;
        return rowToJobStatus(row);
    }
    catch (error) {
        console.error("[job-state-db] Failed to get job:", error);
        return null;
    }
}
/**
 * Get jobs filtered by provider and/or status.
 *
 * @param provider - Filter by provider, or undefined for all providers
 * @param status - Filter by status string
 * @returns Array of matching JobStatus objects, empty array on failure
 */
export function getJobsByStatus(provider, status, cwd) {
    const db = getDb(cwd);
    if (!db)
        return [];
    try {
        let stmt;
        let rows;
        if (provider) {
            stmt = db.prepare("SELECT * FROM jobs WHERE provider = ? AND status = ? ORDER BY spawned_at DESC");
            rows = stmt.all(provider, status);
        }
        else {
            stmt = db.prepare("SELECT * FROM jobs WHERE status = ? ORDER BY spawned_at DESC");
            rows = stmt.all(status);
        }
        return rows.map(rowToJobStatus);
    }
    catch (error) {
        console.error("[job-state-db] Failed to get jobs by status:", error);
        return [];
    }
}
/**
 * Get all active (spawned or running) jobs, optionally filtered by provider.
 *
 * @param provider - Filter by provider, or undefined for all providers
 * @returns Array of active JobStatus objects, empty array on failure
 */
export function getActiveJobs(provider, cwd) {
    const db = getDb(cwd);
    if (!db)
        return [];
    try {
        let stmt;
        let rows;
        if (provider) {
            stmt = db.prepare("SELECT * FROM jobs WHERE provider = ? AND status IN ('spawned', 'running') ORDER BY spawned_at DESC");
            rows = stmt.all(provider);
        }
        else {
            stmt = db.prepare("SELECT * FROM jobs WHERE status IN ('spawned', 'running') ORDER BY spawned_at DESC");
            rows = stmt.all();
        }
        return rows.map(rowToJobStatus);
    }
    catch (error) {
        console.error("[job-state-db] Failed to get active jobs:", error);
        return [];
    }
}
/**
 * Get recent jobs within a time window, optionally filtered by provider.
 * Compares spawned_at ISO strings against a cutoff timestamp.
 *
 * @param provider - Filter by provider, or undefined for all providers
 * @param withinMs - Time window in milliseconds (default: 1 hour)
 * @returns Array of recent JobStatus objects, empty array on failure
 */
export function getRecentJobs(provider, withinMs = 60 * 60 * 1000, cwd) {
    const db = getDb(cwd);
    if (!db)
        return [];
    try {
        const cutoff = new Date(Date.now() - withinMs).toISOString();
        let stmt;
        let rows;
        if (provider) {
            stmt = db.prepare("SELECT * FROM jobs WHERE provider = ? AND spawned_at > ? ORDER BY spawned_at DESC");
            rows = stmt.all(provider, cutoff);
        }
        else {
            stmt = db.prepare("SELECT * FROM jobs WHERE spawned_at > ? ORDER BY spawned_at DESC");
            rows = stmt.all(cutoff);
        }
        return rows.map(rowToJobStatus);
    }
    catch (error) {
        console.error("[job-state-db] Failed to get recent jobs:", error);
        return [];
    }
}
/**
 * Partially update a job's fields. Only provided fields are updated;
 * omitted fields are left unchanged.
 *
 * @param provider - The provider ('codex' or 'gemini')
 * @param jobId - The unique job identifier
 * @param updates - Partial JobStatus with fields to update
 * @returns true if the update succeeded, false on failure
 */
export function updateJobStatus(provider, jobId, updates, cwd) {
    const db = getDb(cwd);
    if (!db)
        return false;
    try {
        const setClauses = [];
        const values = [];
        if (updates.status !== undefined) {
            setClauses.push("status = ?");
            values.push(updates.status);
        }
        if (updates.pid !== undefined) {
            setClauses.push("pid = ?");
            values.push(updates.pid ?? null);
        }
        if (updates.completedAt !== undefined) {
            setClauses.push("completed_at = ?");
            values.push(updates.completedAt ?? null);
        }
        if (updates.error !== undefined) {
            setClauses.push("error = ?");
            values.push(updates.error ?? null);
        }
        if (updates.usedFallback !== undefined) {
            setClauses.push("used_fallback = ?");
            values.push(updates.usedFallback ? 1 : 0);
        }
        if (updates.fallbackModel !== undefined) {
            setClauses.push("fallback_model = ?");
            values.push(updates.fallbackModel ?? null);
        }
        if (updates.killedByUser !== undefined) {
            setClauses.push("killed_by_user = ?");
            values.push(updates.killedByUser ? 1 : 0);
        }
        if (updates.slug !== undefined) {
            setClauses.push("slug = ?");
            values.push(updates.slug);
        }
        if (updates.model !== undefined) {
            setClauses.push("model = ?");
            values.push(updates.model);
        }
        if (updates.agentRole !== undefined) {
            setClauses.push("agent_role = ?");
            values.push(updates.agentRole);
        }
        // Nothing to update
        if (setClauses.length === 0)
            return true;
        values.push(provider, jobId);
        const stmt = db.prepare(`UPDATE jobs SET ${setClauses.join(", ")} WHERE provider = ? AND job_id = ?`);
        stmt.run(...values);
        return true;
    }
    catch (error) {
        console.error("[job-state-db] Failed to update job status:", error);
        return false;
    }
}
/**
 * Delete a job record by provider and job ID.
 *
 * @param provider - The provider ('codex' or 'gemini')
 * @param jobId - The unique job identifier
 * @returns true if deletion succeeded, false on failure
 */
export function deleteJob(provider, jobId, cwd) {
    const db = getDb(cwd);
    if (!db)
        return false;
    try {
        const stmt = db.prepare("DELETE FROM jobs WHERE provider = ? AND job_id = ?");
        stmt.run(provider, jobId);
        return true;
    }
    catch (error) {
        console.error("[job-state-db] Failed to delete job:", error);
        return false;
    }
}
// --- Migration ---
/**
 * Migrate existing JSON status files into the SQLite database.
 * Scans the prompts directory for *-status-*.json files, parses each,
 * and upserts into the jobs table. Existing records are overwritten.
 *
 * @param promptsDir - Path to the .omc/prompts/ directory
 * @returns Object with imported and error counts
 */
export function migrateFromJsonFiles(promptsDir, cwd) {
    const result = { imported: 0, errors: 0 };
    const db = getDb(cwd);
    if (!db)
        return result;
    if (!existsSync(promptsDir))
        return result;
    try {
        const files = readdirSync(promptsDir);
        const statusFiles = files.filter((f) => f.includes("-status-") && f.endsWith(".json"));
        // Use a transaction for bulk import efficiency
        const importAll = db.transaction(() => {
            for (const file of statusFiles) {
                try {
                    const content = readFileSync(join(promptsDir, file), "utf-8");
                    const status = JSON.parse(content);
                    // Validate minimum required fields
                    if (!status.provider || !status.jobId || !status.promptFile) {
                        result.errors++;
                        continue;
                    }
                    if (upsertJob(status, cwd)) {
                        result.imported++;
                    }
                    else {
                        result.errors++;
                    }
                }
                catch {
                    result.errors++;
                }
            }
        });
        importAll();
    }
    catch (error) {
        console.error("[job-state-db] Failed to migrate from JSON files:", error);
    }
    return result;
}
// --- Cleanup ---
/**
 * Delete completed/failed/timeout jobs older than the specified age.
 * Only removes terminal-state jobs; active jobs are never cleaned up.
 *
 * @param maxAgeMs - Maximum age in milliseconds (default: 24 hours)
 * @returns Number of jobs deleted, 0 on failure
 */
export function cleanupOldJobs(maxAgeMs = DEFAULT_CLEANUP_MAX_AGE_MS, cwd) {
    const db = getDb(cwd);
    if (!db)
        return 0;
    try {
        const cutoff = new Date(Date.now() - maxAgeMs).toISOString();
        const stmt = db.prepare(`
      DELETE FROM jobs
      WHERE status IN ('completed', 'failed', 'timeout')
        AND spawned_at < ?
    `);
        const info = stmt.run(cutoff);
        return info.changes;
    }
    catch (error) {
        console.error("[job-state-db] Failed to cleanup old jobs:", error);
        return 0;
    }
}
// --- Stats ---
/**
 * Get aggregate job statistics for monitoring and diagnostics.
 *
 * @returns Object with total, active, completed, and failed counts, or null on failure
 */
export function getJobStats(cwd) {
    const db = getDb(cwd);
    if (!db)
        return null;
    try {
        const stmt = db.prepare(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN status IN ('spawned', 'running') THEN 1 ELSE 0 END) as active,
        SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed,
        SUM(CASE WHEN status IN ('failed', 'timeout') THEN 1 ELSE 0 END) as failed
      FROM jobs
    `);
        const row = stmt.get();
        return {
            total: row.total ?? 0,
            active: row.active ?? 0,
            completed: row.completed ?? 0,
            failed: row.failed ?? 0,
        };
    }
    catch (error) {
        console.error("[job-state-db] Failed to get job stats:", error);
        return null;
    }
}
/**
 * Generate a markdown summary of job state for PreCompact system message injection.
 * Includes active jobs with details and a brief summary of recent completed jobs.
 *
 * @returns Formatted markdown string, or empty string on failure
 */
export function getJobSummaryForPreCompact(cwd) {
    const db = getDb(cwd);
    if (!db)
        return "";
    try {
        const lines = [];
        // Active jobs with full details
        const activeJobs = getActiveJobs(undefined, cwd);
        if (activeJobs.length > 0) {
            lines.push("## Active Background Jobs");
            lines.push("");
            for (const job of activeJobs) {
                const elapsed = Date.now() - new Date(job.spawnedAt).getTime();
                const elapsedMin = Math.round(elapsed / 60000);
                lines.push(`- **${job.provider}** \`${job.jobId}\` (${job.agentRole}, ${job.model}): ${job.status} for ${elapsedMin}m`);
                lines.push(`  - Prompt: \`${job.promptFile}\``);
                lines.push(`  - Response: \`${job.responseFile}\``);
                if (job.pid) {
                    lines.push(`  - PID: ${job.pid}`);
                }
            }
            lines.push("");
        }
        // Recent completed/failed jobs (last hour) - brief summary
        const recentJobs = getRecentJobs(undefined, 60 * 60 * 1000, cwd);
        const terminalJobs = recentJobs.filter((j) => j.status === "completed" || j.status === "failed" || j.status === "timeout");
        if (terminalJobs.length > 0) {
            lines.push("## Recent Completed Jobs (last hour)");
            lines.push("");
            for (const job of terminalJobs.slice(0, 10)) {
                const icon = job.status === "completed" ? "done" : job.status;
                const fallback = job.usedFallback
                    ? ` (fallback: ${job.fallbackModel})`
                    : "";
                const errorNote = job.error ? ` - error: ${job.error.slice(0, 80)}` : "";
                lines.push(`- **${job.provider}** \`${job.jobId}\` (${job.agentRole}): ${icon}${fallback}${errorNote}`);
            }
            if (terminalJobs.length > 10) {
                lines.push(`- ... and ${terminalJobs.length - 10} more`);
            }
            lines.push("");
        }
        // Overall stats
        const stats = getJobStats(cwd);
        if (stats && stats.total > 0) {
            lines.push(`**Job totals:** ${stats.total} total, ${stats.active} active, ${stats.completed} completed, ${stats.failed} failed`);
        }
        return lines.join("\n");
    }
    catch (error) {
        console.error("[job-state-db] Failed to generate PreCompact summary:", error);
        return "";
    }
}
//# sourceMappingURL=job-state-db.js.map