import { cpus, freemem, loadavg, platform, totalmem } from 'os';
import type { TeamOpsConfig, TeamResourceProfile } from '../shared/types.js';

const BYTES_PER_GIB = 1024 ** 3;

export interface LocalResourceSnapshot {
  cpuCount: number;
  totalMemoryBytes: number;
  freeMemoryBytes: number;
  loadAverage1m?: number;
  platform: NodeJS.Platform | string;
}

export interface TeamWorkerCountDecision {
  requested: number;
  effective: number;
  capped: boolean;
  adaptiveEnabled: boolean;
  maxAgents?: number;
  resourceCap?: number;
  resourceProfile: TeamResourceProfile;
  reason: string;
  snapshot?: LocalResourceSnapshot;
}

interface ResourceProfilePolicy {
  cpuReserve: number;
  memoryPerWorkerBytes: number;
  minimumFreeMemoryBytes: number;
  loadPressureRatio: number;
}

const RESOURCE_PROFILE_POLICIES: Record<TeamResourceProfile, ResourceProfilePolicy> = {
  conservative: {
    cpuReserve: 2,
    memoryPerWorkerBytes: 2 * BYTES_PER_GIB,
    minimumFreeMemoryBytes: 1 * BYTES_PER_GIB,
    loadPressureRatio: 0.75,
  },
  balanced: {
    cpuReserve: 1,
    memoryPerWorkerBytes: 1.5 * BYTES_PER_GIB,
    minimumFreeMemoryBytes: 1 * BYTES_PER_GIB,
    loadPressureRatio: 1.0,
  },
  aggressive: {
    cpuReserve: 0,
    memoryPerWorkerBytes: 1 * BYTES_PER_GIB,
    minimumFreeMemoryBytes: 0.5 * BYTES_PER_GIB,
    loadPressureRatio: 1.25,
  },
};

const TRUTHY_ENV_VALUES = new Set(['1', 'true', 'yes', 'on', 'enabled']);
const FALSY_ENV_VALUES = new Set(['0', 'false', 'no', 'off', 'disabled']);

function parseBooleanEnv(raw: string | undefined): boolean | undefined {
  if (raw === undefined) return undefined;
  const normalized = raw.trim().toLowerCase();
  if (TRUTHY_ENV_VALUES.has(normalized)) return true;
  if (FALSY_ENV_VALUES.has(normalized)) return false;
  return undefined;
}

function parsePositiveIntEnv(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const normalized = raw.trim();
  if (!/^[1-9]\d*$/.test(normalized)) return undefined;
  const parsed = Number.parseInt(normalized, 10);
  return Number.isInteger(parsed) && parsed >= 1 ? parsed : undefined;
}

function clampWorkerCount(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.max(1, Math.floor(value));
}

function resolveResourceProfile(
  ops: TeamOpsConfig | undefined,
  env: NodeJS.ProcessEnv,
): TeamResourceProfile {
  const envProfile = env.OMC_TEAM_RESOURCE_PROFILE?.trim().toLowerCase();
  if (envProfile === 'conservative' || envProfile === 'balanced' || envProfile === 'aggressive') {
    return envProfile;
  }
  return ops?.resourceProfile ?? 'balanced';
}

function resolveMaxAgents(
  ops: TeamOpsConfig | undefined,
  env: NodeJS.ProcessEnv,
): number | undefined {
  return parsePositiveIntEnv(env.OMC_TEAM_MAX_AGENTS) ?? ops?.maxAgents;
}

function isAdaptiveAgentsEnabled(
  ops: TeamOpsConfig | undefined,
  env: NodeJS.ProcessEnv,
): boolean {
  return parseBooleanEnv(env.OMC_TEAM_ADAPTIVE_AGENTS) ?? (ops?.adaptiveAgents === true);
}

export function readLocalResourceSnapshot(): LocalResourceSnapshot {
  const cpuCount = Math.max(1, cpus().length);
  const currentPlatform = platform();
  const loadAverage = loadavg();
  return {
    cpuCount,
    totalMemoryBytes: totalmem(),
    freeMemoryBytes: freemem(),
    ...(currentPlatform === 'win32' ? {} : { loadAverage1m: loadAverage[0] }),
    platform: currentPlatform,
  };
}

export function estimateResourceWorkerCap(
  snapshot: LocalResourceSnapshot,
  profile: TeamResourceProfile,
): number {
  const policy = RESOURCE_PROFILE_POLICIES[profile];
  const cpuCap = Math.max(1, snapshot.cpuCount - policy.cpuReserve);
  const memoryAvailableForWorkers = Math.max(
    0,
    snapshot.freeMemoryBytes - policy.minimumFreeMemoryBytes,
  );
  const memoryCap = Math.max(
    1,
    Math.floor(memoryAvailableForWorkers / policy.memoryPerWorkerBytes),
  );
  let cap = Math.max(1, Math.min(cpuCap, memoryCap));

  if (
    typeof snapshot.loadAverage1m === 'number' &&
    Number.isFinite(snapshot.loadAverage1m) &&
    snapshot.loadAverage1m > snapshot.cpuCount * policy.loadPressureRatio
  ) {
    cap = Math.max(1, Math.min(cap, Math.floor(snapshot.cpuCount / 2)));
  }

  return cap;
}

/**
 * Resolve initial /team fanout from user request + configured caps.
 *
 * This function is intentionally cap-only: it never increases the requested
 * worker count. That keeps the feature safe for existing team workflows while
 * allowing opt-in resource protection on constrained machines.
 */
export function resolveTeamWorkerCount(
  requestedWorkerCount: number,
  ops: TeamOpsConfig | undefined,
  env: NodeJS.ProcessEnv = process.env,
  snapshot: LocalResourceSnapshot = readLocalResourceSnapshot(),
): TeamWorkerCountDecision {
  const requested = clampWorkerCount(requestedWorkerCount);
  const profile = resolveResourceProfile(ops, env);
  const maxAgents = resolveMaxAgents(ops, env);
  const adaptiveEnabled = isAdaptiveAgentsEnabled(ops, env);

  let effective = requested;
  const reasons: string[] = [];

  if (maxAgents !== undefined && maxAgents < effective) {
    effective = maxAgents;
    reasons.push(`maxAgents=${maxAgents}`);
  }

  let resourceCap: number | undefined;
  if (adaptiveEnabled) {
    resourceCap = estimateResourceWorkerCap(snapshot, profile);
    if (resourceCap < effective) {
      effective = resourceCap;
      reasons.push(`resourceCap=${resourceCap}`);
    }
  }

  effective = clampWorkerCount(effective);

  return {
    requested,
    effective,
    capped: effective < requested,
    adaptiveEnabled,
    ...(maxAgents !== undefined ? { maxAgents } : {}),
    ...(resourceCap !== undefined ? { resourceCap } : {}),
    resourceProfile: profile,
    reason: reasons.length > 0 ? reasons.join(', ') : 'requested',
    ...(adaptiveEnabled ? { snapshot } : {}),
  };
}
