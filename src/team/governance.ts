import type {
  TeamConfig,
  TeamGovernance,
  TeamManifestV2,
  TeamPolicy,
  TeamTransportPolicy,
} from './types.js';
import { DEFAULT_MAX_WORKERS } from './types.js';

export type LifecycleProfile = 'default' | 'linked_ralph';

export const DEFAULT_TEAM_TRANSPORT_POLICY: TeamTransportPolicy = {
  display_mode: 'split_pane',
  worker_launch_mode: 'interactive',
  dispatch_mode: 'hook_preferred_with_fallback',
  dispatch_ack_timeout_ms: 15_000,
};

export const DEFAULT_TEAM_GOVERNANCE: TeamGovernance = {
  delegation_only: false,
  plan_approval_required: false,
  nested_teams_allowed: false,
  one_team_per_leader_session: true,
  cleanup_requires_all_workers_inactive: true,
};

/**
 * Resolve the effective worker cap when merging a persisted config with a
 * legacy manifest projection. The manifest always supplies the legacy default
 * of 20, so an explicit configured cap below 20 must win (issue #3744), a
 * missing value keeps the default, and anything above 20 is clamped to the
 * hard ceiling. This helper only resolves the default-vs-cap decision; the
 * shape of a persisted value itself stays the responsibility of the
 * persisted-state validators, and out-of-contract values are never silently
 * rewritten here.
 */
export function resolveMaxWorkers(configured: number | undefined): number {
  if (configured === undefined) return DEFAULT_MAX_WORKERS;
  return Math.min(configured, DEFAULT_MAX_WORKERS);
}

type LegacyPolicyLike = Partial<TeamPolicy> & Partial<TeamTransportPolicy> & Partial<TeamGovernance>;

export function normalizeTeamTransportPolicy(policy?: LegacyPolicyLike | null): TeamTransportPolicy {
  return {
    display_mode: policy?.display_mode ?? DEFAULT_TEAM_TRANSPORT_POLICY.display_mode,
    worker_launch_mode: policy?.worker_launch_mode ?? DEFAULT_TEAM_TRANSPORT_POLICY.worker_launch_mode,
    dispatch_mode: policy?.dispatch_mode ?? DEFAULT_TEAM_TRANSPORT_POLICY.dispatch_mode,
    dispatch_ack_timeout_ms:
      typeof policy?.dispatch_ack_timeout_ms === 'number'
        ? policy.dispatch_ack_timeout_ms
        : DEFAULT_TEAM_TRANSPORT_POLICY.dispatch_ack_timeout_ms,
  };
}

export function normalizeTeamGovernance(
  governance?: Partial<TeamGovernance> | null,
  legacyPolicy?: LegacyPolicyLike | null,
): TeamGovernance {
  return {
    delegation_only:
      governance?.delegation_only
      ?? legacyPolicy?.delegation_only
      ?? DEFAULT_TEAM_GOVERNANCE.delegation_only,
    plan_approval_required:
      governance?.plan_approval_required
      ?? legacyPolicy?.plan_approval_required
      ?? DEFAULT_TEAM_GOVERNANCE.plan_approval_required,
    nested_teams_allowed:
      governance?.nested_teams_allowed
      ?? legacyPolicy?.nested_teams_allowed
      ?? DEFAULT_TEAM_GOVERNANCE.nested_teams_allowed,
    one_team_per_leader_session:
      governance?.one_team_per_leader_session
      ?? legacyPolicy?.one_team_per_leader_session
      ?? DEFAULT_TEAM_GOVERNANCE.one_team_per_leader_session,
    cleanup_requires_all_workers_inactive:
      governance?.cleanup_requires_all_workers_inactive
      ?? legacyPolicy?.cleanup_requires_all_workers_inactive
      ?? DEFAULT_TEAM_GOVERNANCE.cleanup_requires_all_workers_inactive,
  };
}

export function normalizeTeamManifest(manifest: TeamManifestV2): TeamManifestV2 {
  return {
    ...manifest,
    policy: normalizeTeamTransportPolicy(manifest.policy),
    governance: normalizeTeamGovernance(manifest.governance, manifest.policy),
  };
}

export function getConfigGovernance(config: TeamConfig | null | undefined): TeamGovernance {
  return normalizeTeamGovernance(config?.governance, config?.policy);
}

/**
 * Resolve the effective lifecycle profile for a team.
 * Manifest takes precedence over config; defaults to 'default'.
 */
export function resolveLifecycleProfile(
  config?: Pick<TeamConfig, 'lifecycle_profile'> | null,
  manifest?: Pick<TeamManifestV2, 'lifecycle_profile'> | null,
): LifecycleProfile {
  if (manifest?.lifecycle_profile) return manifest.lifecycle_profile;
  if (config?.lifecycle_profile) return config.lifecycle_profile;
  return 'default';
}

/** Returns true when the effective lifecycle profile is 'linked_ralph' */
export function isLinkedRalphProfile(
  config?: Pick<TeamConfig, 'lifecycle_profile'> | null,
  manifest?: Pick<TeamManifestV2, 'lifecycle_profile'> | null,
): boolean {
  return resolveLifecycleProfile(config, manifest) === 'linked_ralph';
}
