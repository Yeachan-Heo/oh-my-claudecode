// src/team/team-registration.ts

/**
 * Team Registration for MCP Workers
 *
 * Tri-path registration:
 *   1. Protocol manifest (if state_version marker is present — new teams)
 *   2. config.json (if tolerated — legacy Claude Code teams)
 *   3. Shadow registry (fallback)
 *
 * Phase 3c: Added state_version marker and protocol manifest registration.
 */

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { getClaudeConfigDir } from '../utils/paths.js';
import type { McpWorkerMember, ConfigProbeResult } from './types.js';
import { sanitizeName } from './tmux-session.js';
import { atomicWriteJson, validateResolvedPath, ensureDirWithMode } from './fs-utils.js';
import { resolveStateRoot } from './protocol-adapter.js';
import { toProtocolWorkerInfo } from './protocol-adapter.js';
import {
  readManifest as protocolReadManifest,
  addWorkerToManifest as protocolAddWorker,
} from 'cli-agent-mail';
import { teamDir as protocolTeamDir } from 'cli-agent-mail';

// --- Config paths ---

function configPath(teamName: string): string {
  const result = join(getClaudeConfigDir(), 'teams', sanitizeName(teamName), 'config.json');
  validateResolvedPath(result, join(getClaudeConfigDir(), 'teams'));
  return result;
}

function shadowRegistryPath(workingDirectory: string): string {
  const result = join(workingDirectory, '.omc', 'state', 'team-mcp-workers.json');
  validateResolvedPath(result, join(workingDirectory, '.omc', 'state'));
  return result;
}

function probeResultPath(workingDirectory: string): string {
  return join(workingDirectory, '.omc', 'state', 'config-probe-result.json');
}

// --- State version marker ---

/** State version marker content */
interface StateVersionMarker {
  protocol: string;
  version: number;
}

/** Path to the state_version marker for a team */
function stateVersionPath(workingDirectory: string, teamName: string): string {
  const stateRoot = resolveStateRoot(workingDirectory);
  return join(protocolTeamDir(stateRoot, teamName), 'state_version');
}

/**
 * Check if a team uses the cli-agent-mail protocol layout.
 * Returns true if the state_version marker file exists in the team directory.
 */
export function isProtocolTeam(workingDirectory: string, teamName: string): boolean {
  return existsSync(stateVersionPath(workingDirectory, teamName));
}

/**
 * Write the state_version marker for a team, indicating it uses protocol paths.
 * Called during registration to mark new teams as protocol-based.
 */
export function writeStateVersion(workingDirectory: string, teamName: string): void {
  const markerPath = stateVersionPath(workingDirectory, teamName);
  const stateRoot = resolveStateRoot(workingDirectory);
  const teamDirPath = protocolTeamDir(stateRoot, teamName);
  ensureDirWithMode(teamDirPath);
  const marker: StateVersionMarker = {
    protocol: 'cli-agent-mail',
    version: 1,
  };
  atomicWriteJson(markerPath, marker);
}

/**
 * Read the state_version marker. Returns null if not present.
 */
export function readStateVersion(workingDirectory: string, teamName: string): StateVersionMarker | null {
  const markerPath = stateVersionPath(workingDirectory, teamName);
  if (!existsSync(markerPath)) return null;
  try {
    const raw = readFileSync(markerPath, 'utf-8');
    return JSON.parse(raw) as StateVersionMarker;
  } catch {
    return null;
  }
}

// --- Probe result cache ---

/** Read cached probe result. Returns null if not probed yet. */
export function readProbeResult(workingDirectory: string): ConfigProbeResult | null {
  const filePath = probeResultPath(workingDirectory);
  if (!existsSync(filePath)) return null;
  try {
    const raw = readFileSync(filePath, 'utf-8');
    return JSON.parse(raw) as ConfigProbeResult;
  } catch {
    return null;
  }
}

/** Write probe result cache */
export function writeProbeResult(workingDirectory: string, result: ConfigProbeResult): void {
  atomicWriteJson(probeResultPath(workingDirectory), result);
}

/**
 * Determine registration strategy: 'config' (direct) or 'shadow' (fallback).
 * Based on cached probe result. Defaults to 'shadow' if not probed.
 */
export function getRegistrationStrategy(workingDirectory: string): 'config' | 'shadow' {
  const probe = readProbeResult(workingDirectory);
  if (!probe) return 'shadow'; // Default to safe path if not probed
  if (probe.probeResult === 'pass') return 'config';
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
export function registerMcpWorker(
  teamName: string,
  workerName: string,
  provider: 'codex' | 'gemini',
  model: string,
  tmuxTarget: string,
  cwd: string,
  workingDirectory: string
): void {
  const member: McpWorkerMember = {
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

  // If this team has a protocol manifest, also register in the manifest.
  // Write state_version marker if a manifest exists but marker doesn't yet.
  registerInProtocolManifest(workingDirectory, teamName, member);
}

function registerInConfig(teamName: string, member: McpWorkerMember): void {
  const filePath = configPath(teamName);
  if (!existsSync(filePath)) return; // No config.json to write to

  try {
    const raw = readFileSync(filePath, 'utf-8');
    const config = JSON.parse(raw) as Record<string, unknown>;
    const members = Array.isArray(config.members) ? config.members as Record<string, unknown>[] : [];

    // Remove existing entry for this worker if present
    const filtered = members.filter(
      (m) => m.name !== member.name
    );
    filtered.push(member as unknown as Record<string, unknown>);
    config.members = filtered;

    atomicWriteJson(filePath, config);
  } catch {
    // Config write failure is non-fatal — shadow registry is backup
  }
}

function registerInShadow(workingDirectory: string, teamName: string, member: McpWorkerMember): void {
  const filePath = shadowRegistryPath(workingDirectory);

  let registry: { teamName: string; workers: McpWorkerMember[] };

  if (existsSync(filePath)) {
    try {
      registry = JSON.parse(readFileSync(filePath, 'utf-8'));
    } catch {
      registry = { teamName, workers: [] };
    }
  } else {
    registry = { teamName, workers: [] };
  }

  // Remove existing entry for this worker
  registry.workers = (registry.workers || []).filter(w => w.name !== member.name);
  registry.workers.push(member);
  registry.teamName = teamName;

  atomicWriteJson(filePath, registry);
}

/**
 * Register a worker in the protocol manifest if the team has one.
 * Writes the state_version marker if a manifest exists but no marker yet.
 */
function registerInProtocolManifest(
  workingDirectory: string,
  teamName: string,
  member: McpWorkerMember,
): void {
  const stateRoot = resolveStateRoot(workingDirectory);
  const manifest = protocolReadManifest(stateRoot, teamName);
  if (!manifest) return; // No protocol manifest — legacy team only

  // Ensure state_version marker exists
  if (!isProtocolTeam(workingDirectory, teamName)) {
    writeStateVersion(workingDirectory, teamName);
  }

  // Check if worker is already in the manifest
  const existing = manifest.workers.find(w => w.name === member.name);
  if (existing) return; // Already registered

  // Add worker to manifest
  const workerInfo = toProtocolWorkerInfo(member);
  workerInfo.index = manifest.workers.length;
  try {
    protocolAddWorker(stateRoot, teamName, workerInfo);
  } catch {
    // Non-fatal — shadow registry is the backup
  }
}

/**
 * Unregister an MCP worker from the team.
 * Removes from config.json and shadow registry.
 */
export function unregisterMcpWorker(
  teamName: string,
  workerName: string,
  workingDirectory: string
): void {
  // Remove from config.json
  const configFile = configPath(teamName);
  if (existsSync(configFile)) {
    try {
      const raw = readFileSync(configFile, 'utf-8');
      const config = JSON.parse(raw) as Record<string, unknown>;
      const members = Array.isArray(config.members) ? config.members as Record<string, unknown>[] : [];
      config.members = members.filter(m => m.name !== workerName);
      atomicWriteJson(configFile, config);
    } catch { /* ignore */ }
  }

  // Remove from shadow registry
  const shadowFile = shadowRegistryPath(workingDirectory);
  if (existsSync(shadowFile)) {
    try {
      const registry = JSON.parse(readFileSync(shadowFile, 'utf-8')) as {
        teamName: string;
        workers: McpWorkerMember[];
      };
      registry.workers = (registry.workers || []).filter(w => w.name !== workerName);
      atomicWriteJson(shadowFile, registry);
    } catch { /* ignore */ }
  }
}

/** Check if a member entry is an MCP worker */
export function isMcpWorker(member: Record<string, unknown>): boolean {
  return member.backendType === 'tmux';
}

/** List all MCP workers for a team (reads from both config.json and shadow registry) */
export function listMcpWorkers(teamName: string, workingDirectory: string): McpWorkerMember[] {
  const workers = new Map<string, McpWorkerMember>();

  // Read from config.json
  const configFile = configPath(teamName);
  if (existsSync(configFile)) {
    try {
      const raw = readFileSync(configFile, 'utf-8');
      const config = JSON.parse(raw) as Record<string, unknown>;
      const members = Array.isArray(config.members) ? config.members as Record<string, unknown>[] : [];
      for (const m of members) {
        if (isMcpWorker(m)) {
          workers.set(m.name as string, m as unknown as McpWorkerMember);
        }
      }
    } catch { /* ignore */ }
  }

  // Read from shadow registry (overrides config.json entries)
  const shadowFile = shadowRegistryPath(workingDirectory);
  if (existsSync(shadowFile)) {
    try {
      const registry = JSON.parse(readFileSync(shadowFile, 'utf-8')) as {
        teamName: string;
        workers: McpWorkerMember[];
      };
      for (const w of (registry.workers || [])) {
        workers.set(w.name, w);
      }
    } catch { /* ignore */ }
  }

  return Array.from(workers.values());
}
