import type { TeamOpsConfig } from '../shared/types.js';

export interface TeamFanoutDecision {
  requested: number;
  effective: number;
  capped: boolean;
}

/**
 * Cap active team worker fanout without changing the requested work/backlog.
 *
 * `team.ops.maxAgents` is an active-worker ceiling. Callers should keep task
 * construction based on the original requested count and only use `effective`
 * for spawned workers / agent fanout.
 */
export function resolveTeamFanout(
  requestedWorkerCount: number,
  ops: TeamOpsConfig | undefined,
): TeamFanoutDecision {
  const requested = Math.max(1, Math.trunc(requestedWorkerCount));
  const configuredMax = ops?.maxAgents;
  if (typeof configuredMax !== 'number' || !Number.isInteger(configuredMax) || configuredMax < 1) {
    return { requested, effective: requested, capped: false };
  }

  const effective = Math.min(requested, configuredMax);
  return { requested, effective, capped: effective < requested };
}

export function normalizeMaxWorkers(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1
    ? value
    : undefined;
}
