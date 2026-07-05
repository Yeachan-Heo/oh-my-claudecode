import type { AgentConfig } from '../shared/types.js';
import { loadAgentPrompt } from './utils.js';

export const debuggerAgent: AgentConfig = {
  name: 'debugger',
  description: 'Root-cause analysis, regression isolation, failure diagnosis (Sonnet).',
  prompt: loadAgentPrompt('debugger'),
  model: 'sonnet',
  defaultModel: 'sonnet'
};

export const verifierAgent: AgentConfig = {
  name: 'verifier',
  description: 'Completion evidence, claim validation, test adequacy (Sonnet).',
  prompt: loadAgentPrompt('verifier'),
  model: 'sonnet',
  defaultModel: 'sonnet'
};

export const testEngineerAgent: AgentConfig = {
  name: 'test-engineer',
  description: 'Test strategy, coverage, flaky test hardening (Sonnet).',
  prompt: loadAgentPrompt('test-engineer'),
  model: 'sonnet',
  defaultModel: 'sonnet'
};

export const securityReviewerAgent: AgentConfig = {
  name: 'security-reviewer',
  description: 'Security vulnerability detection specialist (Sonnet). Use for security audits and OWASP detection.',
  prompt: loadAgentPrompt('security-reviewer'),
  model: 'sonnet',
  defaultModel: 'sonnet'
};

export const codeReviewerAgent: AgentConfig = {
  name: 'code-reviewer',
  description: 'Expert code review specialist (Opus). Use for comprehensive code quality review.',
  prompt: loadAgentPrompt('code-reviewer'),
  model: 'opus',
  defaultModel: 'opus'
};

export const gitMasterAgent: AgentConfig = {
  name: 'git-master',
  description: 'Git expert for atomic commits, rebasing, and history management with style detection',
  prompt: loadAgentPrompt('git-master'),
  model: 'sonnet',
  defaultModel: 'sonnet'
};

export const codeSimplifierAgent: AgentConfig = {
  name: 'code-simplifier',
  description: 'Simplifies and refines code for clarity, consistency, and maintainability (Opus).',
  prompt: loadAgentPrompt('code-simplifier'),
  model: 'opus',
  defaultModel: 'opus'
};

export const tddGuideAgentAlias = testEngineerAgent;
