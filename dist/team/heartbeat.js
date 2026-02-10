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
import { sanitizeName } from './tmux-session.js';
import { atomicWriteJson } from './fs-utils.js';
/** Heartbeat file path */
function heartbeatPath(workingDirectory, teamName, workerName) {
    return join(workingDirectory, '.omc', 'state', 'team-bridge', sanitizeName(teamName), `${sanitizeName(workerName)}.heartbeat.json`);
}
/** Heartbeat directory for a team */
function heartbeatDir(workingDirectory, teamName) {
    return join(workingDirectory, '.omc', 'state', 'team-bridge', sanitizeName(teamName));
}
/** Write/update heartbeat. Called every poll cycle by the bridge. */
export function writeHeartbeat(workingDirectory, data) {
    const filePath = heartbeatPath(workingDirectory, data.teamName, data.workerName);
    atomicWriteJson(filePath, data);
}
/** Read heartbeat for a specific worker. Returns null if not found. */
export function readHeartbeat(workingDirectory, teamName, workerName) {
    const filePath = heartbeatPath(workingDirectory, teamName, workerName);
    if (!existsSync(filePath))
        return null;
    try {
        const raw = readFileSync(filePath, 'utf-8');
        return JSON.parse(raw);
    }
    catch {
        return null;
    }
}
/** List all heartbeat files for a team. Used by lead to check worker health. */
export function listHeartbeats(workingDirectory, teamName) {
    const dir = heartbeatDir(workingDirectory, teamName);
    if (!existsSync(dir))
        return [];
    try {
        const files = readdirSync(dir).filter(f => f.endsWith('.heartbeat.json'));
        const heartbeats = [];
        for (const file of files) {
            try {
                const raw = readFileSync(join(dir, file), 'utf-8');
                heartbeats.push(JSON.parse(raw));
            }
            catch { /* skip malformed */ }
        }
        return heartbeats;
    }
    catch {
        return [];
    }
}
/**
 * Check if a worker is alive based on heartbeat freshness.
 * A worker is considered dead if lastPollAt is older than maxAgeMs.
 * Invalid dates are treated as dead.
 */
export function isWorkerAlive(workingDirectory, teamName, workerName, maxAgeMs) {
    const heartbeat = readHeartbeat(workingDirectory, teamName, workerName);
    if (!heartbeat)
        return false;
    try {
        const lastPoll = new Date(heartbeat.lastPollAt).getTime();
        if (isNaN(lastPoll))
            return false; // Invalid date = dead
        return (Date.now() - lastPoll) < maxAgeMs;
    }
    catch {
        return false;
    }
}
/** Delete heartbeat file (called during cleanup) */
export function deleteHeartbeat(workingDirectory, teamName, workerName) {
    const filePath = heartbeatPath(workingDirectory, teamName, workerName);
    if (existsSync(filePath)) {
        try {
            unlinkSync(filePath);
        }
        catch { /* ignore */ }
    }
}
/** Delete all heartbeat files for a team */
export function cleanupTeamHeartbeats(workingDirectory, teamName) {
    const dir = heartbeatDir(workingDirectory, teamName);
    if (!existsSync(dir))
        return;
    try {
        const files = readdirSync(dir);
        for (const file of files) {
            try {
                unlinkSync(join(dir, file));
            }
            catch { /* ignore */ }
        }
        // Try to remove the directory itself
        try {
            rmdirSync(dir);
        }
        catch { /* ignore - may not be empty */ }
    }
    catch { /* ignore */ }
}
//# sourceMappingURL=heartbeat.js.map