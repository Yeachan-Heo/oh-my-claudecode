// src/team/heartbeat.ts

/**
 * Heartbeat Management for MCP Team Bridge Workers
 *
 * Each worker writes a heartbeat file every poll cycle.
 * The lead checks freshness to detect dead workers.
 * Files stored at: .omc/state/team-bridge/{team}/{worker}.heartbeat.json
 */

import { readFileSync, existsSync, readdirSync, unlinkSync, rmdirSync } from 'fs';
import { join } from 'path';
import type { HeartbeatData } from './types.js';
import { sanitizeName } from './tmux-session.js';
import { atomicWriteJson } from './fs-utils.js';

/** Heartbeat file path */
function heartbeatPath(workingDirectory: string, teamName: string, workerName: string): string {
  return join(workingDirectory, '.omc', 'state', 'team-bridge', sanitizeName(teamName), `${sanitizeName(workerName)}.heartbeat.json`);
}

/** Heartbeat directory for a team */
function heartbeatDir(workingDirectory: string, teamName: string): string {
  return join(workingDirectory, '.omc', 'state', 'team-bridge', sanitizeName(teamName));
}

/** Write/update heartbeat. Called every poll cycle by the bridge. */
export function writeHeartbeat(
  workingDirectory: string,
  data: HeartbeatData
): void {
  const filePath = heartbeatPath(workingDirectory, data.teamName, data.workerName);
  atomicWriteJson(filePath, data);
}

/** Read heartbeat for a specific worker. Returns null if not found. */
export function readHeartbeat(
  workingDirectory: string,
  teamName: string,
  workerName: string
): HeartbeatData | null {
  const filePath = heartbeatPath(workingDirectory, teamName, workerName);
  if (!existsSync(filePath)) return null;
  try {
    const raw = readFileSync(filePath, 'utf-8');
    return JSON.parse(raw) as HeartbeatData;
  } catch {
    return null;
  }
}

/** List all heartbeat files for a team. Used by lead to check worker health. */
export function listHeartbeats(
  workingDirectory: string,
  teamName: string
): HeartbeatData[] {
  const dir = heartbeatDir(workingDirectory, teamName);
  if (!existsSync(dir)) return [];

  try {
    const files = readdirSync(dir).filter(f => f.endsWith('.heartbeat.json'));
    const heartbeats: HeartbeatData[] = [];
    for (const file of files) {
      try {
        const raw = readFileSync(join(dir, file), 'utf-8');
        heartbeats.push(JSON.parse(raw) as HeartbeatData);
      } catch { /* skip malformed */ }
    }
    return heartbeats;
  } catch {
    return [];
  }
}

/**
 * Check if a worker is alive based on heartbeat freshness.
 * A worker is considered dead if lastPollAt is older than maxAgeMs.
 * Invalid dates are treated as dead.
 */
export function isWorkerAlive(
  workingDirectory: string,
  teamName: string,
  workerName: string,
  maxAgeMs: number
): boolean {
  const heartbeat = readHeartbeat(workingDirectory, teamName, workerName);
  if (!heartbeat) return false;

  try {
    const lastPoll = new Date(heartbeat.lastPollAt).getTime();
    if (isNaN(lastPoll)) return false; // Invalid date = dead
    return (Date.now() - lastPoll) < maxAgeMs;
  } catch {
    return false;
  }
}

/** Delete heartbeat file (called during cleanup) */
export function deleteHeartbeat(
  workingDirectory: string,
  teamName: string,
  workerName: string
): void {
  const filePath = heartbeatPath(workingDirectory, teamName, workerName);
  if (existsSync(filePath)) {
    try { unlinkSync(filePath); } catch { /* ignore */ }
  }
}

/** Delete all heartbeat files for a team */
export function cleanupTeamHeartbeats(
  workingDirectory: string,
  teamName: string
): void {
  const dir = heartbeatDir(workingDirectory, teamName);
  if (!existsSync(dir)) return;

  try {
    const files = readdirSync(dir);
    for (const file of files) {
      try { unlinkSync(join(dir, file)); } catch { /* ignore */ }
    }
    // Try to remove the directory itself
    try {
      rmdirSync(dir);
    } catch { /* ignore - may not be empty */ }
  } catch { /* ignore */ }
}
