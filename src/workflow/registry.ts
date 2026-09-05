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

import {
  type Tier0Workflow,
  type AliasEntry,
  type AliasRegistryLookup,
} from './alias-resolver.js';
import { RETIREMENT_POLICY } from '../alias-retirement/policy.js';


export const REGISTRY_SCHEMA_VERSION = 1;
export const REGISTRY_VERSION = '0.1.0';

/** Owning group per plan §4.1: maintainers of src/hooks/bridge.ts, skills/, commands/. */
export const REGISTRY_OWNER = 'workflow-registry-maintainers';

// ---------------------------------------------------------------------------
// Tier-0 roles (owner decision 1)
// ---------------------------------------------------------------------------

export const TIER0_ROLES = ['planner', 'executor', 'reviewer', 'verifier'] as const;
export type Tier0Role = (typeof TIER0_ROLES)[number];

// ---------------------------------------------------------------------------
// Risk classes and gate policy (plan §5 / owner decision 6)
// ---------------------------------------------------------------------------

export const RISK_CLASSES = [
  'secrets-privacy',
  'destructive-mutation',
  'release-authority',
  'corruption-integrity',
  'security-boundary',
  'advisory',
] as const;
export type RiskClass = (typeof RISK_CLASSES)[number];

/** Only these classes fail closed. Everything else is advisory and fails open. */
export const HARD_RISK_CLASSES: readonly RiskClass[] = [
  'secrets-privacy',
  'destructive-mutation',
  'release-authority',
  'corruption-integrity',
  'security-boundary',
];

export type FailMode = 'fail-closed' | 'fail-open';

export function isHardRisk(riskClass: RiskClass): boolean {
  return HARD_RISK_CLASSES.includes(riskClass);
}

export function failModeForRisk(riskClass: RiskClass): FailMode {
  return isHardRisk(riskClass) ? 'fail-closed' : 'fail-open';
}

// ---------------------------------------------------------------------------
// Structured retirement evidence policy (owner decision 4)
// Re-exported from the canonical source in src/alias-retirement/policy.ts.
// ---------------------------------------------------------------------------

export { RETIREMENT_POLICY };

export type RetirementPolicy = typeof RETIREMENT_POLICY;

/** Human-readable milestone string attached to every removable alias. */
export const REMOVAL_MILESTONE =
  '≥2 minor releases AND 90 days (whichever longer), ≥95% canonical-use share over 2 consecutive releases, zero known critical integrations';

// ---------------------------------------------------------------------------
// Entries
// ---------------------------------------------------------------------------

export type SurfaceKind = 'skill' | 'command';

export type Decision =
  | 'keep' // canonical public surface with a unique contract
  | 'merge' // behavior moves to canonical target; name stays a bounded alias
  | 'alias-deprecate' // compatibility wrapper only; no second implementation
  | 'delete'; // ceremony-only; actual removal still gated by RETIREMENT_POLICY evidence

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

function entry(e: WorkflowEntry): WorkflowEntry {
  if (e.decision !== 'keep' && !e.canonicalTarget && e.decision !== 'delete') {
    throw new Error(`registry entry ${e.kind}:${e.name} is ${e.decision} without canonicalTarget`);
  }
  return e;
}

const ALIAS_MILESTONE = REMOVAL_MILESTONE;

// ---------------------------------------------------------------------------
// Skills — all 41 installed surfaces + defined Tier-0 targets + legacy alias
// names. Classification per plan §4.2 with the owner's authoritative Tier-0
// decision (plan/execute/review/verify; specialists remain internal).
// ---------------------------------------------------------------------------

const SKILL_ENTRIES: readonly WorkflowEntry[] = [
  // Tier-0 canonical workflows — owner direction for #3708: deep-interview and
  // ralplan remain independent Tier-0 workflow semantics; other duplicated
  // injection/procedure collapses behind the dispatcher. So Tier-0 is six.
  entry({ name: 'plan', kind: 'skill', tier: 0, decision: 'keep', riskClass: 'advisory', owner: REGISTRY_OWNER, notes: 'Canonical planning workflow.' }),
  entry({ name: 'deep-interview', kind: 'skill', tier: 0, decision: 'keep', riskClass: 'advisory', owner: REGISTRY_OWNER, notes: 'Independent Tier-0 requirements interview — not a plan alias (owner direction #3708).' }),
  entry({ name: 'ralplan', kind: 'skill', tier: 0, decision: 'keep', riskClass: 'advisory', owner: REGISTRY_OWNER, notes: 'Independent Tier-0 consensus planning — not a plan alias (owner direction #3708).' }),
  entry({ name: 'execute', kind: 'skill', tier: 0, decision: 'keep', riskClass: 'advisory', owner: REGISTRY_OWNER, notes: 'Absorbs ultrawork, ultrapilot, swarm, pipeline; autopilot, ralph, and ultragoal remain directly invocable.' }),
  entry({ name: 'review', kind: 'skill', tier: 0, decision: 'keep', riskClass: 'advisory', owner: REGISTRY_OWNER, notes: 'Absorbs review routing incl. the merge-readiness advisory lane. Installs as omc-review (native-command collision).' }),
  entry({ name: 'verify', kind: 'skill', tier: 0, decision: 'keep', riskClass: 'advisory', owner: REGISTRY_OWNER, notes: 'Absorbs ultraqa / verification routing.' }),

  // Internal lanes / optional modules (not Tier-0 public workflows)
  entry({ name: 'team', kind: 'skill', decision: 'keep', riskClass: 'advisory', owner: REGISTRY_OWNER, internalOnly: true, notes: 'Optional coordinated execution; an implementation detail of execute.' }),
  entry({ name: 'research', kind: 'skill', decision: 'keep', riskClass: 'advisory', owner: REGISTRY_OWNER, internalOnly: true, notes: 'Optional research lane absorbing deep-dive/sciomc/autoresearch.' }),

  // Retired in 5.0.0 under the major-version carve-out (policy.isMajorBoundaryRemoval).
  // The following skills were removed outright rather than kept as aliases:
  //   ultrawork, ultraqa, ultrapilot, swarm, pipeline,
  //   merge-readiness, deep-dive, sciomc, setup, mcp-setup, omc-reference,
  //   omc-teams, learner, writer-memory, ccg, local-build-reminder.
  // Their behavior lives in execute / verify / review / research / omc-setup /
  // wiki / remember / team. Owner direction: `autopilot`, `autoresearch`,
  // `ultragoal`, and `ralph` survive as directly-invocable workflows, so they
  // are `keep`.
  entry({ name: 'autopilot', kind: 'skill', decision: 'keep', riskClass: 'advisory', owner: REGISTRY_OWNER, notes: 'Retained as a directly-invocable end-to-end workflow alongside execute (owner direction, 5.0.0).' }),
  entry({ name: 'autoresearch', kind: 'skill', decision: 'keep', riskClass: 'advisory', owner: REGISTRY_OWNER, notes: 'Retained as its own research lane entrypoint alongside research (owner direction, 5.0.0).' }),
  entry({ name: 'ultragoal', kind: 'skill', decision: 'keep', riskClass: 'advisory', owner: REGISTRY_OWNER, notes: 'Retained as the durable multi-goal workflow with its own .omc/ultragoal artifacts (owner direction, 5.0.0).' }),
  entry({ name: 'ralph', kind: 'skill', decision: 'keep', riskClass: 'advisory', owner: REGISTRY_OWNER, notes: 'Retained: src/hooks/ralph is a live subsystem, `ralph` is a wired KeywordType and slash skill, and it is autopilot\'s verification engine (owner direction, 5.0.0).' }),

  // Release maintainer boundary (owner decision 2): compatibility alias to
  // maintainer-only `omc release`; fail-closed. Explicitly exempt from the
  // 5.0.0 retirement sweep — never auto-removed without owner approval.
  entry({ name: 'release', kind: 'skill', decision: 'alias-deprecate', canonicalTarget: 'omc-release', riskClass: 'release-authority', owner: REGISTRY_OWNER, maintainerOnly: true, removalMilestone: 'compatibility alias during migration; never auto-removed without owner approval' }),
  entry({ name: 'omc-release', kind: 'skill', decision: 'keep', riskClass: 'release-authority', owner: REGISTRY_OWNER, maintainerOnly: true, declaredOnly: true, notes: 'Maintainer-only release authority target; not a Tier-0 workflow.' }),

  // Kept utilities / opt-in tools
  entry({ name: 'cancel', kind: 'skill', decision: 'keep', riskClass: 'advisory', owner: REGISTRY_OWNER }),
  entry({ name: 'ask', kind: 'skill', decision: 'keep', riskClass: 'advisory', owner: REGISTRY_OWNER }),
  entry({ name: 'skill', kind: 'skill', decision: 'keep', riskClass: 'advisory', owner: REGISTRY_OWNER }),
  entry({ name: 'skillify', kind: 'skill', decision: 'keep', riskClass: 'advisory', owner: REGISTRY_OWNER, notes: 'Authoring utility, not a runtime workflow.' }),
  entry({ name: 'omc-setup', kind: 'skill', decision: 'keep', riskClass: 'advisory', owner: REGISTRY_OWNER }),
  entry({ name: 'omc-doctor', kind: 'skill', decision: 'keep', riskClass: 'advisory', owner: REGISTRY_OWNER }),
  entry({ name: 'wiki', kind: 'skill', decision: 'keep', riskClass: 'advisory', owner: REGISTRY_OWNER }),
  entry({ name: 'remember', kind: 'skill', decision: 'keep', riskClass: 'advisory', owner: REGISTRY_OWNER }),
  entry({ name: 'configure-notifications', kind: 'skill', decision: 'keep', riskClass: 'secrets-privacy', owner: REGISTRY_OWNER, notes: 'Opt-in integration handling secrets; hard boundary retained.' }),
  entry({ name: 'project-session-manager', kind: 'skill', decision: 'keep', riskClass: 'advisory', owner: REGISTRY_OWNER, notes: 'Utility only; workflow-gate behavior removed per plan.' }),
  entry({ name: 'ai-slop-cleaner', kind: 'skill', decision: 'keep', riskClass: 'advisory', owner: REGISTRY_OWNER, notes: 'Opt-in review tool; never a default gate.' }),
  entry({ name: 'minimal-code-discipline', kind: 'skill', decision: 'keep', riskClass: 'advisory', owner: REGISTRY_OWNER, notes: 'Opt-in writing-time discipline; never a default gate.' }),
  entry({ name: 'launch', kind: 'skill', decision: 'keep', riskClass: 'advisory', owner: REGISTRY_OWNER, notes: 'Opt-in governed delivery pipeline (spec -> tickets -> frontier); never a default gate.' }),
  entry({ name: 'ask-navigator', kind: 'skill', decision: 'keep', riskClass: 'advisory', owner: REGISTRY_OWNER, notes: 'Opt-in navigator: charts foggy efforts into decision-ticket maps; never a default gate, never builds.' }),
  entry({ name: 'loft', kind: 'skill', decision: 'keep', riskClass: 'advisory', owner: REGISTRY_OWNER, notes: 'Opt-in shape-before-steel discipline: throwaway artifacts answer design questions; never a default gate, never lands.' }),
  entry({ name: 'harbor', kind: 'skill', decision: 'keep', riskClass: 'advisory', owner: REGISTRY_OWNER, notes: 'Opt-in intake gate for external issues and PRs: verifies claims, drafts dispositions; never a default gate, never merges.' }),
  entry({ name: 'drydock', kind: 'skill', decision: 'keep', riskClass: 'advisory', owner: REGISTRY_OWNER, notes: 'Opt-in harness scaffold (shipyard keel); never a default gate.' }),
  entry({ name: 'visual-verdict', kind: 'skill', decision: 'keep', riskClass: 'advisory', owner: REGISTRY_OWNER, notes: 'Opt-in for visual surfaces.' }),
  entry({ name: 'external-context', kind: 'skill', decision: 'keep', riskClass: 'advisory', owner: REGISTRY_OWNER, notes: 'Opt-in external evidence tool.' }),
  entry({ name: 'graph', kind: 'skill', decision: 'keep', riskClass: 'security-boundary', owner: REGISTRY_OWNER, notes: 'Declarative graph runtime with command execution and bounded read-only Agent SDK execution; CLI + skill entrypoints.' }),
  entry({ name: 'debug', kind: 'skill', decision: 'keep', riskClass: 'advisory', owner: REGISTRY_OWNER }),
  entry({ name: 'deepinit', kind: 'skill', decision: 'keep', riskClass: 'advisory', owner: REGISTRY_OWNER }),
  entry({ name: 'hud', kind: 'skill', decision: 'keep', riskClass: 'advisory', owner: REGISTRY_OWNER }),
  entry({ name: 'self-improve', kind: 'skill', decision: 'keep', riskClass: 'advisory', owner: REGISTRY_OWNER, notes: 'Opt-in learning utility.' }),
  entry({ name: 'trace', kind: 'skill', decision: 'keep', riskClass: 'advisory', owner: REGISTRY_OWNER }),
];

// ---------------------------------------------------------------------------
// Commands — all 28 installed surfaces (plan §4.3)
// ---------------------------------------------------------------------------

const COMMAND_ENTRIES: readonly WorkflowEntry[] = [
  entry({ name: 'ask', kind: 'command', decision: 'keep', riskClass: 'advisory', owner: REGISTRY_OWNER }),
  entry({ name: 'compact', kind: 'command', decision: 'keep', riskClass: 'advisory', owner: REGISTRY_OWNER }),
  entry({ name: 'configure-notifications', kind: 'command', decision: 'keep', riskClass: 'secrets-privacy', owner: REGISTRY_OWNER }),
  entry({ name: 'debug', kind: 'command', decision: 'keep', riskClass: 'advisory', owner: REGISTRY_OWNER }),
  entry({ name: 'deepinit', kind: 'command', decision: 'keep', riskClass: 'advisory', owner: REGISTRY_OWNER }),
  entry({ name: 'external-context', kind: 'command', decision: 'keep', riskClass: 'advisory', owner: REGISTRY_OWNER }),
  entry({ name: 'hud', kind: 'command', decision: 'keep', riskClass: 'advisory', owner: REGISTRY_OWNER }),
  entry({ name: 'omc-doctor', kind: 'command', decision: 'keep', riskClass: 'advisory', owner: REGISTRY_OWNER }),
  entry({ name: 'omc-setup', kind: 'command', decision: 'keep', riskClass: 'advisory', owner: REGISTRY_OWNER }),
  entry({ name: 'project-session-manager', kind: 'command', decision: 'keep', riskClass: 'advisory', owner: REGISTRY_OWNER }),
  entry({ name: 'remember', kind: 'command', decision: 'keep', riskClass: 'advisory', owner: REGISTRY_OWNER }),
  entry({ name: 'self-improve', kind: 'command', decision: 'keep', riskClass: 'advisory', owner: REGISTRY_OWNER }),
  entry({ name: 'skill', kind: 'command', decision: 'keep', riskClass: 'advisory', owner: REGISTRY_OWNER }),
  entry({ name: 'skillify', kind: 'command', decision: 'keep', riskClass: 'advisory', owner: REGISTRY_OWNER }),
  entry({ name: 'trace', kind: 'command', decision: 'keep', riskClass: 'advisory', owner: REGISTRY_OWNER }),
  entry({ name: 'visual-verdict', kind: 'command', decision: 'keep', riskClass: 'advisory', owner: REGISTRY_OWNER }),
  entry({ name: 'wiki', kind: 'command', decision: 'keep', riskClass: 'advisory', owner: REGISTRY_OWNER }),
  entry({ name: 'verify', kind: 'command', decision: 'keep', riskClass: 'advisory', owner: REGISTRY_OWNER, notes: 'Command form of the Tier-0 verify workflow.' }),
  entry({ name: 'autoresearch', kind: 'command', decision: 'keep', riskClass: 'advisory', owner: REGISTRY_OWNER, notes: 'Retained alongside the research lane (owner direction, 5.0.0).' }),
  // Retired in 5.0.0: ccg, deep-dive, learner, mcp-setup, omc-teams, sciomc,
  // writer-memory command files were removed with their skills.
  entry({ name: 'psm', kind: 'command', decision: 'alias-deprecate', canonicalTarget: 'project-session-manager', riskClass: 'advisory', owner: REGISTRY_OWNER, removalMilestone: 'short-name convenience alias; retained by owner direction' }),
  entry({ name: 'release', kind: 'command', decision: 'alias-deprecate', canonicalTarget: 'omc-release', riskClass: 'release-authority', owner: REGISTRY_OWNER, maintainerOnly: true, removalMilestone: 'compatibility alias during migration; never auto-removed without owner approval' }),
];

export const WORKFLOW_ENTRIES: readonly WorkflowEntry[] = [...SKILL_ENTRIES, ...COMMAND_ENTRIES];

// ---------------------------------------------------------------------------
// Roles — Tier-0 public roles + internal specialists (plan §4.2, §7)
// ---------------------------------------------------------------------------

export interface RoleEntry {
  readonly name: string;
  readonly tier?: 0;
  /** Internal specialists stay routable but never become Tier-0 public roles. */
  readonly internalOnly?: boolean;
  /** Tier-0 role this specialist maps to. */
  readonly tier0Role?: Tier0Role;
  readonly owner: string;
}

export const WORKFLOW_ROLES: readonly RoleEntry[] = [
  { name: 'planner', tier: 0, owner: REGISTRY_OWNER },
  { name: 'executor', tier: 0, owner: REGISTRY_OWNER },
  { name: 'reviewer', tier: 0, owner: REGISTRY_OWNER },
  { name: 'verifier', tier: 0, owner: REGISTRY_OWNER },
  // Internal specialists (current src/agents/definitions.ts keys minus Tier-0)
  { name: 'analyst', internalOnly: true, tier0Role: 'planner', owner: REGISTRY_OWNER },
  { name: 'architect', internalOnly: true, tier0Role: 'reviewer', owner: REGISTRY_OWNER },
  { name: 'critic', internalOnly: true, tier0Role: 'reviewer', owner: REGISTRY_OWNER },
  { name: 'code-reviewer', internalOnly: true, tier0Role: 'reviewer', owner: REGISTRY_OWNER },
  { name: 'security-reviewer', internalOnly: true, tier0Role: 'reviewer', owner: REGISTRY_OWNER },
  { name: 'test-engineer', internalOnly: true, tier0Role: 'verifier', owner: REGISTRY_OWNER },
  { name: 'qa-tester', internalOnly: true, tier0Role: 'verifier', owner: REGISTRY_OWNER },
  { name: 'debugger', internalOnly: true, tier0Role: 'executor', owner: REGISTRY_OWNER },
  { name: 'explore', internalOnly: true, tier0Role: 'executor', owner: REGISTRY_OWNER },
  { name: 'designer', internalOnly: true, tier0Role: 'executor', owner: REGISTRY_OWNER },
  { name: 'writer', internalOnly: true, tier0Role: 'executor', owner: REGISTRY_OWNER },
  { name: 'scientist', internalOnly: true, tier0Role: 'executor', owner: REGISTRY_OWNER },
  { name: 'tracer', internalOnly: true, tier0Role: 'verifier', owner: REGISTRY_OWNER },
  { name: 'git-master', internalOnly: true, tier0Role: 'executor', owner: REGISTRY_OWNER },
  { name: 'code-simplifier', internalOnly: true, tier0Role: 'executor', owner: REGISTRY_OWNER },
  { name: 'document-specialist', internalOnly: true, tier0Role: 'executor', owner: REGISTRY_OWNER },
];

// ---------------------------------------------------------------------------
// Lookup helpers
// ---------------------------------------------------------------------------

const BY_KEY = new Map<string, WorkflowEntry>(
  WORKFLOW_ENTRIES.map((e) => [`${e.kind}:${e.name}`, e]),
);

export function getEntry(name: string, kind: SurfaceKind): WorkflowEntry | undefined {
  return BY_KEY.get(`${kind}:${name}`);
}

export function getRole(name: string): RoleEntry | undefined {
  return WORKFLOW_ROLES.find((r) => r.name === name);
}

/**
 * Resolve a name to its canonical `keep` entry, following merge/alias chains.
 * Chained targets may live on either surface kind (e.g. command -> skill lane).
 * Returns undefined for unknown names or broken chains.
 */
export function resolveCanonical(name: string, kind: SurfaceKind): WorkflowEntry | undefined {
  let current = getEntry(name, kind);
  const seen = new Set<string>([`${kind}:${name}`]);
  while (current && current.decision !== 'keep') {
    if (!current.canonicalTarget) return undefined;
    // Prefer same-kind target; a self-referential target (e.g. command
    // `verify` -> `verify`) falls through to the skill lane of the same name.
    const sameKind = getEntry(current.canonicalTarget, kind);
    const next =
      (sameKind !== current ? sameKind : undefined) ??
      getEntry(current.canonicalTarget, kind === 'skill' ? 'command' : 'skill');
    if (!next || seen.has(`${next.kind}:${next.name}`)) return undefined;
    seen.add(`${next.kind}:${next.name}`);
    current = next;
  }
  return current;
}

// ---------------------------------------------------------------------------
// Registry feature flag (rollback: registry disabled while legacy resolver remains)
// ---------------------------------------------------------------------------

export function isRegistryEnabled(): boolean {
  const env = process.env.OMC_WORKFLOW_REGISTRY;
  if (env !== undefined) {
    const v = env.trim().toLowerCase();
    if (v === '0' || v === 'false' || v === 'off' || v === 'disabled') return false;
    if (v === '1' || v === 'true' || v === 'on' || v === 'enabled') return true;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Adapter into the merged #3706 resolver seam
// ---------------------------------------------------------------------------

/** Internal lanes and their Tier-0 workflow for adapter mapping. */
const LANE_TIER0: Record<string, Tier0Workflow> = {
  team: 'execute',
  research: 'plan',
};

function tier0For(entry0: WorkflowEntry, canonical: WorkflowEntry): Tier0Workflow | undefined {
  if (canonical.tier === 0) return canonical.name as Tier0Workflow;
  return LANE_TIER0[canonical.name];
}

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
export const registryAliasLookup: AliasRegistryLookup = (normalized: string) => {
  if (!isRegistryEnabled()) return undefined;
  const e = getEntry(normalized, 'skill') ?? getEntry(normalized, 'command');
  if (!e || e.decision === 'keep' || e.decision === 'delete') return undefined;
  const canonical = resolveCanonical(e.name, e.kind);
  if (!canonical) return undefined;

  let target: AliasEntry['canonical'];
  let tier0: Tier0Workflow | undefined;
  if (canonical.maintainerOnly && canonical.name === 'omc-release') {
    target = 'omc-release';
    tier0 = undefined;
  } else {
    const t = tier0For(e, canonical);
    if (!t) return undefined; // utility-to-utility alias: resolver's own table handles it
    target = t;
    tier0 = t;
  }

  return {
    alias: e.name,
    canonical: target,
    tier0,
    owner: e.owner,
    description: e.notes ?? `${e.decision} -> ${canonical.name}`,
    removalMilestone: e.removalMilestone ?? ALIAS_MILESTONE,
    isWorkflowAlias: true,
  };
};

