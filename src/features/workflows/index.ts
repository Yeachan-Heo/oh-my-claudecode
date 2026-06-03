/**
 * Dynamic Workflows Integration
 *
 * Opt-in, capability-detected, always-fallback routing of heavy parallel stages
 * to Claude Code native dynamic workflows. OMC remains the orchestrator.
 *
 * See docs/WORKFLOW-INTEGRATION.md and skills/workflow/SKILL.md.
 */

export type {
  ProviderLane,
  WorkflowDisabledBy,
  WorkflowsConfig,
  ResolvedWorkflowsConfig,
  WorkflowCapability,
  WorkflowRouteInput,
  WorkflowRouteDecision,
} from './types.js';

export {
  MIN_WORKFLOW_VERSION,
  ULTRACODE_KEYWORD_VERSION,
  compareWorkflowVersions,
  meetsMinimumVersion,
  detectWorkflowCapability,
  resolveDefaultTriggerKeyword,
  type DetectWorkflowCapabilityOptions,
} from './capability.js';

export {
  WORKFLOWS_DEFAULTS,
  countScopeSignals,
  resolveWorkflowsConfig,
  hasNativeWorkflowTrigger,
  buildWorkflowInvocation,
  shouldRouteToWorkflow,
} from './routing.js';

export {
  parseClaudeVersion,
  readClaudeCodeVersion,
  readWorkflowsDisabledSetting,
  resolveLiveWorkflowCapability,
  type ResolveLiveCapabilityOptions,
} from './environment.js';
