/**
 * Dynamic Workflows Integration — Types
 *
 * OMC stays the orchestrator ("conductor") and may hand a single heavy,
 * highly-parallel stage *down* to a Claude Code native dynamic workflow as one
 * execution backend. This is an OPT-IN, CAPABILITY-DETECTED, ALWAYS-FALLBACK
 * path — never a hard dependency.
 *
 * Workflows are a Claude Code feature (research preview). OMC cannot drive the
 * workflow runtime programmatically; it triggers a workflow the supported way
 * (a natural-language "use a dynamic workflow" request, the `ultracode`
 * keyword, or a saved `/command`) and lets Claude Code author the script.
 *
 * Docs: https://code.claude.com/docs/en/workflows
 */

/** Provider lane the current task is running under. Workflows are Claude-only. */
export type ProviderLane = 'claude' | 'codex' | 'gemini';

/** Why workflows are unavailable, if they are. */
export type WorkflowDisabledBy = 'env' | 'settings' | 'version' | null;

/**
 * User-facing config block. Lives under `workflows` in `.claude/omc.jsonc`
 * (and via `OMC_WORKFLOWS_*` env vars). All fields optional; see
 * WORKFLOWS_DEFAULTS for the resolved defaults.
 */
export interface WorkflowsConfig {
  /** Master opt-in. Default: false. OMC never routes to workflows unless true. */
  enabled?: boolean;
  /**
   * Allow routing while OMC runs non-interactively (`claude -p`, Agent SDK,
   * bypass-permissions). Off by default because workflow subagents run in
   * acceptEdits mode with no approval prompt in those contexts. Default: false.
   */
  allowInHeadless?: boolean;
  /**
   * Allow a workflow to be launched while an OMC fan-out mode (ultrawork/team)
   * is already active. Off by default to prevent nested orchestration /
   * runaway token use. Default: false.
   */
  allowNesting?: boolean;
  /**
   * How many heavy-scope signals a task must contain before OMC routes it to a
   * workflow (e.g. "every", "across the whole codebase", "migrate", "audit").
   * Default: 1.
   */
  minScopeSignals?: number;
  /**
   * Optional explicit trigger keyword to prefix the invocation with
   * (e.g. 'ultracode'). When unset, OMC uses a version-proof natural-language
   * request, which Claude Code treats as the same opt-in on every version.
   */
  triggerKeyword?: string;
}

/** WorkflowsConfig with every field resolved. */
export type ResolvedWorkflowsConfig = Required<Omit<WorkflowsConfig, 'triggerKeyword'>> &
  Pick<WorkflowsConfig, 'triggerKeyword'>;

/** Result of probing whether dynamic workflows are usable in this environment. */
export interface WorkflowCapability {
  /** True only when a new-enough Claude Code is present and not disabled. */
  available: boolean;
  /** Detected Claude Code version string, or null if unknown. */
  version: string | null;
  /** Whether `version` satisfies the minimum required by the feature. */
  meetsMinVersion: boolean;
  /** What turned workflows off, if anything. */
  disabledBy: WorkflowDisabledBy;
  /** Human-readable explanation (surfaced in logs / HUD). */
  reason: string;
}

/** Inputs to the routing decision. */
export interface WorkflowRouteInput {
  /** The task / stage description OMC is about to execute. */
  task: string;
  /** Resolved workflows config. */
  config: ResolvedWorkflowsConfig;
  /** Capability probe result. */
  capability: WorkflowCapability;
  /** OMC modes already active this turn (e.g. ['ultrawork'], ['team']). */
  activeModes?: string[];
  /** Provider lane for the current work. Defaults to 'claude'. */
  providerLane?: ProviderLane;
  /** True under `claude -p` / Agent SDK / bypass-permissions. */
  headless?: boolean;
}

/** Outcome of the routing decision. Fallback is ALWAYS OMC orchestration. */
export interface WorkflowRouteDecision {
  /** True => surface `invocation` to Claude; false => keep OMC orchestration. */
  route: boolean;
  /** Why this decision was made. */
  reason: string;
  /** The lane OMC falls back to when not routing. */
  fallback: 'omc-orchestration';
  /** Prompt to trigger a native workflow. Present only when route === true. */
  invocation?: string;
}
