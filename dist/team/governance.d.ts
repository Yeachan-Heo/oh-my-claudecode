import type { TeamConfig, TeamGovernance, TeamManifestV2, TeamPolicy, TeamTransportPolicy } from './types.js';
export declare const DEFAULT_TEAM_TRANSPORT_POLICY: TeamTransportPolicy;
export declare const DEFAULT_TEAM_GOVERNANCE: TeamGovernance;
type LegacyPolicyLike = Partial<TeamPolicy> & Partial<TeamTransportPolicy> & Partial<TeamGovernance>;
export declare function normalizeTeamTransportPolicy(policy?: LegacyPolicyLike | null): TeamTransportPolicy;
export declare function normalizeTeamGovernance(governance?: Partial<TeamGovernance> | null, legacyPolicy?: LegacyPolicyLike | null): TeamGovernance;
export declare function normalizeTeamManifest(manifest: TeamManifestV2): TeamManifestV2;
export declare function getConfigGovernance(config: TeamConfig | null | undefined): TeamGovernance;
export {};
//# sourceMappingURL=governance.d.ts.map