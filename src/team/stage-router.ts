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

import type {
  CanonicalTeamRole,
  KnownAgentName,
  PluginConfig,
  RoleAssignment,
  TeamRoleAssignmentSpec,
  TeamRoleProvider,
  TeamRoleTier,
} from '../shared/types.js';
import { CANONICAL_TEAM_ROLES } from '../shared/types.js';
import { normalizeDelegationRole } from '../features/delegation-routing/types.js';
import {
  BUILTIN_EXTERNAL_MODEL_DEFAULTS,
  getDefaultTierModels,
} from '../config/models.js';

/** Map canonical team role → KnownAgentName key (matches PluginConfig.agents.*). */
const ROLE_TO_AGENT: Record<CanonicalTeamRole, KnownAgentName> = {
  orchestrator: 'omc',
  planner: 'planner',
  analyst: 'analyst',
  architect: 'architect',
  executor: 'executor',
  debugger: 'debugger',
  critic: 'critic',
  'code-reviewer': 'codeReviewer',
  'security-reviewer': 'securityReviewer',
  'test-engineer': 'testEngineer',
  designer: 'designer',
  writer: 'writer',
  'code-simplifier': 'codeSimplifier',
  explore: 'explore',
  'document-specialist': 'documentSpecialist',
};

/** Default model tier per canonical role (mirrors buildDefaultConfig().agents tiers). */
const ROLE_DEFAULT_TIER: Record<CanonicalTeamRole, TeamRoleTier> = {
  orchestrator: 'HIGH',
  planner: 'HIGH',
  analyst: 'HIGH',
  architect: 'HIGH',
  executor: 'MEDIUM',
  debugger: 'MEDIUM',
  critic: 'HIGH',
  'code-reviewer': 'HIGH',
  'security-reviewer': 'MEDIUM',
  'test-engineer': 'MEDIUM',
  designer: 'MEDIUM',
  writer: 'LOW',
  'code-simplifier': 'HIGH',
  explore: 'LOW',
  'document-specialist': 'MEDIUM',
};

const TIER_SET: ReadonlySet<string> = new Set<TeamRoleTier>(['HIGH', 'MEDIUM', 'LOW']);

function isTier(value: string): value is TeamRoleTier {
  return TIER_SET.has(value);
}

/**
 * Alias-aware lookup for a `/team` role-routing entry.
 *
 * `validateTeamConfig()` accepts user-friendly aliases like `reviewer`, so the
 * resolver must honor those raw keys too even when callers hand-construct a
 * PluginConfig or when the merged config preserves the user's spelling.
 */
export function getRoleRoutingSpec(
  roleRouting: Record<string, TeamRoleAssignmentSpec | undefined> | undefined,
  role: string,
): TeamRoleAssignmentSpec | undefined {
  if (!roleRouting) return undefined;

  const normalizedRole = normalizeDelegationRole(role);
  const direct = roleRouting[normalizedRole];
  if (direct) return direct;

  for (const [rawRole, spec] of Object.entries(roleRouting)) {
    if (spec && normalizeDelegationRole(rawRole) === normalizedRole) {
      return spec;
    }
  }

  return undefined;
}

/**
 * Resolve a tier name to an explicit model ID using (in precedence order):
 * 1. `cfg.routing.tierModels[tier]`
 * 2. env-derived defaults via `getDefaultTierModels()`
 */
function resolveTierToModelId(tier: TeamRoleTier, cfg: PluginConfig): string {
  const fromCfg = cfg.routing?.tierModels?.[tier];
  if (typeof fromCfg === 'string' && fromCfg.length > 0) return fromCfg;
  return getDefaultTierModels()[tier];
}

/**
 * Resolve a user-supplied `model` value for a Claude worker.
 * Tier names expand to model IDs; explicit IDs pass through;
 * undefined falls back to the role's default tier.
 */
function resolveClaudeModel(
  role: CanonicalTeamRole,
  raw: string | undefined,
  cfg: PluginConfig,
): string {
  if (typeof raw === 'string' && raw.length > 0) {
    return isTier(raw) ? resolveTierToModelId(raw, cfg) : raw;
  }
  return resolveTierToModelId(ROLE_DEFAULT_TIER[role], cfg);
}

/**
 * Resolve a user-supplied `model` value for an external provider worker.
 *
 * Tier names are Claude-centric and not meaningful for codex/gemini, so tier
 * input (or absent input) maps to the provider's builtin default. Only an
 * explicit non-tier model ID is passed through.
 */
function resolveExternalModel(
  provider: 'codex' | 'gemini',
  raw: string | undefined,
  cfg: PluginConfig,
): string {
  if (typeof raw === 'string' && raw.length > 0 && !isTier(raw)) {
    return raw;
  }
  const defaults = cfg.externalModels?.defaults;
  if (provider === 'codex') {
    return defaults?.codexModel ?? BUILTIN_EXTERNAL_MODEL_DEFAULTS.codexModel;
  }
  return defaults?.geminiModel ?? BUILTIN_EXTERNAL_MODEL_DEFAULTS.geminiModel;
}

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
export function resolveRoleAssignment(
  role: CanonicalTeamRole,
  cfg: PluginConfig,
): RoleAssignment {
  const normalized = normalizeDelegationRole(role) as CanonicalTeamRole;
  const canonical: CanonicalTeamRole = isCanonicalRole(normalized) ? normalized : role;

  const roleRouting = cfg.team?.roleRouting as
    | Record<string, TeamRoleAssignmentSpec | undefined>
    | undefined;
  const spec = getRoleRoutingSpec(roleRouting, canonical);

  const isOrchestrator = canonical === 'orchestrator';
  const provider: TeamRoleProvider = isOrchestrator
    ? 'claude'
    : (spec?.provider ?? 'claude');

  const model = provider === 'claude'
    ? resolveClaudeModel(canonical, spec?.model, cfg)
    : resolveExternalModel(provider, spec?.model, cfg);
  const agent: KnownAgentName = spec?.agent ?? ROLE_TO_AGENT[canonical];

  return { provider, model, agent };
}

function isCanonicalRole(value: string): value is CanonicalTeamRole {
  return (CANONICAL_TEAM_ROLES as readonly string[]).includes(value);
}

/**
 * Pre-resolve EVERY canonical role into a `{ primary, fallback }` pair.
 *
 * Fallback is always a Claude worker with the same model + agent as primary,
 * used when the primary provider's CLI binary is missing at spawn time
 * (AC-8). Persisted to `TeamConfig.resolved_routing` at team creation by
 * `startTeamV2`; read (never re-resolved) by spawn / scaleUp / restart paths.
 */
export function buildResolvedRoutingSnapshot(
  cfg: PluginConfig,
): Record<CanonicalTeamRole, { primary: RoleAssignment; fallback: RoleAssignment }> {
  const out = {} as Record<CanonicalTeamRole, { primary: RoleAssignment; fallback: RoleAssignment }>;
  const roleRouting = cfg.team?.roleRouting as
    | Record<string, TeamRoleAssignmentSpec | undefined>
    | undefined;

  for (const role of CANONICAL_TEAM_ROLES) {
    const primary = resolveRoleAssignment(role, cfg);
    // Fallback is always a Claude worker. Its model is the Claude-tier
    // resolution of the role's spec (so tier stickiness survives fallback),
    // NOT primary.model (which may be a codex/gemini model ID).
    // When primary is external and spec.model is an explicit non-tier id
    // (e.g., 'gpt-5.3-codex'), drop it for fallback so claude doesn't
    // receive an external model id; tier names always survive.
    const spec = getRoleRoutingSpec(roleRouting, role);
    const isExternalPrimary = primary.provider !== 'claude';
    const fallbackModelInput = isExternalPrimary && spec?.model && !isTier(spec.model)
      ? undefined
      : spec?.model;
    const fallback: RoleAssignment = {
      provider: 'claude',
      model: resolveClaudeModel(role, fallbackModelInput, cfg),
      agent: primary.agent,
    };
    out[role] = { primary, fallback };
  }
  return out;
}
