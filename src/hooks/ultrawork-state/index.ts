/**
 * Ultrawork State Management
 *
 * Manages persistent ultrawork mode state across sessions.
 * When ultrawork is activated and todos remain incomplete,
 * this module ensures the mode persists until all work is done.
 *
 * IMPORTANT: State files are now session-isolated to prevent
 * cross-session contamination when running multiple Claude Code instances.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync, readdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

export interface UltraworkState {
  /** Whether ultrawork mode is currently active */
  active: boolean;
  /** When ultrawork was activated */
  started_at: string;
  /** The original prompt that triggered ultrawork */
  original_prompt: string;
  /** Session ID the mode is bound to */
  session_id?: string;
  /** Number of times the mode has been reinforced (for metrics) */
  reinforcement_count: number;
  /** Last time the mode was checked/reinforced */
  last_checked_at: string;
  /** Whether this ultrawork session is linked to a ralph-loop session */
  linked_to_ralph?: boolean;
}

const _DEFAULT_STATE: UltraworkState = {
  active: false,
  started_at: '',
  original_prompt: '',
  reinforcement_count: 0,
  last_checked_at: ''
};

/**
 * Get the state file path for Ultrawork
 * Now includes session ID for isolation between concurrent sessions
 */
function getStateFilePath(directory?: string, sessionId?: string): string {
  const baseDir = directory || process.cwd();
  const omcDir = join(baseDir, '.omc');

  // Session-isolated file name
  if (sessionId) {
    return join(omcDir, `ultrawork-state-${sessionId}.json`);
  }

  // Legacy path for backward compatibility (will be migrated)
  return join(omcDir, 'ultrawork-state.json');
}

/**
 * Get global state file path (for cross-session persistence)
 * Now includes session ID for isolation
 */
function getGlobalStateFilePath(sessionId?: string): string {
  const claudeDir = join(homedir(), '.claude');

  // Session-isolated file name
  if (sessionId) {
    return join(claudeDir, `ultrawork-state-${sessionId}.json`);
  }

  // Legacy path for backward compatibility
  return join(claudeDir, 'ultrawork-state.json');
}

/**
 * Ensure the .omc directory exists
 */
function ensureStateDir(directory?: string): void {
  const baseDir = directory || process.cwd();
  const omcDir = join(baseDir, '.omc');
  if (!existsSync(omcDir)) {
    mkdirSync(omcDir, { recursive: true });
  }
}

/**
 * Ensure the ~/.claude directory exists
 */
function ensureGlobalStateDir(): void {
  const claudeDir = join(homedir(), '.claude');
  if (!existsSync(claudeDir)) {
    mkdirSync(claudeDir, { recursive: true });
  }
}

/**
 * Clean up stale session state files older than 24 hours
 */
function cleanupStaleStateFiles(directory?: string): void {
  const baseDir = directory || process.cwd();
  const omcDir = join(baseDir, '.omc');
  const claudeDir = join(homedir(), '.claude');
  const staleThreshold = 24 * 60 * 60 * 1000; // 24 hours

  const cleanupDir = (dir: string) => {
    if (!existsSync(dir)) return;

    try {
      const files = readdirSync(dir);
      for (const file of files) {
        if (file.startsWith('ultrawork-state-') && file.endsWith('.json')) {
          const filePath = join(dir, file);
          try {
            const content = readFileSync(filePath, 'utf-8');
            const state = JSON.parse(content) as UltraworkState;

            // Check if state is stale (inactive or old)
            if (!state.active) {
              unlinkSync(filePath);
            } else if (state.last_checked_at) {
              const lastChecked = new Date(state.last_checked_at).getTime();
              if (Date.now() - lastChecked > staleThreshold) {
                unlinkSync(filePath);
              }
            }
          } catch {
            // If we can't read it, it's probably corrupt - remove it
            try { unlinkSync(filePath); } catch { /* ignore */ }
          }
        }
      }
    } catch {
      // Directory read failed, ignore
    }
  };

  cleanupDir(omcDir);
  cleanupDir(claudeDir);
}

/**
 * Read Ultrawork state from disk (checks both local and global)
 * Now session-aware to prevent cross-session contamination
 */
export function readUltraworkState(directory?: string, sessionId?: string): UltraworkState | null {
  // Periodically cleanup stale files (1 in 10 chance)
  if (Math.random() < 0.1) {
    cleanupStaleStateFiles(directory);
  }

  // If session ID provided, try session-specific file first
  if (sessionId) {
    // Check local session-specific state
    const localSessionFile = getStateFilePath(directory, sessionId);
    if (existsSync(localSessionFile)) {
      try {
        const content = readFileSync(localSessionFile, 'utf-8');
        return JSON.parse(content);
      } catch {
        // Fall through
      }
    }

    // Check global session-specific state
    const globalSessionFile = getGlobalStateFilePath(sessionId);
    if (existsSync(globalSessionFile)) {
      try {
        const content = readFileSync(globalSessionFile, 'utf-8');
        return JSON.parse(content);
      } catch {
        // Fall through
      }
    }
  }

  // Check legacy local state (for migration)
  const localStateFile = getStateFilePath(directory);
  if (existsSync(localStateFile)) {
    try {
      const content = readFileSync(localStateFile, 'utf-8');
      const state = JSON.parse(content) as UltraworkState;

      // Only return legacy state if it matches the session or has no session
      if (!state.session_id || !sessionId || state.session_id === sessionId) {
        return state;
      }
      // Different session - don't return this state
      return null;
    } catch {
      // Fall through to global check
    }
  }

  // Check legacy global state (for migration)
  const globalStateFile = getGlobalStateFilePath();
  if (existsSync(globalStateFile)) {
    try {
      const content = readFileSync(globalStateFile, 'utf-8');
      const state = JSON.parse(content) as UltraworkState;

      // Only return legacy state if it matches the session or has no session
      if (!state.session_id || !sessionId || state.session_id === sessionId) {
        return state;
      }
      return null;
    } catch {
      return null;
    }
  }

  return null;
}

/**
 * Write Ultrawork state to disk (both local and global for redundancy)
 * Now writes to session-specific files to prevent cross-session contamination
 */
export function writeUltraworkState(state: UltraworkState, directory?: string): boolean {
  const sessionId = state.session_id;

  try {
    // Write to local .omc with session-specific filename
    ensureStateDir(directory);
    const localStateFile = getStateFilePath(directory, sessionId);
    writeFileSync(localStateFile, JSON.stringify(state, null, 2));

    // Write to global ~/.claude for cross-session persistence (also session-specific)
    ensureGlobalStateDir();
    const globalStateFile = getGlobalStateFilePath(sessionId);
    writeFileSync(globalStateFile, JSON.stringify(state, null, 2));

    // If this is the first write with a session ID, try to migrate legacy file
    if (sessionId) {
      migrateLegacyStateFile(directory, sessionId);
    }

    return true;
  } catch {
    return false;
  }
}

/**
 * Migrate legacy state file to session-specific format
 * Only migrates if the legacy file belongs to the current session
 */
function migrateLegacyStateFile(directory?: string, sessionId?: string): void {
  if (!sessionId) return;

  const legacyLocal = getStateFilePath(directory);
  const legacyGlobal = getGlobalStateFilePath();

  // Check and remove legacy local file if it belongs to this session
  if (existsSync(legacyLocal)) {
    try {
      const content = readFileSync(legacyLocal, 'utf-8');
      const state = JSON.parse(content) as UltraworkState;
      if (state.session_id === sessionId) {
        unlinkSync(legacyLocal);
      }
    } catch {
      // Ignore migration errors
    }
  }

  // Check and remove legacy global file if it belongs to this session
  if (existsSync(legacyGlobal)) {
    try {
      const content = readFileSync(legacyGlobal, 'utf-8');
      const state = JSON.parse(content) as UltraworkState;
      if (state.session_id === sessionId) {
        unlinkSync(legacyGlobal);
      }
    } catch {
      // Ignore migration errors
    }
  }
}

/**
 * Activate ultrawork mode
 */
export function activateUltrawork(
  prompt: string,
  sessionId?: string,
  directory?: string,
  linkedToRalph?: boolean
): boolean {
  const state: UltraworkState = {
    active: true,
    started_at: new Date().toISOString(),
    original_prompt: prompt,
    session_id: sessionId,
    reinforcement_count: 0,
    last_checked_at: new Date().toISOString(),
    linked_to_ralph: linkedToRalph
  };

  return writeUltraworkState(state, directory);
}

/**
 * Deactivate ultrawork mode
 * Now removes session-specific files
 */
export function deactivateUltrawork(directory?: string, sessionId?: string): boolean {
  let success = true;

  // Remove session-specific local state
  if (sessionId) {
    const sessionLocalFile = getStateFilePath(directory, sessionId);
    if (existsSync(sessionLocalFile)) {
      try {
        unlinkSync(sessionLocalFile);
      } catch {
        success = false;
      }
    }

    // Remove session-specific global state
    const sessionGlobalFile = getGlobalStateFilePath(sessionId);
    if (existsSync(sessionGlobalFile)) {
      try {
        unlinkSync(sessionGlobalFile);
      } catch {
        success = false;
      }
    }
  }

  // Also try to remove legacy files if they match the session
  const localStateFile = getStateFilePath(directory);
  if (existsSync(localStateFile)) {
    try {
      if (sessionId) {
        const content = readFileSync(localStateFile, 'utf-8');
        const state = JSON.parse(content) as UltraworkState;
        if (state.session_id === sessionId || !state.session_id) {
          unlinkSync(localStateFile);
        }
      } else {
        unlinkSync(localStateFile);
      }
    } catch {
      // Continue to global cleanup
    }
  }

  // Remove legacy global state
  const globalStateFile = getGlobalStateFilePath();
  if (existsSync(globalStateFile)) {
    try {
      if (sessionId) {
        const content = readFileSync(globalStateFile, 'utf-8');
        const state = JSON.parse(content) as UltraworkState;
        if (state.session_id === sessionId || !state.session_id) {
          unlinkSync(globalStateFile);
        }
      } else {
        unlinkSync(globalStateFile);
      }
    } catch {
      success = false;
    }
  }

  return success;
}

/**
 * Increment reinforcement count (called when mode is reinforced on stop)
 */
export function incrementReinforcement(directory?: string, sessionId?: string): UltraworkState | null {
  const state = readUltraworkState(directory, sessionId);

  if (!state || !state.active) {
    return null;
  }

  state.reinforcement_count += 1;
  state.last_checked_at = new Date().toISOString();

  if (writeUltraworkState(state, directory)) {
    return state;
  }

  return null;
}

/**
 * Check if ultrawork should be reinforced (active with pending todos)
 * Now properly session-aware
 */
export function shouldReinforceUltrawork(
  sessionId?: string,
  directory?: string
): boolean {
  // Pass sessionId to readUltraworkState for proper isolation
  const state = readUltraworkState(directory, sessionId);

  if (!state || !state.active) {
    return false;
  }

  // If bound to a session, only reinforce for that session
  if (state.session_id && sessionId && state.session_id !== sessionId) {
    return false;
  }

  return true;
}

/**
 * Get ultrawork persistence message for injection
 */
export function getUltraworkPersistenceMessage(state: UltraworkState): string {
  return `<ultrawork-persistence>

[ULTRAWORK MODE STILL ACTIVE - Reinforcement #${state.reinforcement_count + 1}]

Your ultrawork session is NOT complete. Incomplete todos remain.

REMEMBER THE ULTRAWORK RULES:
- **PARALLEL**: Fire independent calls simultaneously - NEVER wait sequentially
- **BACKGROUND FIRST**: Use Task(run_in_background=true) for exploration (10+ concurrent)
- **TODO**: Track EVERY step. Mark complete IMMEDIATELY after each
- **VERIFY**: Check ALL requirements met before done
- **NO Premature Stopping**: ALL TODOs must be complete

Continue working on the next pending task. DO NOT STOP until all tasks are marked complete.

Original task: ${state.original_prompt}

</ultrawork-persistence>

---

`;
}

/**
 * Create an Ultrawork State hook instance
 * Now includes sessionId in all operations
 */
export function createUltraworkStateHook(directory: string, sessionId?: string) {
  return {
    activate: (prompt: string, sid?: string) =>
      activateUltrawork(prompt, sid || sessionId, directory),
    deactivate: (sid?: string) => deactivateUltrawork(directory, sid || sessionId),
    getState: (sid?: string) => readUltraworkState(directory, sid || sessionId),
    shouldReinforce: (sid?: string) =>
      shouldReinforceUltrawork(sid || sessionId, directory),
    incrementReinforcement: (sid?: string) => incrementReinforcement(directory, sid || sessionId)
  };
}
