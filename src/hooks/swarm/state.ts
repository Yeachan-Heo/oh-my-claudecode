/**
 * Swarm State Management
 *
 * SQLite-based persistent state for swarm coordination.
 * Uses better-sqlite3 for synchronous operations with transaction support.
 * All state is stored in .omc/state/swarm.db
 */

import { existsSync, mkdirSync, unlinkSync } from "fs";
import { atomicWriteJsonSync } from "../../lib/atomic-write.js";
import { join } from "path";
import type BetterSqlite3 from "better-sqlite3";
import type {
  SwarmTask,
  SwarmState,
  AgentHeartbeat,
  SwarmStats,
} from "./types.js";
import { DB_SCHEMA_VERSION } from "./types.js";

/**
 * SwarmSummary interface for the JSON sidecar
 */
export interface SwarmSummary {
  session_id: string;
  started_at: string;
  updated_at: string;
  task_count: number;
  tasks_pending: number;
  tasks_claimed: number;
  tasks_done: number;
  active: boolean;
  project_path?: string;
}

// Type alias for the Database constructor
type DatabaseConstructor = typeof BetterSqlite3;

// Dynamic import for better-sqlite3 to handle environments where it's not installed
let Database: DatabaseConstructor | null = null;
let db: BetterSqlite3.Database | null = null;

/**
 * Get the database file path
 */
function getDbPath(cwd: string): string {
  return join(cwd, ".omc", "state", "swarm.db");
}

/**
 * Ensure the state directory exists
 */
function ensureStateDir(cwd: string): void {
  const stateDir = join(cwd, ".omc", "state");
  if (!existsSync(stateDir)) {
    mkdirSync(stateDir, { recursive: true });
  }
}

/**
 * Initialize the SQLite database
 * Creates tables if they don't exist
 */
export async function initDb(cwd: string): Promise<boolean> {
  try {
    if (!Database) {
      try {
        const betterSqlite3 = await import("better-sqlite3");
        Database = betterSqlite3.default;
      } catch (importError: unknown) {
        const errorMessage =
          importError instanceof Error
            ? importError.message
            : String(importError);
        console.error(
          "[Swarm] Failed to load better-sqlite3. Swarm mode requires this dependency.",
        );
        console.error("[Swarm] Import error:", errorMessage);
        console.error("[Swarm] Install with: npm install better-sqlite3");
        return false;
      }
    }

    if (!Database) {
      return false;
    }

    ensureStateDir(cwd);
    const dbPath = getDbPath(cwd);

    db = new Database(dbPath);

    // Enable WAL mode for better concurrency
    db.pragma("journal_mode = WAL");

    // Create tables
    db.exec(`
      -- Schema version tracking
      CREATE TABLE IF NOT EXISTS schema_info (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      -- Swarm session state
      CREATE TABLE IF NOT EXISTS swarm_session (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        session_id TEXT NOT NULL,
        active INTEGER NOT NULL DEFAULT 1,
        agent_count INTEGER NOT NULL,
        started_at INTEGER NOT NULL,
        completed_at INTEGER
      );

      -- Task pool
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        description TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'claimed', 'done', 'failed')),
        claimed_by TEXT,
        claimed_at INTEGER,
        completed_at INTEGER,
        error TEXT,
        result TEXT,
        priority INTEGER DEFAULT 0,
        wave INTEGER DEFAULT 1,
        owned_files TEXT,
        file_patterns TEXT
      );

      -- Agent heartbeats
      CREATE TABLE IF NOT EXISTS heartbeats (
        agent_id TEXT PRIMARY KEY,
        last_heartbeat INTEGER NOT NULL,
        current_task_id TEXT
      );

      -- Indexes for performance
      CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
      CREATE INDEX IF NOT EXISTS idx_tasks_claimed_by ON tasks(claimed_by);
      CREATE INDEX IF NOT EXISTS idx_heartbeats_last ON heartbeats(last_heartbeat);
    `);

    // Schema migration (MUST happen before version is overwritten)
    // Read current version BEFORE it gets replaced
    const versionStmt = db.prepare("SELECT value FROM schema_info WHERE key = 'version'");
    const versionRow = versionStmt.get() as { value: string } | undefined;
    const currentVersion = versionRow ? parseInt(versionRow.value, 10) : 0;

    // Migration v1 -> v2: Add priority, wave, owned_files, file_patterns columns
    if (currentVersion > 0 && currentVersion < 2) {
      // Only migrate existing databases (currentVersion > 0)
      // Fresh databases get columns from CREATE TABLE
      try {
        db.exec(`
          ALTER TABLE tasks ADD COLUMN priority INTEGER DEFAULT 0;
          ALTER TABLE tasks ADD COLUMN wave INTEGER DEFAULT 1;
          ALTER TABLE tasks ADD COLUMN owned_files TEXT;
          ALTER TABLE tasks ADD COLUMN file_patterns TEXT;
        `);
      } catch (e) {
        // Columns may already exist if migration was partial - ignore
        const err = e as Error;
        if (!err.message?.includes('duplicate column')) {
          throw e;
        }
      }
    }

    // Set schema version
    const setVersion = db.prepare(
      "INSERT OR REPLACE INTO schema_info (key, value) VALUES (?, ?)",
    );
    setVersion.run("version", String(DB_SCHEMA_VERSION));

    return true;
  } catch (error) {
    console.error("Failed to initialize swarm database:", error);
    return false;
  }
}

/**
 * Close the database connection
 */
export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}

/**
 * Delete the database file (for cleanup)
 */
export function deleteDb(cwd: string): boolean {
  try {
    closeDb();
    const dbPath = getDbPath(cwd);
    if (existsSync(dbPath)) {
      unlinkSync(dbPath);
    }
    // Also remove WAL and SHM files
    const walPath = dbPath + "-wal";
    const shmPath = dbPath + "-shm";
    if (existsSync(walPath)) unlinkSync(walPath);
    if (existsSync(shmPath)) unlinkSync(shmPath);
    return true;
  } catch (error) {
    console.error("Failed to delete swarm database:", error);
    return false;
  }
}

/**
 * Check if database is initialized and connected
 */
export function isDbInitialized(): boolean {
  return db !== null;
}

/**
 * Initialize a new swarm session
 */
export function initSession(sessionId: string, agentCount: number): boolean {
  if (!db) return false;

  try {
    const stmt = db.prepare(`
      INSERT OR REPLACE INTO swarm_session (id, session_id, active, agent_count, started_at, completed_at)
      VALUES (1, ?, 1, ?, ?, NULL)
    `);
    stmt.run(sessionId, agentCount, Date.now());
    return true;
  } catch (error) {
    console.error("Failed to initialize session:", error);
    return false;
  }
}

/**
 * Load the current swarm state
 */
export function loadState(): SwarmState | null {
  if (!db) return null;

  try {
    // Get session info
    const sessionStmt = db.prepare("SELECT * FROM swarm_session WHERE id = 1");
    const session = sessionStmt.get() as
      | {
          session_id: string;
          active: number;
          agent_count: number;
          started_at: number;
          completed_at: number | null;
        }
      | undefined;

    if (!session) return null;

    // Get all tasks
    const tasksStmt = db.prepare("SELECT * FROM tasks ORDER BY priority ASC, id ASC");
    const taskRows = tasksStmt.all() as Array<{
      id: string;
      description: string;
      status: string;
      claimed_by: string | null;
      claimed_at: number | null;
      completed_at: number | null;
      error: string | null;
      result: string | null;
      priority: number | null;
      wave: number | null;
      owned_files: string | null;
      file_patterns: string | null;
    }>;

    const tasks: SwarmTask[] = taskRows.map((row) => ({
      id: row.id,
      description: row.description,
      status: row.status as SwarmTask["status"],
      claimedBy: row.claimed_by,
      claimedAt: row.claimed_at,
      completedAt: row.completed_at,
      error: row.error ?? undefined,
      result: row.result ?? undefined,
      priority: row.priority ?? 0,
      wave: row.wave ?? 1,
      ownedFiles: row.owned_files ? JSON.parse(row.owned_files) : undefined,
      filePatterns: row.file_patterns ? JSON.parse(row.file_patterns) : undefined,
    }));

    return {
      active: session.active === 1,
      sessionId: session.session_id,
      agentCount: session.agent_count,
      tasks,
      startedAt: session.started_at,
      completedAt: session.completed_at,
    };
  } catch (error) {
    console.error("Failed to load swarm state:", error);
    return null;
  }
}

/**
 * Save swarm state (updates session info only, tasks are updated individually)
 */
export function saveState(state: Partial<SwarmState>): boolean {
  if (!db) return false;

  try {
    if (state.active !== undefined || state.completedAt !== undefined) {
      const updates: string[] = [];
      const values: (number | null)[] = [];

      if (state.active !== undefined) {
        updates.push("active = ?");
        values.push(state.active ? 1 : 0);
      }
      if (state.completedAt !== undefined) {
        updates.push("completed_at = ?");
        values.push(state.completedAt);
      }

      if (updates.length > 0) {
        const stmt = db.prepare(
          `UPDATE swarm_session SET ${updates.join(", ")} WHERE id = 1`,
        );
        stmt.run(...values);
      }
    }
    return true;
  } catch (error) {
    console.error("Failed to save swarm state:", error);
    return false;
  }
}

/**
 * Add a task to the pool
 */
export function addTask(
  id: string,
  description: string,
  options?: { priority?: number; wave?: number; ownedFiles?: string[]; filePatterns?: string[] }
): boolean {
  if (!db) return false;

  try {
    const stmt = db.prepare(`
      INSERT INTO tasks (id, description, status, claimed_by, claimed_at, completed_at, error, result, priority, wave, owned_files, file_patterns)
      VALUES (?, ?, 'pending', NULL, NULL, NULL, NULL, NULL, ?, ?, ?, ?)
    `);
    stmt.run(
      id,
      description,
      options?.priority ?? 0,
      options?.wave ?? 1,
      options?.ownedFiles ? JSON.stringify(options.ownedFiles) : null,
      options?.filePatterns ? JSON.stringify(options.filePatterns) : null
    );
    return true;
  } catch (error) {
    console.error("Failed to add task:", error);
    return false;
  }
}

/**
 * Add multiple tasks in a transaction
 */
export function addTasks(
  tasks: Array<{ id: string; description: string; priority?: number; wave?: number; ownedFiles?: string[]; filePatterns?: string[] }>,
): boolean {
  if (!db) return false;

  try {
    const stmt = db.prepare(`
      INSERT INTO tasks (id, description, status, claimed_by, claimed_at, completed_at, error, result, priority, wave, owned_files, file_patterns)
      VALUES (?, ?, 'pending', NULL, NULL, NULL, NULL, NULL, ?, ?, ?, ?)
    `);

    const insertMany = db.transaction(
      (taskList: Array<{ id: string; description: string; priority?: number; wave?: number; ownedFiles?: string[]; filePatterns?: string[] }>) => {
        for (const task of taskList) {
          stmt.run(
            task.id,
            task.description,
            task.priority ?? 0,
            task.wave ?? 1,
            task.ownedFiles ? JSON.stringify(task.ownedFiles) : null,
            task.filePatterns ? JSON.stringify(task.filePatterns) : null
          );
        }
      },
    );

    insertMany(tasks);
    return true;
  } catch (error) {
    console.error("Failed to add tasks:", error);
    return false;
  }
}

/**
 * Get all tasks
 */
export function getTasks(): SwarmTask[] {
  if (!db) return [];

  try {
    const stmt = db.prepare("SELECT * FROM tasks ORDER BY priority ASC, id ASC");
    const rows = stmt.all() as Array<{
      id: string;
      description: string;
      status: string;
      claimed_by: string | null;
      claimed_at: number | null;
      completed_at: number | null;
      error: string | null;
      result: string | null;
      priority: number | null;
      wave: number | null;
      owned_files: string | null;
      file_patterns: string | null;
    }>;

    return rows.map((row) => ({
      id: row.id,
      description: row.description,
      status: row.status as SwarmTask["status"],
      claimedBy: row.claimed_by,
      claimedAt: row.claimed_at,
      completedAt: row.completed_at,
      error: row.error ?? undefined,
      result: row.result ?? undefined,
      priority: row.priority ?? 0,
      wave: row.wave ?? 1,
      ownedFiles: row.owned_files ? JSON.parse(row.owned_files) : undefined,
      filePatterns: row.file_patterns ? JSON.parse(row.file_patterns) : undefined,
    }));
  } catch (error) {
    console.error("Failed to get tasks:", error);
    return [];
  }
}

/**
 * Get tasks by status
 */
export function getTasksByStatus(status: SwarmTask["status"]): SwarmTask[] {
  if (!db) return [];

  try {
    const stmt = db.prepare("SELECT * FROM tasks WHERE status = ? ORDER BY priority ASC, id ASC");
    const rows = stmt.all(status) as Array<{
      id: string;
      description: string;
      status: string;
      claimed_by: string | null;
      claimed_at: number | null;
      completed_at: number | null;
      error: string | null;
      result: string | null;
      priority: number | null;
      wave: number | null;
      owned_files: string | null;
      file_patterns: string | null;
    }>;

    return rows.map((row) => ({
      id: row.id,
      description: row.description,
      status: row.status as SwarmTask["status"],
      claimedBy: row.claimed_by,
      claimedAt: row.claimed_at,
      completedAt: row.completed_at,
      error: row.error ?? undefined,
      result: row.result ?? undefined,
      priority: row.priority ?? 0,
      wave: row.wave ?? 1,
      ownedFiles: row.owned_files ? JSON.parse(row.owned_files) : undefined,
      filePatterns: row.file_patterns ? JSON.parse(row.file_patterns) : undefined,
    }));
  } catch (error) {
    console.error("Failed to get tasks by status:", error);
    return [];
  }
}

/**
 * Get tasks by wave number
 */
export function getTasksByWave(wave: number): SwarmTask[] {
  if (!db) return [];

  try {
    const stmt = db.prepare("SELECT * FROM tasks WHERE wave = ? ORDER BY priority ASC, id ASC");
    const rows = stmt.all(wave) as Array<{
      id: string;
      description: string;
      status: string;
      claimed_by: string | null;
      claimed_at: number | null;
      completed_at: number | null;
      error: string | null;
      result: string | null;
      priority: number | null;
      wave: number | null;
      owned_files: string | null;
      file_patterns: string | null;
    }>;

    return rows.map((row) => ({
      id: row.id,
      description: row.description,
      status: row.status as SwarmTask["status"],
      claimedBy: row.claimed_by,
      claimedAt: row.claimed_at,
      completedAt: row.completed_at,
      error: row.error ?? undefined,
      result: row.result ?? undefined,
      priority: row.priority ?? 0,
      wave: row.wave ?? 1,
      ownedFiles: row.owned_files ? JSON.parse(row.owned_files) : undefined,
      filePatterns: row.file_patterns ? JSON.parse(row.file_patterns) : undefined,
    }));
  } catch (error) {
    console.error("Failed to get tasks by wave:", error);
    return [];
  }
}

/**
 * Get the next available task ID number
 * Uses MAX(id) from database to prevent ID collisions after deletions
 */
export function getNextTaskId(): number {
  if (!db) return 1;

  try {
    const stmt = db.prepare("SELECT MAX(CAST(SUBSTR(id, 6) AS INTEGER)) as maxId FROM tasks");
    const result = stmt.get() as { maxId: number | null };
    return (result?.maxId ?? 0) + 1;
  } catch (error) {
    console.error("Failed to get next task ID:", error);
    return 1;
  }
}

/**
 * Get a specific task by ID
 */
export function getTask(taskId: string): SwarmTask | null {
  if (!db) return null;

  try {
    const stmt = db.prepare("SELECT * FROM tasks WHERE id = ?");
    const row = stmt.get(taskId) as
      | {
          id: string;
          description: string;
          status: string;
          claimed_by: string | null;
          claimed_at: number | null;
          completed_at: number | null;
          error: string | null;
          result: string | null;
          priority: number | null;
          wave: number | null;
          owned_files: string | null;
          file_patterns: string | null;
        }
      | undefined;

    if (!row) return null;

    return {
      id: row.id,
      description: row.description,
      status: row.status as SwarmTask["status"],
      claimedBy: row.claimed_by,
      claimedAt: row.claimed_at,
      completedAt: row.completed_at,
      error: row.error ?? undefined,
      result: row.result ?? undefined,
      priority: row.priority ?? 0,
      wave: row.wave ?? 1,
      ownedFiles: row.owned_files ? JSON.parse(row.owned_files) : undefined,
      filePatterns: row.file_patterns ? JSON.parse(row.file_patterns) : undefined,
    };
  } catch (error) {
    console.error("Failed to get task:", error);
    return null;
  }
}

/**
 * Update a task's status and metadata
 */
export function updateTask(
  taskId: string,
  updates: Partial<Omit<SwarmTask, "id" | "description">>,
): boolean {
  if (!db) return false;

  try {
    const setClauses: string[] = [];
    const values: (string | number | null)[] = [];

    if (updates.status !== undefined) {
      setClauses.push("status = ?");
      values.push(updates.status);
    }
    if (updates.claimedBy !== undefined) {
      setClauses.push("claimed_by = ?");
      values.push(updates.claimedBy);
    }
    if (updates.claimedAt !== undefined) {
      setClauses.push("claimed_at = ?");
      values.push(updates.claimedAt);
    }
    if (updates.completedAt !== undefined) {
      setClauses.push("completed_at = ?");
      values.push(updates.completedAt);
    }
    if (updates.error !== undefined) {
      setClauses.push("error = ?");
      values.push(updates.error ?? null);
    }
    if (updates.result !== undefined) {
      setClauses.push("result = ?");
      values.push(updates.result ?? null);
    }

    if (setClauses.length === 0) return true;

    values.push(taskId);
    const stmt = db.prepare(
      `UPDATE tasks SET ${setClauses.join(", ")} WHERE id = ?`,
    );
    stmt.run(...values);
    return true;
  } catch (error) {
    console.error("Failed to update task:", error);
    return false;
  }
}

/**
 * Get swarm statistics
 */
export function getStats(): SwarmStats | null {
  if (!db) return null;

  try {
    // Get task counts by status
    const countStmt = db.prepare(`
      SELECT status, COUNT(*) as count FROM tasks GROUP BY status
    `);
    const counts = countStmt.all() as Array<{ status: string; count: number }>;

    const statusCounts: Record<string, number> = {
      pending: 0,
      claimed: 0,
      done: 0,
      failed: 0,
    };

    for (const row of counts) {
      statusCounts[row.status] = row.count;
    }

    // Get active agents count
    const agentStmt = db.prepare(`
      SELECT COUNT(*) as count FROM heartbeats
      WHERE last_heartbeat > ?
    `);
    const fiveMinutesAgo = Date.now() - 5 * 60 * 1000;
    const agentCount = (agentStmt.get(fiveMinutesAgo) as { count: number })
      .count;

    // Get session start time
    const sessionStmt = db.prepare(
      "SELECT started_at FROM swarm_session WHERE id = 1",
    );
    const session = sessionStmt.get() as { started_at: number } | undefined;
    const startedAt = session?.started_at ?? Date.now();

    return {
      totalTasks:
        statusCounts.pending +
        statusCounts.claimed +
        statusCounts.done +
        statusCounts.failed,
      pendingTasks: statusCounts.pending,
      claimedTasks: statusCounts.claimed,
      doneTasks: statusCounts.done,
      failedTasks: statusCounts.failed,
      activeAgents: agentCount,
      elapsedTime: Date.now() - startedAt,
    };
  } catch (error) {
    console.error("Failed to get stats:", error);
    return null;
  }
}

/**
 * Record an agent heartbeat
 */
export function recordHeartbeat(
  agentId: string,
  currentTaskId: string | null,
): boolean {
  if (!db) return false;

  try {
    const stmt = db.prepare(`
      INSERT OR REPLACE INTO heartbeats (agent_id, last_heartbeat, current_task_id)
      VALUES (?, ?, ?)
    `);
    stmt.run(agentId, Date.now(), currentTaskId);
    return true;
  } catch (error) {
    console.error("Failed to record heartbeat:", error);
    return false;
  }
}

/**
 * Get all agent heartbeats
 */
export function getHeartbeats(): AgentHeartbeat[] {
  if (!db) return [];

  try {
    const stmt = db.prepare("SELECT * FROM heartbeats ORDER BY agent_id");
    const rows = stmt.all() as Array<{
      agent_id: string;
      last_heartbeat: number;
      current_task_id: string | null;
    }>;

    return rows.map((row) => ({
      agentId: row.agent_id,
      lastHeartbeat: row.last_heartbeat,
      currentTaskId: row.current_task_id,
    }));
  } catch (error) {
    console.error("Failed to get heartbeats:", error);
    return [];
  }
}

/**
 * Remove an agent's heartbeat record
 */
export function removeHeartbeat(agentId: string): boolean {
  if (!db) return false;

  try {
    const stmt = db.prepare("DELETE FROM heartbeats WHERE agent_id = ?");
    stmt.run(agentId);
    return true;
  } catch (error) {
    console.error("Failed to remove heartbeat:", error);
    return false;
  }
}

/**
 * Clear all data (for reset)
 */
export function clearAllData(): boolean {
  if (!db) return false;

  try {
    db.exec(`
      DELETE FROM tasks;
      DELETE FROM heartbeats;
      DELETE FROM swarm_session;
    `);
    return true;
  } catch (error) {
    console.error("Failed to clear data:", error);
    return false;
  }
}

/**
 * Run a function within a transaction
 */
export function runTransaction<T>(fn: () => T): T | null {
  if (!db) return null;

  try {
    return db.transaction(fn)();
  } catch (error) {
    console.error("Transaction failed:", error);
    return null;
  }
}

/**
 * Get the raw database instance (for advanced use)
 */
export function getDb(): BetterSqlite3.Database | null {
  return db;
}

/**
 * Write swarm summary to .omc/state/swarm-summary.json
 * This provides a lightweight JSON sidecar for external monitoring
 */
export function writeSwarmSummary(cwd: string): boolean {
  if (!db) return false;

  try {
    const state = loadState();
    const stats = getStats();

    if (!state || !stats) return false;

    const summary: SwarmSummary = {
      session_id: state.sessionId,
      started_at: new Date(state.startedAt).toISOString(),
      updated_at: new Date().toISOString(),
      task_count: stats.totalTasks,
      tasks_pending: stats.pendingTasks,
      tasks_claimed: stats.claimedTasks,
      tasks_done: stats.doneTasks,
      active: state.active,
      project_path: cwd,
    };

    const summaryPath = join(cwd, ".omc", "state", "swarm-summary.json");
    atomicWriteJsonSync(summaryPath, summary);

    return true;
  } catch (error) {
    console.error("Failed to write swarm summary:", error);
    return false;
  }
}
