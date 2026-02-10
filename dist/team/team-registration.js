// src/team/team-registration.ts
/**
 * Team Registration for MCP Workers
 *
 * Dual-path registration: config.json (if tolerated) or shadow registry (fallback).
 * Auto-detects strategy via cached probe result.
 */
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { sanitizeName } from './tmux-session.js';
import { atomicWriteJson, validateResolvedPath } from './fs-utils.js';
// --- Config paths ---
function configPath(teamName) {
    const result = join(homedir(), '.claude', 'teams', sanitizeName(teamName), 'config.json');
    validateResolvedPath(result, join(homedir(), '.claude', 'teams'));
    return result;
}
function shadowRegistryPath(workingDirectory) {
    const result = join(workingDirectory, '.omc', 'state', 'team-mcp-workers.json');
    validateResolvedPath(result, join(workingDirectory, '.omc', 'state'));
    return result;
}
function probeResultPath(workingDirectory) {
    return join(workingDirectory, '.omc', 'state', 'config-probe-result.json');
}
// --- Probe result cache ---
/** Read cached probe result. Returns null if not probed yet. */
export function readProbeResult(workingDirectory) {
    const filePath = probeResultPath(workingDirectory);
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
/** Write probe result cache */
export function writeProbeResult(workingDirectory, result) {
    atomicWriteJson(probeResultPath(workingDirectory), result);
}
/**
 * Determine registration strategy: 'config' (direct) or 'shadow' (fallback).
 * Based on cached probe result. Defaults to 'shadow' if not probed.
 */
export function getRegistrationStrategy(workingDirectory) {
    const probe = readProbeResult(workingDirectory);
    if (!probe)
        return 'shadow'; // Default to safe path if not probed
    if (probe.probeResult === 'pass')
        return 'config';
    return 'shadow'; // 'fail' and 'partial' both use shadow
}
// --- Registration (dual-path) ---
/**
 * Register an MCP worker in the team.
 *
 * Strategy auto-selected based on cached probe result:
 * - 'config': Write member to config.json (preferred)
 * - 'shadow': Write member to .omc/state/team-mcp-workers.json (fallback)
 *
 * Both paths use atomic write (temp + rename) to prevent corruption.
 */
export function registerMcpWorker(teamName, workerName, provider, model, tmuxTarget, cwd, workingDirectory) {
    const member = {
        agentId: `${workerName}@${teamName}`,
        name: workerName,
        agentType: `mcp-${provider}`,
        model,
        joinedAt: Date.now(),
        tmuxPaneId: tmuxTarget,
        cwd,
        backendType: 'tmux',
        subscriptions: [],
    };
    const strategy = getRegistrationStrategy(workingDirectory);
    if (strategy === 'config') {
        registerInConfig(teamName, member);
    }
    // Always write to shadow registry (as backup or primary)
    registerInShadow(workingDirectory, teamName, member);
}
function registerInConfig(teamName, member) {
    const filePath = configPath(teamName);
    if (!existsSync(filePath))
        return; // No config.json to write to
    try {
        const raw = readFileSync(filePath, 'utf-8');
        const config = JSON.parse(raw);
        const members = Array.isArray(config.members) ? config.members : [];
        // Remove existing entry for this worker if present
        const filtered = members.filter((m) => m.name !== member.name);
        filtered.push(member);
        config.members = filtered;
        atomicWriteJson(filePath, config);
    }
    catch {
        // Config write failure is non-fatal — shadow registry is backup
    }
}
function registerInShadow(workingDirectory, teamName, member) {
    const filePath = shadowRegistryPath(workingDirectory);
    let registry;
    if (existsSync(filePath)) {
        try {
            registry = JSON.parse(readFileSync(filePath, 'utf-8'));
        }
        catch {
            registry = { teamName, workers: [] };
        }
    }
    else {
        registry = { teamName, workers: [] };
    }
    // Remove existing entry for this worker
    registry.workers = (registry.workers || []).filter(w => w.name !== member.name);
    registry.workers.push(member);
    registry.teamName = teamName;
    atomicWriteJson(filePath, registry);
}
/**
 * Unregister an MCP worker from the team.
 * Removes from config.json and shadow registry.
 */
export function unregisterMcpWorker(teamName, workerName, workingDirectory) {
    // Remove from config.json
    const configFile = configPath(teamName);
    if (existsSync(configFile)) {
        try {
            const raw = readFileSync(configFile, 'utf-8');
            const config = JSON.parse(raw);
            const members = Array.isArray(config.members) ? config.members : [];
            config.members = members.filter(m => m.name !== workerName);
            atomicWriteJson(configFile, config);
        }
        catch { /* ignore */ }
    }
    // Remove from shadow registry
    const shadowFile = shadowRegistryPath(workingDirectory);
    if (existsSync(shadowFile)) {
        try {
            const registry = JSON.parse(readFileSync(shadowFile, 'utf-8'));
            registry.workers = (registry.workers || []).filter(w => w.name !== workerName);
            atomicWriteJson(shadowFile, registry);
        }
        catch { /* ignore */ }
    }
}
/** Check if a member entry is an MCP worker */
export function isMcpWorker(member) {
    return member.backendType === 'tmux';
}
/** List all MCP workers for a team (reads from both config.json and shadow registry) */
export function listMcpWorkers(teamName, workingDirectory) {
    const workers = new Map();
    // Read from config.json
    const configFile = configPath(teamName);
    if (existsSync(configFile)) {
        try {
            const raw = readFileSync(configFile, 'utf-8');
            const config = JSON.parse(raw);
            const members = Array.isArray(config.members) ? config.members : [];
            for (const m of members) {
                if (isMcpWorker(m)) {
                    workers.set(m.name, m);
                }
            }
        }
        catch { /* ignore */ }
    }
    // Read from shadow registry (overrides config.json entries)
    const shadowFile = shadowRegistryPath(workingDirectory);
    if (existsSync(shadowFile)) {
        try {
            const registry = JSON.parse(readFileSync(shadowFile, 'utf-8'));
            for (const w of (registry.workers || [])) {
                workers.set(w.name, w);
            }
        }
        catch { /* ignore */ }
    }
    return Array.from(workers.values());
}
//# sourceMappingURL=team-registration.js.map