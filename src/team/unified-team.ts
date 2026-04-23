// src/team/unified-team.ts

/**
 * Unified team member view across Claude native and MCP workers.
 *
 * Merges Claude Code's native team config with MCP shadow registry
 * to provide a single coherent view of all team members.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getClaudeConfigDir } from '../utils/config-dir.js';
import type { WorkerBackend, WorkerCapability } from './types.js';
import { TeamPaths, absPath } from './state-paths.js';
import { listMcpWorkers } from './team-registration.js';
import { readHeartbeat, isWorkerAlive } from './heartbeat.js';
import {
  getDefaultCapabilitiesForWorker,
  resolveWorkerBackend,
  resolveWorkerProvider,
  type WorkerProvider,
} from './capabilities.js';

export interface UnifiedTeamMember {
  name: string;
  agentId: string;
  backend: WorkerBackend;
  model: string;
  capabilities: WorkerCapability[];
  provider?: WorkerProvider;
  joinedAt: number;
  status: 'active' | 'idle' | 'dead' | 'quarantined' | 'unknown';
  currentTaskId: string | null;
}

type RuntimeConfigWorkerRecord = {
  name: string;
  workerCli: string;
  model: string;
  joinedAt: number;
};

function deriveCliWorkerState(
  teamName: string,
  workingDirectory: string,
  workerName: string,
): Pick<UnifiedTeamMember, 'status' | 'currentTaskId'> {
  const heartbeat = readHeartbeat(workingDirectory, teamName, workerName);
  const alive = isWorkerAlive(workingDirectory, teamName, workerName, 60000);

  let status: UnifiedTeamMember['status'] = 'unknown';
  if (heartbeat) {
    if (heartbeat.status === 'quarantined') status = 'quarantined';
    else if (heartbeat.status === 'executing') status = 'active';
    else if (heartbeat.status === 'ready' || heartbeat.status === 'polling') status = 'idle';
    else status = heartbeat.status as UnifiedTeamMember['status'];
  }
  if (!alive) status = 'dead';

  return {
    status,
    currentTaskId: heartbeat?.currentTaskId ?? null,
  };
}

function readRuntimeConfigWorkers(
  teamName: string,
  workingDirectory: string,
): RuntimeConfigWorkerRecord[] {
  const configPath = absPath(workingDirectory, TeamPaths.config(teamName));
  if (!existsSync(configPath)) return [];

  try {
    const raw = JSON.parse(readFileSync(configPath, 'utf-8')) as Record<string, unknown>;
    const workers = Array.isArray(raw.workers) ? raw.workers as Record<string, unknown>[] : [];
    const teamAgentType = typeof raw.agent_type === 'string' ? raw.agent_type : 'claude';
    const joinedAt = typeof raw.created_at === 'string' ? Date.parse(raw.created_at) || 0 : 0;
    return workers
      .map((worker) => {
        const name = typeof worker.name === 'string' ? worker.name : '';
        if (!name) return null;
        const workerCli = typeof worker.worker_cli === 'string' && worker.worker_cli.trim()
          ? worker.worker_cli
          : typeof worker.role === 'string' && ['claude', 'codex', 'gemini', 'cursor', 'copilot'].includes(worker.role)
            ? worker.role
            : teamAgentType;
        return {
          name,
          workerCli,
          model: typeof worker.model === 'string' ? worker.model : workerCli,
          joinedAt,
        } satisfies RuntimeConfigWorkerRecord;
      })
      .filter((worker): worker is RuntimeConfigWorkerRecord => worker !== null);
  } catch {
    return [];
  }
}

/**
 * Get all team members from both Claude native teams and MCP workers.
 */
export function getTeamMembers(
  teamName: string,
  workingDirectory: string
): UnifiedTeamMember[] {
  const members = new Map<string, UnifiedTeamMember>();

  // 1. Read Claude native members from config.json
  try {
    const configPath = join(getClaudeConfigDir(), 'teams', teamName, 'config.json');
    if (existsSync(configPath)) {
      const config = JSON.parse(readFileSync(configPath, 'utf-8'));
      if (Array.isArray(config.members)) {
        for (const member of config.members) {
          // Skip MCP workers registered via tmux backend (they'll be handled below)
          if (member.backendType === 'tmux' || String(member.agentType).startsWith('tmux-')) continue;

          members.set(member.name || 'unknown', {
            name: member.name || 'unknown',
            agentId: member.agentId || '',
            backend: 'claude-native',
            model: member.model || 'unknown',
            capabilities: getDefaultCapabilitiesForWorker('claude-native'),
            provider: 'claude',
            joinedAt: member.joinedAt || 0,
            status: 'active', // Claude native members are managed by CC
            currentTaskId: null,
          });
        }
      }
    }
  } catch { /* graceful degradation - config may not exist */ }

  // 2. Read CLI/runtime workers from the team config written under .omc/state.
  try {
    for (const worker of readRuntimeConfigWorkers(teamName, workingDirectory)) {
      const backend = resolveWorkerBackend(worker.workerCli);
      const provider = resolveWorkerProvider(worker.workerCli);
      const state = deriveCliWorkerState(teamName, workingDirectory, worker.name);

      members.set(worker.name, {
        name: worker.name,
        agentId: `${worker.name}@${teamName}`,
        backend,
        model: worker.model,
        capabilities: getDefaultCapabilitiesForWorker(worker.workerCli),
        provider,
        joinedAt: worker.joinedAt,
        ...state,
      });
    }
  } catch { /* graceful degradation */ }

  // 3. Read MCP workers from shadow registry + heartbeat
  try {
    const mcpWorkers = listMcpWorkers(teamName, workingDirectory);
    for (const worker of mcpWorkers) {
      const backend = resolveWorkerBackend(worker.agentType);
      const provider = resolveWorkerProvider(worker.agentType);
      const state = deriveCliWorkerState(teamName, workingDirectory, worker.name);

      members.set(worker.name, {
        name: worker.name,
        agentId: worker.agentId,
        backend,
        model: worker.model,
        capabilities: getDefaultCapabilitiesForWorker(worker.agentType),
        provider,
        joinedAt: worker.joinedAt,
        ...state,
      });
    }
  } catch { /* graceful degradation */ }

  return Array.from(members.values());
}
