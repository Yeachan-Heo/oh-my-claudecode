/**
 * Ultrapilot Types
 *
 * Type definitions for the ultrapilot coordinator - manages parallel worker spawning
 * and coordination with file ownership to avoid conflicts.
 *
 * Ultrapilot decomposes tasks into parallelizable subtasks, spawns workers (max 20),
 * tracks progress, and integrates results while managing shared file access.
 */

/**
 * Configuration options for ultrapilot behavior
 */
export interface UltrapilotConfig {
  /** Maximum number of parallel workers */
  maxWorkers?: number;
  /** Maximum iterations before giving up */
  maxIterations?: number;
  /** Timeout per worker in milliseconds */
  workerTimeout?: number;
  /** Model to use for workers (haiku/sonnet/opus) */
  workerModel?: string;
  /** List of shared files that only coordinator can modify */
  sharedFiles?: string[];
  /** Whether to enable verbose logging */
  verbose?: boolean;
}

/**
 * State of an individual worker
 */
export interface WorkerState {
  /** Unique worker ID */
  id: string;
  /** Worker index (0-4) */
  index: number;
  /** Task assigned to this worker */
  task: string;
  /** Files this worker owns (can modify) */
  ownedFiles: string[];
  /** Current status */
  status: 'pending' | 'running' | 'complete' | 'failed';
  /** Task agent ID (from Task tool) */
  taskId?: string;
  /** Start timestamp */
  startedAt?: string;
  /** Completion timestamp */
  completedAt?: string;
  /** Error message if failed */
  error?: string;
  /** Files created by this worker */
  filesCreated: string[];
  /** Files modified by this worker */
  filesModified: string[];
}

/**
 * File ownership mapping to prevent conflicts
 */
export interface FileOwnership {
  /** Files owned by the coordinator (shared files) */
  coordinator: string[];
  /** Files owned by each worker (keyed by worker ID) */
  workers: Record<string, string[]>;
  /** Files that have conflicts (multiple workers attempted to modify) */
  conflicts: string[];
}

/**
 * Complete ultrapilot state
 */
export interface UltrapilotState {
  /** Whether ultrapilot is currently active */
  active: boolean;
  /** Current iteration number */
  iteration: number;
  /** Maximum iterations before giving up */
  maxIterations: number;
  /** Original task provided by user */
  originalTask: string;
  /** Decomposed subtasks */
  subtasks: string[];
  /** State for each worker */
  workers: WorkerState[];
  /** File ownership mapping */
  ownership: FileOwnership;
  /** Metrics and timestamps */
  startedAt: string;
  completedAt: string | null;
  totalWorkersSpawned: number;
  successfulWorkers: number;
  failedWorkers: number;
  /** Session binding */
  sessionId?: string;
  /** Project path for isolation */
  project_path?: string;
}

/**
 * Result from integrating worker outputs
 */
export interface IntegrationResult {
  /** Whether integration was successful */
  success: boolean;
  /** All files created across workers */
  filesCreated: string[];
  /** All files modified across workers */
  filesModified: string[];
  /** List of conflicts that need manual resolution */
  conflicts: string[];
  /** List of errors encountered */
  errors: string[];
  /** Summary of work completed */
  summary: string;
}

/**
 * Default configuration for ultrapilot
 */
export const DEFAULT_CONFIG: Required<UltrapilotConfig> = {
  maxWorkers: 20,
  maxIterations: 3,
  workerTimeout: 300000, // 5 minutes
  workerModel: 'sonnet',
  sharedFiles: [
    'package.json',
    'package-lock.json',
    'tsconfig.json',
    'jest.config.js',
    '.gitignore',
    'README.md',
    'Makefile',
    'go.mod',
    'go.sum',
    'Cargo.toml',
    'Cargo.lock',
    'pyproject.toml',
    'requirements.txt',
    'setup.py'
  ],
  verbose: false
};
