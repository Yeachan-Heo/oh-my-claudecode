import type { AgentConfig } from '../shared/types.js';
import { resolveLazyCodexClaudeRoleRoute, type LazyCodexClaudeRole } from '../interop/lazycodex-model-routing.js';
import { loadAgentPrompt } from './utils.js';

class LazyCodexAgentRouteConfigError extends Error {
  readonly role: LazyCodexClaudeRole;

  constructor(role: LazyCodexClaudeRole) {
    super(`Missing Claude model route for LazyCodex agent role: ${role}`);
    this.name = 'LazyCodexAgentRouteConfigError';
    this.role = role;
  }
}

function lazycodexModelClass(role: LazyCodexClaudeRole): string {
  const route = resolveLazyCodexClaudeRoleRoute(role);
  if (!route.ok) {
    throw new LazyCodexAgentRouteConfigError(role);
  }
  return route.route.modelFamily;
}

const LAZYCODEX_READ_ONLY_TOOLS = ['Read', 'Glob', 'Grep'];
const LAZYCODEX_REVIEW_TOOLS = ['Read', 'Glob', 'Grep', 'Bash'];
const LAZYCODEX_PLAN_TOOLS = ['Read', 'Glob', 'Grep', 'Bash', 'Write', 'TodoWrite'];
const LAZYCODEX_SOURCE_WRITE_TOOLS = ['Read', 'Glob', 'Grep', 'Edit', 'Write', 'Bash', 'TodoWrite'];
const LAZYCODEX_QA_TOOLS = ['Bash', 'Read', 'Grep', 'Glob', 'TodoWrite'];

export const lazycodexExplorerAgent: AgentConfig = {
  name: 'explorer',
  description: 'LazyCodex-compatible read-only codebase search specialist (Haiku).',
  prompt: loadAgentPrompt('explorer'),
  tools: LAZYCODEX_READ_ONLY_TOOLS,
  model: lazycodexModelClass('explorer'),
  defaultModel: lazycodexModelClass('explorer')
};

export const explorerAgent = lazycodexExplorerAgent;

export const lazycodexPlanAgent: AgentConfig = {
  name: 'plan',
  description: 'LazyCodex-compatible Prometheus planner for executable .lazycodex work plans (Opus).',
  prompt: loadAgentPrompt('plan'),
  tools: LAZYCODEX_PLAN_TOOLS,
  model: lazycodexModelClass('planner'),
  defaultModel: lazycodexModelClass('planner')
};

export const planAgent = lazycodexPlanAgent;

export const lazycodexExecutorAgent: AgentConfig = {
  name: 'lazycodex-executor',
  description: 'LazyCodex-compatible implementation executor with artifact-backed evidence discipline (Sonnet).',
  prompt: loadAgentPrompt('lazycodex-executor'),
  tools: LAZYCODEX_SOURCE_WRITE_TOOLS,
  model: lazycodexModelClass('executor'),
  defaultModel: lazycodexModelClass('executor')
};

export const lazycodexCodeReviewerAgent: AgentConfig = {
  name: 'lazycodex-code-reviewer',
  description: 'LazyCodex-compatible read-only code quality reviewer (Opus).',
  prompt: loadAgentPrompt('lazycodex-code-reviewer'),
  tools: LAZYCODEX_REVIEW_TOOLS,
  model: lazycodexModelClass('reviewer'),
  defaultModel: lazycodexModelClass('reviewer')
};

export const metisAgent: AgentConfig = {
  name: 'metis',
  description: 'LazyCodex-compatible pre-planning analyst for gaps, ambiguity, contradictions, and risks (Opus).',
  prompt: loadAgentPrompt('metis'),
  tools: LAZYCODEX_READ_ONLY_TOOLS,
  model: lazycodexModelClass('metis'),
  defaultModel: lazycodexModelClass('metis')
};

export const momusAgent: AgentConfig = {
  name: 'momus',
  description: 'LazyCodex-compatible read-only plan reviewer for executability and QA concreteness (Opus).',
  prompt: loadAgentPrompt('momus'),
  tools: LAZYCODEX_READ_ONLY_TOOLS,
  model: lazycodexModelClass('momus'),
  defaultModel: lazycodexModelClass('momus')
};

export const lazycodexQaExecutorAgent: AgentConfig = {
  name: 'lazycodex-qa-executor',
  description: 'LazyCodex-compatible manual QA executor for real scenario evidence (Sonnet).',
  prompt: loadAgentPrompt('lazycodex-qa-executor'),
  tools: LAZYCODEX_QA_TOOLS,
  model: lazycodexModelClass('verifier'),
  defaultModel: lazycodexModelClass('verifier')
};

export const lazycodexGateReviewerAgent: AgentConfig = {
  name: 'lazycodex-gate-reviewer',
  description: 'LazyCodex-compatible final gate reviewer for completion claims and artifacts (Opus).',
  prompt: loadAgentPrompt('lazycodex-gate-reviewer'),
  tools: LAZYCODEX_REVIEW_TOOLS,
  model: lazycodexModelClass('high-risk'),
  defaultModel: lazycodexModelClass('high-risk')
};

export const LAZYCODEX_COMPATIBLE_AGENT_DEFINITIONS = {
  explorer: lazycodexExplorerAgent,
  plan: lazycodexPlanAgent,
  'lazycodex-executor': lazycodexExecutorAgent,
  'lazycodex-code-reviewer': lazycodexCodeReviewerAgent,
  metis: metisAgent,
  momus: momusAgent,
  'lazycodex-qa-executor': lazycodexQaExecutorAgent,
  'lazycodex-gate-reviewer': lazycodexGateReviewerAgent,
} as const satisfies Record<string, AgentConfig>;
