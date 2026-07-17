import type { TeamConfig, TeamManifestV2 } from './types.js';
export type TeamStateSource = 'absent' | 'legacy' | 'revisioned' | 'malformed' | 'io_error';
export type TeamStateClassification = 'absent' | 'legacy_merged' | 'config_authoritative' | 'manifest_only_legacy' | 'invalid_config' | 'io_error';
export interface RawTeamState<T> {
    source: TeamStateSource;
    value: T | null;
    error?: string;
}
export interface TeamStateSnapshot {
    classification: TeamStateClassification;
    config: RawTeamState<TeamConfig>;
    manifest: RawTeamState<TeamManifestV2>;
    /** Safe reader view. Revisioned config fields always win. */
    state: TeamConfig | TeamManifestV2 | null;
    manifestSync: 'synced' | 'repair_required';
}
/**
 * Read config and manifest independently. Once config carries a numeric revision it is the
 * authority even if the projection is stale, malformed, or unavailable.
 */
export declare function readTeamState(cwd: string, teamName: string): TeamStateSnapshot;
/** Build the projection shape from authoritative configuration without reading a stale manifest. */
export declare function deriveManifestProjection(config: TeamConfig, existing?: TeamManifestV2 | null): TeamManifestV2;
//# sourceMappingURL=team-state-reader.d.ts.map