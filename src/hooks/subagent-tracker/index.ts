/**
 * Subagent Tracker Hook Module
 *
 * Tracks SubagentStart and SubagentStop events for comprehensive agent monitoring.
 * Features:
 * - Track all spawned agents with parent mode context
 * - Detect stuck/stale agents (>5 min without progress)
 * - HUD integration for agent status display
 * - Automatic cleanup of orphaned agent state
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } from 'fs';
import { join } from 'path';

// ============================================================================
// Types
// ============================================================================

export interface SubagentInfo {
  agent_id: string;
  agent_type: string;
  started_at: string;
  parent_mode: string; // 'autopilot' | 'ultrapilot' | 'ultrawork' | 'swarm' | 'none'
  task_description?: string;
  file_ownership?: string[];
  status: 'running' | 'completed' | 'failed';
  completed_at?: string;
  duration_ms?: number;
  output_summary?: string;
}

export interface SubagentTrackingState {
  agents: SubagentInfo[];
  total_spawned: number;
  total_completed: number;
  total_failed: number;
  last_updated: string;
}

export interface SubagentStartInput {
  session_id: string;
  transcript_path: string;
  cwd: string;
  permission_mode: string;
  hook_event_name: 'SubagentStart';
  agent_id: string;
  agent_type: string;
  prompt?: string;
  model?: string;
}

export interface SubagentStopInput {
  session_id: string;
  transcript_path: string;
  cwd: string;
  permission_mode: string;
  hook_event_name: 'SubagentStop';
  agent_id: string;
  agent_type: string;
  output?: string;
  success: boolean;
}

export interface HookOutput {
  continue: boolean;
  hookSpecificOutput?: {
    hookEventName: string;
    additionalContext?: string;
    agent_count?: number;
    stale_agents?: string[];
  };
}

// ============================================================================
// Constants
// ============================================================================

const STATE_FILE = 'subagent-tracking.json';
const STALE_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes
const MAX_COMPLETED_AGENTS = 100;
const LOCK_TIMEOUT_MS = 5000; // 5 second lock timeout
const LOCK_RETRY_MS = 50; // Retry every 50ms

/**
 * Check if a process is still alive
 * Signal 0 doesn't kill the process, just checks if it exists
 */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Synchronous sleep using Atomics.wait
 * Avoids CPU-spinning busy-wait loops
 */
function syncSleep(ms: number): void {
  const buffer = new SharedArrayBuffer(4);
  const view = new Int32Array(buffer);
  Atomics.wait(view, 0, 0, ms);
}

// ============================================================================
// State Management
// ============================================================================

/**
 * Acquire file lock with timeout and stale lock detection
 */
function acquireLock(directory: string): boolean {
  const lockPath = join(directory, '.omc', 'state', 'subagent-tracker.lock');
  const lockDir = join(directory, '.omc', 'state');

  if (!existsSync(lockDir)) {
    mkdirSync(lockDir, { recursive: true });
  }

  const startTime = Date.now();

  while (Date.now() - startTime < LOCK_TIMEOUT_MS) {
    try {
      // Check for stale lock (older than timeout or dead process)
      if (existsSync(lockPath)) {
        const lockContent = readFileSync(lockPath, 'utf-8');
        const [lockPidStr, lockTimeStr] = lockContent.split(':');
        const lockPid = parseInt(lockPidStr, 10);
        const lockTime = parseInt(lockTimeStr, 10);
        const isStale = Date.now() - lockTime > LOCK_TIMEOUT_MS;
        const isDeadProcess = !isNaN(lockPid) && !isProcessAlive(lockPid);

        if (isStale || isDeadProcess) {
          // Stale lock or dead process, remove it
          try { unlinkSync(lockPath); } catch { /* ignore stale lock removal errors */ }
        } else {
          // Lock is held by a live process, wait and retry
          syncSleep(LOCK_RETRY_MS);
          continue;
        }
      }

      // Try to create lock atomically with PID:timestamp
      writeFileSync(lockPath, `${process.pid}:${Date.now()}`, { flag: 'wx' });
      return true;
    } catch (e: any) {
      if (e.code === 'EEXIST') {
        // Lock exists, retry
        syncSleep(LOCK_RETRY_MS);
        continue;
      }
      return false;
    }
  }

  return false; // Timeout
}

/**
 * Release file lock
 */
function releaseLock(directory: string): void {
  const lockPath = join(directory, '.omc', 'state', 'subagent-tracker.lock');
  try {
    unlinkSync(lockPath);
  } catch {
    // Ignore errors
  }
}

/**
 * Get the state file path
 */
export function getStateFilePath(directory: string): string {
  const stateDir = join(directory, '.omc', 'state');
  if (!existsSync(stateDir)) {
    mkdirSync(stateDir, { recursive: true });
  }
  return join(stateDir, STATE_FILE);
}

/**
 * Read tracking state from file
 */
export function readTrackingState(directory: string): SubagentTrackingState {
  const statePath = getStateFilePath(directory);

  if (!existsSync(statePath)) {
    return {
      agents: [],
      total_spawned: 0,
      total_completed: 0,
      total_failed: 0,
      last_updated: new Date().toISOString(),
    };
  }

  try {
    const content = readFileSync(statePath, 'utf-8');
    return JSON.parse(content);
  } catch (error) {
    console.error('[SubagentTracker] Error reading state:', error);
    return {
      agents: [],
      total_spawned: 0,
      total_completed: 0,
      total_failed: 0,
      last_updated: new Date().toISOString(),
    };
  }
}

/**
 * Write tracking state to file
 */
export function writeTrackingState(directory: string, state: SubagentTrackingState): void {
  const statePath = getStateFilePath(directory);
  state.last_updated = new Date().toISOString();

  try {
    writeFileSync(statePath, JSON.stringify(state, null, 2), 'utf-8');
  } catch (error) {
    console.error('[SubagentTracker] Error writing state:', error);
  }
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Detect the current parent mode from state files
 */
function detectParentMode(directory: string): string {
  const stateDir = join(directory, '.omc', 'state');

  if (!existsSync(stateDir)) {
    return 'none';
  }

  // Check in order of specificity
  const modeFiles = [
    { file: 'ultrapilot-state.json', mode: 'ultrapilot' },
    { file: 'autopilot-state.json', mode: 'autopilot' },
    { file: 'swarm-state.json', mode: 'swarm' },
    { file: 'ultrawork-state.json', mode: 'ultrawork' },
    { file: 'ralph-state.json', mode: 'ralph' },
  ];

  for (const { file, mode } of modeFiles) {
    const filePath = join(stateDir, file);
    if (existsSync(filePath)) {
      try {
        const content = readFileSync(filePath, 'utf-8');
        const state = JSON.parse(content);
        if (state.active === true || state.status === 'running' || state.status === 'active') {
          return mode;
        }
      } catch {
        continue;
      }
    }
  }

  return 'none';
}

/**
 * Get list of stale agents (running for too long)
 */
export function getStaleAgents(state: SubagentTrackingState): SubagentInfo[] {
  const now = Date.now();

  return state.agents.filter((agent) => {
    if (agent.status !== 'running') {
      return false;
    }

    const startTime = new Date(agent.started_at).getTime();
    const elapsed = now - startTime;

    return elapsed > STALE_THRESHOLD_MS;
  });
}

// ============================================================================
// Hook Processors
// ============================================================================

/**
 * Process SubagentStart event
 */
export function processSubagentStart(input: SubagentStartInput): HookOutput {
  if (!acquireLock(input.cwd)) {
    return { continue: true }; // Fail gracefully
  }

  try {
    const state = readTrackingState(input.cwd);
    const parentMode = detectParentMode(input.cwd);

    // Create new agent entry
    const agentInfo: SubagentInfo = {
      agent_id: input.agent_id,
      agent_type: input.agent_type,
      started_at: new Date().toISOString(),
      parent_mode: parentMode,
      task_description: input.prompt?.substring(0, 200), // Truncate for storage
      status: 'running',
    };

    // Add to state
    state.agents.push(agentInfo);
    state.total_spawned++;

    // Write updated state
    writeTrackingState(input.cwd, state);

    // Check for stale agents
    const staleAgents = getStaleAgents(state);

    return {
      continue: true,
      hookSpecificOutput: {
        hookEventName: 'SubagentStart',
        additionalContext: `Agent ${input.agent_type} started (${input.agent_id})`,
        agent_count: state.agents.filter((a) => a.status === 'running').length,
        stale_agents: staleAgents.map((a) => a.agent_id),
      },
    };
  } finally {
    releaseLock(input.cwd);
  }
}

/**
 * Process SubagentStop event
 */
export function processSubagentStop(input: SubagentStopInput): HookOutput {
  if (!acquireLock(input.cwd)) {
    return { continue: true }; // Fail gracefully
  }

  try {
    const state = readTrackingState(input.cwd);

    // Find the agent
    const agentIndex = state.agents.findIndex((a) => a.agent_id === input.agent_id);

    if (agentIndex !== -1) {
      const agent = state.agents[agentIndex];

      // Update agent status
      agent.status = input.success ? 'completed' : 'failed';
      agent.completed_at = new Date().toISOString();

      // Calculate duration
      const startTime = new Date(agent.started_at).getTime();
      const endTime = new Date(agent.completed_at).getTime();
      agent.duration_ms = endTime - startTime;

      // Store output summary (truncated)
      if (input.output) {
        agent.output_summary = input.output.substring(0, 500);
      }

      // Update counters
      if (input.success) {
        state.total_completed++;
      } else {
        state.total_failed++;
      }
    }

    // Evict oldest completed agents if over limit
    const completedAgents = state.agents.filter(a => a.status === 'completed' || a.status === 'failed');
    if (completedAgents.length > MAX_COMPLETED_AGENTS) {
      // Sort by completed_at and keep only the most recent
      completedAgents.sort((a, b) => {
        const timeA = a.completed_at ? new Date(a.completed_at).getTime() : 0;
        const timeB = b.completed_at ? new Date(b.completed_at).getTime() : 0;
        return timeB - timeA; // Newest first
      });

      const toRemove = new Set(completedAgents.slice(MAX_COMPLETED_AGENTS).map(a => a.agent_id));
      state.agents = state.agents.filter(a => !toRemove.has(a.agent_id));
    }

    // Write updated state
    writeTrackingState(input.cwd, state);

    const runningCount = state.agents.filter((a) => a.status === 'running').length;

    return {
      continue: true,
      hookSpecificOutput: {
        hookEventName: 'SubagentStop',
        additionalContext: `Agent ${input.agent_type} ${input.success ? 'completed' : 'failed'} (${input.agent_id})`,
        agent_count: runningCount,
      },
    };
  } finally {
    releaseLock(input.cwd);
  }
}

// ============================================================================
// Cleanup Functions
// ============================================================================

/**
 * Cleanup stale agents (mark as failed)
 */
export function cleanupStaleAgents(directory: string): number {
  if (!acquireLock(directory)) {
    return 0; // Could not acquire lock
  }

  try {
    const state = readTrackingState(directory);
    const staleAgents = getStaleAgents(state);

    if (staleAgents.length === 0) {
      return 0;
    }

    for (const stale of staleAgents) {
      const agentIndex = state.agents.findIndex((a) => a.agent_id === stale.agent_id);
      if (agentIndex !== -1) {
        state.agents[agentIndex].status = 'failed';
        state.agents[agentIndex].completed_at = new Date().toISOString();
        state.agents[agentIndex].output_summary = 'Marked as stale - exceeded timeout';
        state.total_failed++;
      }
    }

    writeTrackingState(directory, state);

    return staleAgents.length;
  } finally {
    releaseLock(directory);
  }
}

// ============================================================================
// Query Functions
// ============================================================================

/**
 * Get count of active (running) agents
 */
export function getActiveAgentCount(directory: string): number {
  const state = readTrackingState(directory);
  return state.agents.filter((a) => a.status === 'running').length;
}

/**
 * Get agents by type
 */
export function getAgentsByType(directory: string, agentType: string): SubagentInfo[] {
  const state = readTrackingState(directory);
  return state.agents.filter((a) => a.agent_type === agentType);
}

/**
 * Get all running agents
 */
export function getRunningAgents(directory: string): SubagentInfo[] {
  const state = readTrackingState(directory);
  return state.agents.filter((a) => a.status === 'running');
}

/**
 * Get tracking stats
 */
export function getTrackingStats(directory: string): {
  running: number;
  completed: number;
  failed: number;
  total: number;
} {
  const state = readTrackingState(directory);
  return {
    running: state.agents.filter((a) => a.status === 'running').length,
    completed: state.total_completed,
    failed: state.total_failed,
    total: state.total_spawned,
  };
}

// ============================================================================
// Main Entry Points
// ============================================================================

/**
 * Handle SubagentStart hook
 */
export async function handleSubagentStart(input: SubagentStartInput): Promise<HookOutput> {
  return processSubagentStart(input);
}

/**
 * Handle SubagentStop hook
 */
export async function handleSubagentStop(input: SubagentStopInput): Promise<HookOutput> {
  return processSubagentStop(input);
}

/**
 * Clear all tracking state (for testing or cleanup)
 */
export function clearTrackingState(directory: string): void {
  const statePath = getStateFilePath(directory);
  if (existsSync(statePath)) {
    try {
      unlinkSync(statePath);
    } catch (error) {
      console.error('[SubagentTracker] Error clearing state:', error);
    }
  }
}
