/**
 * Canonical workflow registry and compatibility policy — epic #3698, issue #3703.
 *
 * Single source of truth for:
 *   - Tier-0 public workflows (exactly: plan, execute, review, verify)
 *   - Tier-0 public roles (exactly: planner, executor, reviewer, verifier)
 *   - the keep/merge/alias-deprecate/delete decision for every public skill
 *     and command, with canonical target, risk class, owner, warning, and
 *     removal milestone
 *   - the release maintainer-only boundary (`release` -> maintainer-only
 *     `omc release`; this epic performs no tag/publish/release mutation)
 *   - the structured alias retirement evidence policy
 *
 * This module builds on the merged #3706 alias resolver (alias-resolver.ts):
 * it reuses its Tier-0 constants, warning/telemetry/retirement machinery, and
 * exposes `registryAliasLookup` through the resolver's documented adapter seam
 * (`AliasRegistryLookup`). It does not re-implement resolution, warning
 * dedupe, or telemetry.
 *
 * Planning contract: docs/design/ISSUE-3698-LIGHTWEIGHT-WORKFLOW-PLAN.md
 * Rollback boundary: set OMC_WORKFLOW_REGISTRY=0 (or the legacy
 * OMC_ALIAS_RESOLVER_ENABLED=0); legacy keyword/skill resolution paths are
 * untouched by this module.
 */
import { type AliasRegistryLookup } from './alias-resolver.js';
import { RETIREMENT_POLICY } from '../alias-retirement/policy.js';
export declare const REGISTRY_SCHEMA_VERSION = 1;
export declare const REGISTRY_VERSION = "0.1.0";
/** Owning group per plan §4.1: maintainers of src/hooks/bridge.ts, skills/, commands/. */
export declare const REGISTRY_OWNER = "workflow-registry-maintainers";
export declare const TIER0_ROLES: readonly ["planner", "executor", "reviewer", "verifier"];
export type Tier0Role = (typeof TIER0_ROLES)[number];
export declare const RISK_CLASSES: readonly ["secrets-privacy", "destructive-mutation", "release-authority", "corruption-integrity", "security-boundary", "advisory"];
export type RiskClass = (typeof RISK_CLASSES)[number];
/** Only these classes fail closed. Everything else is advisory and fails open. */
export declare const HARD_RISK_CLASSES: readonly RiskClass[];
export type FailMode = 'fail-closed' | 'fail-open';
export declare function isHardRisk(riskClass: RiskClass): boolean;
export declare function failModeForRisk(riskClass: RiskClass): FailMode;
export { RETIREMENT_POLICY };
export type RetirementPolicy = typeof RETIREMENT_POLICY;
/** Human-readable milestone string attached to every removable alias. */
export declare const REMOVAL_MILESTONE = "\u22652 minor releases AND 90 days (whichever longer), \u226595% canonical-use share over 2 consecutive releases, zero known critical integrations";
export type SurfaceKind = 'skill' | 'command';
export type Decision = 'keep' | 'merge' | 'alias-deprecate' | 'delete';
export interface WorkflowEntry {
    readonly name: string;
    readonly kind: SurfaceKind;
    /** 0 for the four Tier-0 workflows only. */
    readonly tier?: 0;
    readonly decision: Decision;
    /**
     * Canonical resolution target for merge/alias-deprecate entries. Must
     * resolve (transitively) to a `keep` entry.
     */
    readonly canonicalTarget?: string;
    readonly riskClass: RiskClass;
    readonly owner: string;
    /** Maintainer-only authority; not a general public workflow (release boundary). */
    readonly maintainerOnly?: boolean;
    /** Internal/routable module; never a Tier-0 public workflow (specialists, lanes). */
    readonly internalOnly?: boolean;
    /** True when no installed file exists yet (defined target or legacy alias name). */
    readonly declaredOnly?: boolean;
    readonly removalMilestone?: string;
    readonly notes?: string;
}
export declare const WORKFLOW_ENTRIES: readonly WorkflowEntry[];
export interface RoleEntry {
    readonly name: string;
    readonly tier?: 0;
    /** Internal specialists stay routable but never become Tier-0 public roles. */
    readonly internalOnly?: boolean;
    /** Tier-0 role this specialist maps to. */
    readonly tier0Role?: Tier0Role;
    readonly owner: string;
}
export declare const WORKFLOW_ROLES: readonly RoleEntry[];
export declare function getEntry(name: string, kind: SurfaceKind): WorkflowEntry | undefined;
export declare function getRole(name: string): RoleEntry | undefined;
/**
 * Resolve a name to its canonical `keep` entry, following merge/alias chains.
 * Chained targets may live on either surface kind (e.g. command -> skill lane).
 * Returns undefined for unknown names or broken chains.
 */
export declare function resolveCanonical(name: string, kind: SurfaceKind): WorkflowEntry | undefined;
export declare function isRegistryEnabled(): boolean;
/**
 * `AliasRegistryLookup` implementation backed by this registry, for use with
 * `resolveWorkflowAliasViaRegistry` from the merged #3706 resolver.
 *
 * Only workflow-surface aliases are served here (aliases whose ultimate
 * canonical target is a Tier-0 workflow, an internal lane mapping to one, or
 * maintainer-only omc-release). Utility-to-utility aliases return undefined so
 * the resolver falls back to its own merged table. Returns undefined for every
 * name when the registry is disabled (rollback).
 */
export declare const registryAliasLookup: AliasRegistryLookup;
//# sourceMappingURL=registry.d.ts.map