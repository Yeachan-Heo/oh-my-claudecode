// src/team/worker-restart.ts

/**
 * Worker auto-restart with exponential backoff.
 *
 * Tracks restart attempts per worker in sidecar JSON files.
 * Uses exponential backoff to prevent rapid restart loops.
 */

import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWriteJson, ensureDirWithMode, validateResolvedPath } from './fs-utils.js';
import type { BridgeConfig, McpWorkerMember } from './types.js';

export interface RestartPolicy {
  maxRestarts: number;        // default: 3
  backoffBaseMs: number;      // default: 5000
  backoffMaxMs: number;       // default: 60000
  backoffMultiplier: number;  // default: 2
}

export interface RestartState {
  workerName: string;
  restartCount: number;
  lastRestartAt: string;
  nextBackoffMs: number;
}

const DEFAULT_POLICY: RestartPolicy = {
  maxRestarts: 3,
  backoffBaseMs: 5000,
  backoffMaxMs: 60000,
  backoffMultiplier: 2,
};

function getRestartStatePath(workingDirectory: string, teamName: string, workerName: string): string {
  return join(workingDirectory, '.omc', 'state', 'team-bridge', teamName, `${workerName}.restart.json`);
}

/**
 * Read the current restart state for a worker.
 * Returns null if no restart state exists.
 */
export function readRestartState(
  workingDirectory: string,
  teamName: string,
  workerName: string
): RestartState | null {
  const statePath = getRestartStatePath(workingDirectory, teamName, workerName);
  if (!existsSync(statePath)) return null;
  try {
    return JSON.parse(readFileSync(statePath, 'utf-8'));
  } catch {
    return null;
  }
}

/**
 * Check if a dead worker should be restarted.
 * Uses exponential backoff: base * multiplier^count, capped at max.
 * Returns backoff delay in ms if restart allowed, null if exhausted.
 */
export function shouldRestart(
  workingDirectory: string,
  teamName: string,
  workerName: string,
  policy: RestartPolicy = DEFAULT_POLICY
): number | null {
  const state = readRestartState(workingDirectory, teamName, workerName);

  if (!state) {
    // First restart: return base backoff
    return policy.backoffBaseMs;
  }

  if (state.restartCount >= policy.maxRestarts) {
    return null; // Exhausted
  }

  // Calculate exponential backoff
  const backoff = Math.min(
    policy.backoffBaseMs * Math.pow(policy.backoffMultiplier, state.restartCount),
    policy.backoffMaxMs
  );

  return backoff;
}

/**
 * Record a restart attempt (updates sidecar state).
 */
export function recordRestart(
  workingDirectory: string,
  teamName: string,
  workerName: string,
  policy: RestartPolicy = DEFAULT_POLICY
): void {
  const statePath = getRestartStatePath(workingDirectory, teamName, workerName);
  validateResolvedPath(statePath, workingDirectory);

  const dir = join(workingDirectory, '.omc', 'state', 'team-bridge', teamName);
  ensureDirWithMode(dir);

  const existing = readRestartState(workingDirectory, teamName, workerName);

  const newState: RestartState = {
    workerName,
    restartCount: (existing?.restartCount ?? 0) + 1,
    lastRestartAt: new Date().toISOString(),
    nextBackoffMs: Math.min(
      policy.backoffBaseMs * Math.pow(policy.backoffMultiplier, (existing?.restartCount ?? 0) + 1),
      policy.backoffMaxMs
    ),
  };

  atomicWriteJson(statePath, newState);
}

/**
 * Clear restart state for a worker (e.g., after successful recovery).
 */
export function clearRestartState(
  workingDirectory: string,
  teamName: string,
  workerName: string
): void {
  const statePath = getRestartStatePath(workingDirectory, teamName, workerName);
  try {
    if (existsSync(statePath)) {
      unlinkSync(statePath);
    }
  } catch { /* ignore */ }
}

/**
 * Synthesize a BridgeConfig from an McpWorkerMember record + sensible defaults.
 * Used at restart time. Does NOT persist BridgeConfig to disk.
 */
export function synthesizeBridgeConfig(
  worker: McpWorkerMember,
  teamName: string
): BridgeConfig {
  return {
    workerName: worker.name,
    teamName,
    workingDirectory: worker.cwd,
    provider: worker.agentType.replace('mcp-', '') as 'codex' | 'gemini',
    model: worker.model,
    pollIntervalMs: 3000,
    taskTimeoutMs: 600000,
    maxConsecutiveErrors: 3,
    outboxMaxLines: 500,
    maxRetries: 5,
  };
}
