import type { TeamConfig, TeamGovernance, TeamManifestV2, TeamPolicy, TeamTransportPolicy } from './types.js';
export type LifecycleProfile = 'default' | 'linked_ralph';
export declare const DEFAULT_TEAM_TRANSPORT_POLICY: TeamTransportPolicy;
export declare const DEFAULT_TEAM_GOVERNANCE: TeamGovernance;
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
export declare function resolveMaxWorkers(configured: number | undefined): number;
type LegacyPolicyLike = Partial<TeamPolicy> & Partial<TeamTransportPolicy> & Partial<TeamGovernance>;
export declare function normalizeTeamTransportPolicy(policy?: LegacyPolicyLike | null): TeamTransportPolicy;
export declare function normalizeTeamGovernance(governance?: Partial<TeamGovernance> | null, legacyPolicy?: LegacyPolicyLike | null): TeamGovernance;
export declare function normalizeTeamManifest(manifest: TeamManifestV2): TeamManifestV2;
export declare function getConfigGovernance(config: TeamConfig | null | undefined): TeamGovernance;
/**
 * Resolve the effective lifecycle profile for a team.
 * Manifest takes precedence over config; defaults to 'default'.
 */
export declare function resolveLifecycleProfile(config?: Pick<TeamConfig, 'lifecycle_profile'> | null, manifest?: Pick<TeamManifestV2, 'lifecycle_profile'> | null): LifecycleProfile;
/** Returns true when the effective lifecycle profile is 'linked_ralph' */
export declare function isLinkedRalphProfile(config?: Pick<TeamConfig, 'lifecycle_profile'> | null, manifest?: Pick<TeamManifestV2, 'lifecycle_profile'> | null): boolean;
export {};
//# sourceMappingURL=governance.d.ts.map