/**
 * Mode Registry Types
 *
 * Defines the supported execution modes and their state file locations.
 */

export type ExecutionMode =
  | 'autopilot'
  | 'ultrapilot'
  | 'swarm'
  | 'pipeline'
  | 'team'
  | 'ralph'
  | 'ultrawork'
  | 'ultraqa'
  | 'ecomode';

export interface ModeConfig {
  /** Display name for the mode */
  name: string;
  /** Primary state file path (relative to .omc/state/) */
  stateFile: string;
  /** Alternative/marker file path (relative to .omc/state/) */
  markerFile?: string;
  /** Property to check in JSON state (if JSON-based) */
  activeProperty?: string;
  /** Whether state is SQLite-based (requires marker file) */
  isSqlite?: boolean;
  /** Whether mode has global state in ~/.claude/ */
  hasGlobalState?: boolean;
}

export interface ModeStatus {
  mode: ExecutionMode;
  active: boolean;
  stateFilePath: string;
}

export interface CanStartResult {
  allowed: boolean;
  blockedBy?: ExecutionMode;
  message?: string;
}
