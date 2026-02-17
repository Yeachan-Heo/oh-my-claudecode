// src/team/unified-team.ts

/**
 * Unified team member view across Claude native and MCP workers.
 *
 * Merges Claude Code's native team config with MCP shadow registry
 * to provide a single coherent view of all team members.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getClaudeConfigDir } from '../utils/paths.js';
import type { WorkerBackend, WorkerCapability } from './types.js';
import { listMcpWorkers, isProtocolTeam } from './team-registration.js';
import { readHeartbeat, isWorkerAlive } from './heartbeat.js';
import {
  readHeartbeat as protoReadHeartbeat,
  isWorkerAlive as protoIsWorkerAlive,
} from 'cli-agent-mail';
import { resolveStateRoot, fromProtocolHeartbeat } from './protocol-adapter.js';
import { getDefaultCapabilities } from './capabilities.js';

export interface UnifiedTeamMember {
  name: string;
  agentId: string;
  backend: WorkerBackend;
  model: string;
  capabilities: WorkerCapability[];
  joinedAt: number;
  status: 'active' | 'idle' | 'dead' | 'quarantined' | 'unknown';
  currentTaskId: string | null;
}

/**
 * Get all team members from both Claude native teams and MCP workers.
 */
export function getTeamMembers(
  teamName: string,
  workingDirectory: string
): UnifiedTeamMember[] {
  const members: UnifiedTeamMember[] = [];

  // 1. Read Claude native members from config.json
  try {
    const configPath = join(getClaudeConfigDir(), 'teams', teamName, 'config.json');
    if (existsSync(configPath)) {
      const config = JSON.parse(readFileSync(configPath, 'utf-8'));
      if (Array.isArray(config.members)) {
        for (const member of config.members) {
          // Skip MCP workers (they'll be handled below)
          if (member.backendType === 'tmux') continue;

          members.push({
            name: member.name || 'unknown',
            agentId: member.agentId || '',
            backend: 'claude-native',
            model: member.model || 'unknown',
            capabilities: getDefaultCapabilities('claude-native'),
            joinedAt: member.joinedAt || 0,
            status: 'active', // Claude native members are managed by CC
            currentTaskId: null,
          });
        }
      }
    }
  } catch { /* graceful degradation - config may not exist */ }

  // 2. Read MCP workers from shadow registry + heartbeat
  try {
    const mcpWorkers = listMcpWorkers(teamName, workingDirectory);
    const useProtocol = isProtocolTeam(workingDirectory, teamName);
    const stateRoot = useProtocol ? resolveStateRoot(workingDirectory) : '';

    for (const worker of mcpWorkers) {
      let heartbeat: import('./types.js').HeartbeatData | null = null;
      let alive = false;

      if (useProtocol) {
        // Read from protocol heartbeat
        const protoHb = protoReadHeartbeat(stateRoot, teamName, worker.name);
        if (protoHb) {
          heartbeat = fromProtocolHeartbeat(protoHb, worker.name, teamName);
        }
        alive = protoIsWorkerAlive(stateRoot, teamName, worker.name, 60000);
      } else {
        // Legacy: read from OMC heartbeat files
        heartbeat = readHeartbeat(workingDirectory, teamName, worker.name);
        alive = isWorkerAlive(workingDirectory, teamName, worker.name, 60000);
      }

      // Determine status from heartbeat
      let status: UnifiedTeamMember['status'] = 'unknown';
      if (heartbeat) {
        if (heartbeat.status === 'quarantined') status = 'quarantined';
        else if (heartbeat.status === 'executing') status = 'active';
        else if (heartbeat.status === 'ready' || heartbeat.status === 'polling') status = 'idle';
        else status = heartbeat.status as UnifiedTeamMember['status'];
      }
      if (!alive) status = 'dead';

      // Determine backend and default capabilities
      const backend: WorkerBackend = worker.agentType === 'mcp-gemini' ? 'mcp-gemini' : 'mcp-codex';
      const capabilities = getDefaultCapabilities(backend);

      members.push({
        name: worker.name,
        agentId: worker.agentId,
        backend,
        model: worker.model,
        capabilities,
        joinedAt: worker.joinedAt,
        status,
        currentTaskId: heartbeat?.currentTaskId ?? null,
      });
    }
  } catch { /* graceful degradation */ }

  return members;
}
