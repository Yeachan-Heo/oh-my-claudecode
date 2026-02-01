import Database from 'better-sqlite3';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { getDbPath } from '../config.js';
import type { ClawdCoderConfig } from '../types.js';

let db: Database.Database | null = null;

const MIGRATION_001_INITIAL = `
-- Sessions table
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  tmux_session TEXT NOT NULL,
  tmux_window INTEGER DEFAULT 0,
  claude_session_id TEXT,
  project_id TEXT REFERENCES projects(id),
  working_directory TEXT NOT NULL,
  status TEXT DEFAULT 'active',
  created_by TEXT REFERENCES users(id),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  last_active_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  total_cost_usd REAL DEFAULT 0.0,
  total_input_tokens INTEGER DEFAULT 0,
  total_output_tokens INTEGER DEFAULT 0,
  metadata TEXT
);

-- Users table
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  discord_id TEXT UNIQUE,
  telegram_id TEXT UNIQUE,
  username TEXT NOT NULL,
  role TEXT DEFAULT 'user',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  settings TEXT
);

-- Projects table
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  directory TEXT NOT NULL,
  git_repo TEXT,
  default_branch TEXT DEFAULT 'main',
  created_by TEXT REFERENCES users(id),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  settings TEXT
);

-- Permissions table
CREATE TABLE IF NOT EXISTS permissions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT REFERENCES users(id),
  project_id TEXT REFERENCES projects(id),
  level TEXT DEFAULT 'read',
  granted_by TEXT REFERENCES users(id),
  granted_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(user_id, project_id)
);

-- Cost log table
CREATE TABLE IF NOT EXISTS cost_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT REFERENCES sessions(id),
  user_id TEXT REFERENCES users(id),
  input_tokens INTEGER,
  output_tokens INTEGER,
  cost_usd REAL,
  timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status);
CREATE INDEX IF NOT EXISTS idx_sessions_created_by ON sessions(created_by);
CREATE INDEX IF NOT EXISTS idx_users_discord_id ON users(discord_id);
CREATE INDEX IF NOT EXISTS idx_users_telegram_id ON users(telegram_id);
CREATE INDEX IF NOT EXISTS idx_cost_log_session_id ON cost_log(session_id);
CREATE INDEX IF NOT EXISTS idx_cost_log_user_id ON cost_log(user_id);
`;

export function initDatabase(config: ClawdCoderConfig): Database.Database {
  if (db) return db;

  const dbPath = getDbPath(config);
  const dbDir = dirname(dbPath);

  // Ensure directory exists
  if (!existsSync(dbDir)) {
    mkdirSync(dbDir, { recursive: true });
  }

  db = new Database(dbPath);

  // Enable WAL mode for better concurrency
  db.pragma('journal_mode = WAL');

  // Run migrations
  runMigrations(db);

  return db;
}

function runMigrations(database: Database.Database): void {
  // Create migrations tracking table
  database.exec(`
    CREATE TABLE IF NOT EXISTS migrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      applied_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Get applied migrations
  const applied = database.prepare('SELECT name FROM migrations').all() as { name: string }[];
  const appliedNames = new Set(applied.map(m => m.name));

  // Apply initial migration if not already applied
  if (!appliedNames.has('001-initial')) {
    database.exec(MIGRATION_001_INITIAL);
    database.prepare('INSERT INTO migrations (name) VALUES (?)').run('001-initial');
  }
}

export function getDatabase(): Database.Database {
  if (!db) {
    throw new Error('Database not initialized. Call initDatabase first.');
  }
  return db;
}

export function closeDatabase(): void {
  if (db) {
    db.close();
    db = null;
  }
}

export { SessionRepository } from './repositories/sessions.js';
export { UserRepository } from './repositories/users.js';
export { ProjectRepository } from './repositories/projects.js';
export { PermissionRepository } from './repositories/permissions.js';
export { CostLogRepository } from './repositories/cost-log.js';
