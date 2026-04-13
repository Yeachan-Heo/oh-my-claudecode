/**
 * Memory Sync Hook — SessionEnd handler
 *
 * Syncs Claude Code project memories to a user-configured private git
 * vault on session end.
 *
 * Purpose:
 * - Version-controlled backup of Claude memory (knowledge assets)
 * - Cross-machine portability
 * - Memory evolution tracking over time
 *
 * Configuration (in .omc/config.json or OMC config):
 *   memorySync: {
 *     enabled: true,
 *     vaultPath: "~/workspace/claude-memory-vault",
 *     autoPush: false,
 *     timeout: 10000
 *   }
 */

import * as fs from 'fs';
import type { MemorySyncConfig, SyncResult } from './types.js';
import { DEFAULT_CONFIG } from './types.js';
import { syncMemory } from './sync.js';

export { extractProjectName } from './sync.js';
export type { MemorySyncConfig, SyncResult, FileChange } from './types.js';

export interface MemorySyncInput {
  session_id: string;
  cwd: string;
  hook_event_name: 'SessionEnd';
}

export interface MemorySyncOutput {
  continue: boolean;
  result?: SyncResult;
}

/**
 * Load memory sync config from OMC config or environment.
 */
export function loadConfig(): MemorySyncConfig {
  // Try environment variable first
  const envVaultPath = process.env.OMC_MEMORY_VAULT_PATH;
  const envEnabled = process.env.OMC_MEMORY_SYNC_ENABLED;
  const envAutoPush = process.env.OMC_MEMORY_SYNC_AUTO_PUSH;

  if (envVaultPath) {
    const home = process.env.HOME || '';
    const resolvedPath = envVaultPath.replace(/^~/, home);

    return {
      enabled: envEnabled !== 'false',
      vaultPath: resolvedPath,
      autoPush: envAutoPush === 'true',
      timeout: DEFAULT_CONFIG.timeout,
    };
  }

  // Try OMC config file
  const configPaths = [
    `${process.env.HOME}/.omc/config.json`,
    `${process.cwd()}/.omc/config.json`,
  ];

  for (const configPath of configPaths) {
    try {
      const content = fs.readFileSync(configPath, 'utf-8');
      const config = JSON.parse(content);

      if (config.memorySync) {
        const home = process.env.HOME || '';
        return {
          ...DEFAULT_CONFIG,
          ...config.memorySync,
          vaultPath: (config.memorySync.vaultPath || '').replace(/^~/, home),
        };
      }
    } catch {
      // Config file not found or invalid, try next
    }
  }

  return DEFAULT_CONFIG;
}

/**
 * Main hook handler — called by the SessionEnd bridge script.
 */
export function processMemorySync(_input: MemorySyncInput): MemorySyncOutput {
  const config = loadConfig();

  if (!config.enabled) {
    return { continue: true };
  }

  try {
    const result = syncMemory(config);
    return { continue: true, result };
  } catch (error) {
    // Memory sync should never block session end
    return {
      continue: true,
      result: {
        synced: false,
        filesChanged: 0,
        committed: false,
        pushed: false,
        error: error instanceof Error ? error.message : String(error),
      },
    };
  }
}
