import type { PluginConfig } from '../shared/types.js';

const AGENT_CONFIG_KEY_MAP = {
  explore: 'explore',
  analyst: 'analyst',
  planner: 'planner',
  architect: 'architect',
  debugger: 'debugger',
  executor: 'executor',
  verifier: 'verifier',
  'security-reviewer': 'securityReviewer',
  'code-reviewer': 'codeReviewer',
  'test-engineer': 'testEngineer',
  designer: 'designer',
  writer: 'writer',
  'qa-tester': 'qaTester',
  scientist: 'scientist',
  tracer: 'tracer',
  'git-master': 'gitMaster',
  'code-simplifier': 'codeSimplifier',
  critic: 'critic',
  'document-specialist': 'documentSpecialist',
} as const satisfies Partial<Record<string, keyof NonNullable<PluginConfig['agents']>>>;

export function getConfiguredAgentModel(name: string, config: PluginConfig): string | undefined {
  const key = AGENT_CONFIG_KEY_MAP[name as keyof typeof AGENT_CONFIG_KEY_MAP];
  return key ? config.agents?.[key]?.model : undefined;
}
