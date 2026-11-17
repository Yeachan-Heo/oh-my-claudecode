/**
 * Stage Router — /team per-role assignment resolver (Option E).
 *
 * Pure functions that map a canonical team role (+ user PluginConfig) to a
 * concrete RoleAssignment. `buildResolvedRoutingSnapshot` pre-resolves every
 * canonical role at team creation time so spawn / scaleUp / restart read
 * identical routing from `TeamConfig.resolved_routing` without re-resolving.
 *
 * Stickiness rule: the snapshot is IMMUTABLE for the team's lifetime.
 * Config edits mid-team-life do NOT change routing; user must create a new
 * team to pick up new routing. Enforced by runtime-v2 / scaling consumers.
 */
import type { CanonicalTeamRole, PluginConfig, RoleAssignment, TeamRoleAssignmentSpec } from '../shared/types.js';
/**
 * Alias-aware lookup for a `/team` role-routing entry.
 *
 * `validateTeamConfig()` accepts user-friendly aliases like `reviewer`, so the
 * resolver must honor those raw keys too even when callers hand-construct a
 * PluginConfig or when the merged config preserves the user's spelling.
 */
export declare function getRoleRoutingSpec(roleRouting: Record<string, TeamRoleAssignmentSpec | undefined> | undefined, role: string): TeamRoleAssignmentSpec | undefined;
/**
 * Pure resolver: (canonical role, PluginConfig) → concrete RoleAssignment.
 *
 * Resolution order:
 *   1. Normalize role via `normalizeDelegationRole` (handles aliases like
 *      "quality-reviewer" → "code-reviewer", "reviewer" → "code-reviewer").
 *   2. Read explicit spec from `cfg.team.roleRouting[role]` if present.
 *   3. Orchestrator: provider is always pinned to 'claude' (user cannot
 *      override, per Option E).
 *   4. Fill in defaults: provider='claude', model=role-default-tier,
 *      agent=canonical agent for the role.
 */
export declare function resolveRoleAssignment(role: CanonicalTeamRole, cfg: PluginConfig): RoleAssignment;
/**
 * Pre-resolve EVERY canonical role into a `{ primary, fallback }` pair.
 *
 * Fallback is always a Claude worker with the same model + agent as primary,
 * used when the primary provider's CLI binary is missing at spawn time
 * (AC-8). Persisted to `TeamConfig.resolved_routing` at team creation by
 * `startTeamV2`; read (never re-resolved) by spawn / scaleUp / restart paths.
 */
export declare function buildResolvedRoutingSnapshot(cfg: PluginConfig): Record<CanonicalTeamRole, {
    primary: RoleAssignment;
    fallback: RoleAssignment;
}>;
//# sourceMappingURL=stage-router.d.ts.map