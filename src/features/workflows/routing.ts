/**
 * Dynamic Workflows Integration — Routing
 *
 * Decides whether OMC should hand the current heavy stage down to a Claude Code
 * native dynamic workflow, and if so, builds the (supported, conversational)
 * invocation to surface to Claude. Every path that does NOT route falls back to
 * OMC's existing orchestration — workflows are never a hard dependency.
 *
 * Gate order (any failing gate => keep OMC orchestration):
 *   1. Feature opted in (config.enabled)
 *   2. Capability available (new-enough Claude Code, not disabled)
 *   3. Claude provider lane (workflows are Claude-only; codex/gemini excluded)
 *   4. Not nested inside an active OMC fan-out mode (unless allowNesting)
 *   5. Not headless, OR headless explicitly allowed (acceptEdits safety gate)
 *   6. Task is heavy/parallel enough (>= minScopeSignals scope signals)
 */

import type {
  ResolvedWorkflowsConfig,
  WorkflowRouteDecision,
  WorkflowRouteInput,
  WorkflowsConfig,
} from './types.js';

/** Resolved defaults: opt-in OFF, conservative safety gates. */
export const WORKFLOWS_DEFAULTS: ResolvedWorkflowsConfig = {
  enabled: false,
  allowInHeadless: false,
  allowNesting: false,
  minScopeSignals: 1,
  triggerKeyword: undefined,
};

/** OMC fan-out modes that already own parallel orchestration. */
const FANOUT_MODES = ['ultrawork', 'ulw', 'team', 'autopilot', 'ralph'];

/**
 * Signals that a task is large/parallel enough to be worth a workflow's extra
 * token cost. Kept deliberately conservative — borderline tasks stay in OMC.
 */
const SCOPE_SIGNAL_PATTERNS: RegExp[] = [
  /\bevery\b/i,
  /\ball (?:the )?(?:files|endpoints|modules|routes|tests|callers|usages)\b/i,
  /\bentire\b/i,
  /\b(?:whole|across the (?:whole |entire )?)(?:codebase|repo|repository|service|project)\b/i,
  /\b(?:codebase|repo|repository)-wide\b/i,
  /\bhundreds of\b/i,
  /\bthousands of\b/i,
  /\b\d{2,}\s+files\b/i,
  /\bmigrat(?:e|ion|ing)\b/i,
  /\baudit\b/i,
  /\bsweep\b/i,
  /\bport(?:ing)?\s+(?:from|to)\b/i,
  /\bdeprecat(?:e|ion|ing)\b/i,
];

const CODE_BLOCK_PATTERN = /```[\s\S]*?```/g;
const INLINE_CODE_PATTERN = /`[^`]+`/g;

function stripCode(text: string): string {
  return text.replace(CODE_BLOCK_PATTERN, '').replace(INLINE_CODE_PATTERN, '');
}

/** Count how many distinct scope signals appear in a task description. */
export function countScopeSignals(task: string): number {
  const clean = stripCode(task);
  let count = 0;
  for (const pattern of SCOPE_SIGNAL_PATTERNS) {
    if (pattern.test(clean)) count += 1;
  }
  return count;
}

/** Merge a partial WorkflowsConfig (from omc.jsonc / env) over the defaults. */
export function resolveWorkflowsConfig(config?: WorkflowsConfig): ResolvedWorkflowsConfig {
  return {
    enabled: config?.enabled ?? WORKFLOWS_DEFAULTS.enabled,
    allowInHeadless: config?.allowInHeadless ?? WORKFLOWS_DEFAULTS.allowInHeadless,
    allowNesting: config?.allowNesting ?? WORKFLOWS_DEFAULTS.allowNesting,
    minScopeSignals: config?.minScopeSignals ?? WORKFLOWS_DEFAULTS.minScopeSignals,
    triggerKeyword: config?.triggerKeyword ?? WORKFLOWS_DEFAULTS.triggerKeyword,
  };
}

const NATIVE_WORKFLOW_TRIGGERS = ['ultracode', 'workflow'];

/**
 * Whether the user's prompt already contains a native workflow trigger
 * (`ultracode` / `workflow`). OMC's keyword detector should call this and
 * SUPPRESS its own ultrawork/team auto-activation when true, so the two
 * systems don't both try to take over the same task.
 */
export function hasNativeWorkflowTrigger(prompt: string): boolean {
  const clean = stripCode(prompt);
  return NATIVE_WORKFLOW_TRIGGERS.some((trigger) =>
    new RegExp(`\\b${trigger}\\b`, 'i').test(clean),
  );
}

/**
 * Build the conversational instruction OMC surfaces to Claude to launch a
 * native workflow. Defaults to a version-proof natural-language request
 * (treated as the same opt-in on every Claude Code version). If a
 * triggerKeyword is configured, it is prefixed.
 */
export function buildWorkflowInvocation(task: string, config: ResolvedWorkflowsConfig): string {
  const base = `Use a Claude Code dynamic workflow to handle this end-to-end: ${task.trim()}`;
  if (config.triggerKeyword) {
    return `${config.triggerKeyword}: ${base}`;
  }
  return base;
}

/**
 * Decide whether to route the current stage to a native dynamic workflow.
 * Fallback is ALWAYS OMC orchestration.
 */
export function shouldRouteToWorkflow(input: WorkflowRouteInput): WorkflowRouteDecision {
  const { task, config, capability } = input;
  const providerLane = input.providerLane ?? 'claude';
  const activeModes = input.activeModes ?? [];
  const headless = input.headless ?? false;

  const noRoute = (reason: string): WorkflowRouteDecision => ({
    route: false,
    reason,
    fallback: 'omc-orchestration',
  });

  // 1. Opt-in
  if (!config.enabled) {
    return noRoute('Workflow routing is opt-in and not enabled (workflows.enabled=false).');
  }

  // 2. Capability
  if (!capability.available) {
    return noRoute(`Workflows unavailable: ${capability.reason}`);
  }

  // 3. Claude-only
  if (providerLane !== 'claude') {
    return noRoute(`Dynamic workflows are Claude-only; current lane is "${providerLane}".`);
  }

  // 4. No nesting inside an active fan-out mode
  if (!config.allowNesting) {
    const nested = activeModes
      .map((m) => m.toLowerCase())
      .find((m) => FANOUT_MODES.includes(m));
    if (nested) {
      return noRoute(
        `Refusing to nest a workflow inside active OMC mode "${nested}" (set workflows.allowNesting=true to override).`,
      );
    }
  }

  // 5. Headless safety gate (workflow subagents auto-approve edits with no prompt)
  if (headless && !config.allowInHeadless) {
    return noRoute(
      'Headless/SDK/bypass context: workflow subagents auto-approve edits with no prompt; ' +
        'set workflows.allowInHeadless=true to opt in.',
    );
  }

  // 6. Heavy/parallel enough to be worth the cost
  const signals = countScopeSignals(task);
  if (signals < config.minScopeSignals) {
    return noRoute(
      `Task scope below threshold (${signals} < ${config.minScopeSignals} scope signals); ` +
        'keeping OMC orchestration.',
    );
  }

  return {
    route: true,
    reason: `Routing to a dynamic workflow (${signals} scope signal(s), capability OK).`,
    fallback: 'omc-orchestration',
    invocation: buildWorkflowInvocation(task, config),
  };
}
