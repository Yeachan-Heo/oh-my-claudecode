/**
 * Memory Sync — Types
 *
 * Syncs Claude Code project memories to a user-configured git vault
 * on SessionEnd for versioned backup and cross-machine portability.
 */

export interface MemorySyncConfig {
  /** Enable/disable memory sync (default: false) */
  enabled: boolean;

  /** Path to the vault git repository */
  vaultPath: string;

  /** Auto-push to remote after commit (default: false) */
  autoPush: boolean;

  /** Timeout in ms for the entire sync operation (default: 10000) */
  timeout: number;
}

export const DEFAULT_CONFIG: MemorySyncConfig = {
  enabled: false,
  vaultPath: '',
  autoPush: false,
  timeout: 10_000,
};

/** What to sync and what to skip */
export const SYNC_INCLUDE = {
  /** Claude project memory files */
  projectMemory: 'projects/*/memory/*.md',
  /** Global CLAUDE.md */
  globalClaudeMd: 'CLAUDE.md',
  /** Per-project CLAUDE.md */
  projectClaudeMd: 'projects/*/CLAUDE.md',
} as const;

export const SYNC_EXCLUDE = [
  'history.jsonl',
  'sessions/',
  'backups/',
  'plugins/',
  'settings.json',
  '*.auth.json',
  '.credentials',
] as const;

export interface SyncResult {
  synced: boolean;
  filesChanged: number;
  committed: boolean;
  pushed: boolean;
  error?: string;
}

export interface FileChange {
  source: string;
  target: string;
  project: string;
  type: 'memory' | 'claude-md' | 'plan';
}
