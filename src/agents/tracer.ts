/**
 * Tracer Agent - Evidence-Driven Causal Tracing
 *
 * Specialized agent for explaining observed outcomes through competing
 * hypotheses, evidence collection, uncertainty tracking, and next-probe
 * recommendations.
 */

import type { AgentConfig, AgentPromptMetadata } from './types.js';
import { loadAgentPrompt } from './utils.js';

export const TRACER_PROMPT_METADATA: AgentPromptMetadata = {
  category: 'advisor',
  cost: 'EXPENSIVE',
  promptAlias: 'tracer',
  triggers: [
    { domain: 'Causal tracing', trigger: 'Why did this happen? Which explanation best fits the evidence?' },
    { domain: 'Forensic analysis', trigger: 'Observed output, artifact, or behavior needs ranked explanations' },
    { domain: 'Evidence-driven uncertainty reduction', trigger: 'Need competing hypotheses and the next best probe' },
  ],
  useWhen: [
    'Tracing ambiguous runtime behavior, regressions, or orchestration outcomes',
    'Ranking competing explanations for an observed result',
    'Separating observation, evidence, and inference',
    'Explaining performance, architecture, scientific, or configuration outcomes',
    'Identifying the next probe that would collapse uncertainty fastest',
  ],
  avoidWhen: [
    'The task is pure implementation or fixing (use executor/debugger)',
    'The task is a generic summary without causal analysis',
    'A single-file code search is enough (use explore)',
    'You already have decisive evidence and only need execution',
  ],
};

export const tracerAgent: AgentConfig = {
  name: 'tracer',
  description: 'Evidence-driven causal tracing specialist. Explains observed outcomes using competing hypotheses, evidence for and against, uncertainty tracking, and next-probe recommendations.',
  prompt: loadAgentPrompt('tracer'),
  model: 'sonnet',
  defaultModel: 'sonnet',
  metadata: TRACER_PROMPT_METADATA,
};
