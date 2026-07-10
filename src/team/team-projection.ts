import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { randomUUID } from 'crypto';

import type { TeamConfig, TeamManifestV2 } from './types.js';
import { absPath, TeamPaths } from './state-paths.js';
import { checkOwnerFence, type OwnerFence } from './team-owner-epoch.js';
import { deriveManifestProjection } from './team-state-reader.js';

export type ProjectionRepairResult =
  | { classification: 'synced'; revision: number }
  | { classification: 'repair_required'; revision: number | null; reason: 'fence_lost' | 'config_changed' | 'recovery_changed' | 'invalid_config' | 'io_error' };

export interface ProjectionRepairOptions {
  fence: OwnerFence;
  recoveryId?: string;
  maxAttempts?: number;
}

function parseConfig(path: string): TeamConfig | null {
  try {
    const config = JSON.parse(readFileSync(path, 'utf8')) as TeamConfig;
    return Number.isSafeInteger(config.state_revision) ? config : null;
  } catch {
    return null;
  }
}

function parseManifest(path: string): TeamManifestV2 | null {
  try { return JSON.parse(readFileSync(path, 'utf8')) as TeamManifestV2; } catch { return null; }
}

function sameRecovery(config: TeamConfig, recoveryId: string | undefined): boolean {
  return recoveryId === undefined || config.active_recovery?.recovery_id === recoveryId || config.last_recovery?.recovery_id === recoveryId;
}

/**
 * Repair the mutable manifest projection only while the owner fence and source revision remain
 * current. A delayed repair stages a new temp after every mismatch and therefore cannot rename
 * a revision N+1 projection over a committed N+2 projection.
 */
export function repairTeamProjection(cwd: string, teamName: string, options: ProjectionRepairOptions): ProjectionRepairResult {
  const configPath = absPath(cwd, TeamPaths.config(teamName));
  const manifestPath = absPath(cwd, TeamPaths.manifest(teamName));
  const attempts = options.maxAttempts ?? 3;
  let lastRevision: number | null = null;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (!checkOwnerFence(cwd, teamName, options.fence).ok) return { classification: 'repair_required', revision: lastRevision, reason: 'fence_lost' };
    const config = parseConfig(configPath);
    if (!config || config.state_revision === undefined) return { classification: 'repair_required', revision: null, reason: existsSync(configPath) ? 'invalid_config' : 'io_error' };
    if (!sameRecovery(config, options.recoveryId)) return { classification: 'repair_required', revision: config.state_revision, reason: 'recovery_changed' };
    lastRevision = config.state_revision;
    const manifest = parseManifest(manifestPath);
    const projection = deriveManifestProjection(config, manifest);
    const bytes = JSON.stringify(projection);
    mkdirSync(dirname(manifestPath), { recursive: true, mode: 0o700 });
    const temp = join(dirname(manifestPath), `.manifest.${config.state_revision}.${randomUUID()}.tmp`);
    writeFileSync(temp, bytes, { encoding: 'utf8', mode: 0o600, flush: true });

    const beforeRename = parseConfig(configPath);
    const validBeforeRename = checkOwnerFence(cwd, teamName, options.fence).ok
      && beforeRename?.state_revision === config.state_revision
      && sameRecovery(beforeRename, options.recoveryId);
    if (!validBeforeRename) {
      unlinkSync(temp);
      continue;
    }

    renameSync(temp, manifestPath);
    const afterRename = parseConfig(configPath);
    const written = parseManifest(manifestPath) as (TeamManifestV2 & { state_revision?: number }) | null;
    if (checkOwnerFence(cwd, teamName, options.fence).ok
      && afterRename?.state_revision === config.state_revision
      && sameRecovery(afterRename, options.recoveryId)
      && written?.state_revision === config.state_revision) {
      return { classification: 'synced', revision: config.state_revision };
    }
  }
  return { classification: 'repair_required', revision: lastRevision, reason: 'config_changed' };
}
