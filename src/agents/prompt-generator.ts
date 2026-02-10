/**
 * Dynamic Prompt Generator for Oh-My-Claude-Sisyphus
 *
 * Generates orchestrator prompts dynamically from agent metadata.
 * Adding a new agent to definitions.ts automatically includes it in the generated prompt.
 */

import type { AgentConfig } from './types.js';
import {
  buildHeader,
  buildAgentRegistry,
  buildTriggerTable,
  buildToolSelectionSection,
  buildDelegationMatrix,
  buildOrchestrationPrinciples,
  buildWorkflow,
  buildCriticalRules,
  buildCompletionChecklist
} from './prompt-sections/index.js';

/**
 * Options for controlling what sections are included in generated prompt
 */
export interface GeneratorOptions {
  /** Include agent registry section (default: true) */
  includeAgents?: boolean;
  /** Include trigger table section (default: true) */
  includeTriggers?: boolean;
  /** Include tool selection guidance (default: true) */
  includeTools?: boolean;
  /** Include delegation matrix (default: true) */
  includeDelegationTable?: boolean;
  /** Include orchestration principles (default: true) */
  includePrinciples?: boolean;
  /** Include workflow section (default: true) */
  includeWorkflow?: boolean;
  /** Include critical rules (default: true) */
  includeRules?: boolean;
  /** Include completion checklist (default: true) */
  includeChecklist?: boolean;
}

/**
 * Default generator options (all sections enabled)
 */
const DEFAULT_OPTIONS: Required<GeneratorOptions> = {
  includeAgents: true,
  includeTriggers: true,
  includeTools: true,
  includeDelegationTable: true,
  includePrinciples: true,
  includeWorkflow: true,
  includeRules: true,
  includeChecklist: true
};

/**
 * Generate complete orchestrator prompt from agent definitions
 *
 * @param agents - Array of agent configurations
 * @param options - Options controlling which sections to include
 * @returns Generated orchestrator prompt string
 *
 * @example
 * ```typescript
 * import { getAgentDefinitions } from './definitions.js';
 * import { generateOrchestratorPrompt } from './prompt-generator.js';
 *
 * const agents = Object.values(getAgentDefinitions()).map(def => ({
 *   name: def.name,
 *   description: def.description,
 *   prompt: def.prompt,
 *   tools: def.tools,
 *   model: def.model,
 *   metadata: def.metadata
 * }));
 *
 * const prompt = generateOrchestratorPrompt(agents);
 * console.log(prompt);
 * ```
 */
export function generateOrchestratorPrompt(
  agents: AgentConfig[],
  options?: GeneratorOptions
): string {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const sections: string[] = [];

  // Always include header
  sections.push(buildHeader());
  sections.push('');

  // Agent registry
  if (opts.includeAgents) {
    sections.push(buildAgentRegistry(agents));
  }

  // Orchestration principles
  if (opts.includePrinciples) {
    sections.push(buildOrchestrationPrinciples());
    sections.push('');
  }

  // Trigger table
  if (opts.includeTriggers) {
    const triggerSection = buildTriggerTable(agents);
    if (triggerSection) {
      sections.push(triggerSection);
    }
  }

  // Tool selection guidance
  if (opts.includeTools) {
    sections.push(buildToolSelectionSection(agents));
  }

  // Delegation matrix
  if (opts.includeDelegationTable) {
    sections.push(buildDelegationMatrix(agents));
  }

  // Workflow
  if (opts.includeWorkflow) {
    sections.push(buildWorkflow());
    sections.push('');
  }

  // Critical rules
  if (opts.includeRules) {
    sections.push(buildCriticalRules());
    sections.push('');
  }

  // Completion checklist
  if (opts.includeChecklist) {
    sections.push(buildCompletionChecklist());
  }

  return sections.join('\n');
}

/**
 * Build agent section only (for embedding in other prompts)
 */
export function buildAgentSection(agents: AgentConfig[]): string {
  return buildAgentRegistry(agents);
}

/**
 * Build triggers section only
 */
export function buildTriggersSection(agents: AgentConfig[]): string {
  return buildTriggerTable(agents);
}

/**
 * Build tool selection section only (alias for buildToolSelectionSection from prompt-sections)
 */
export { buildToolSelectionSection };

/**
 * Build delegation table section only
 */
export function buildDelegationTableSection(agents: AgentConfig[]): string {
  return buildDelegationMatrix(agents);
}

/**
 * Convert agent definitions record to array of AgentConfig for generation
 *
 * @param definitions - Record of agent definitions from getAgentDefinitions()
 * @returns Array of AgentConfig suitable for prompt generation
 *
 * @example
 * ```typescript
 * import { getAgentDefinitions } from './definitions.js';
 * import { convertDefinitionsToConfigs, generateOrchestratorPrompt } from './prompt-generator.js';
 *
 * const definitions = getAgentDefinitions();
 * const agents = convertDefinitionsToConfigs(definitions);
 * const prompt = generateOrchestratorPrompt(agents);
 * ```
 */
export function convertDefinitionsToConfigs(
  definitions: Record<string, {
    description: string;
    prompt: string;
    tools?: string[];
    disallowedTools?: string[];
    model?: string;
    metadata?: any;
  }>
): AgentConfig[] {
  return Object.entries(definitions).map(([name, def]) => ({
    name,
    description: def.description,
    prompt: def.prompt,
    tools: def.tools,
    disallowedTools: def.disallowedTools,
    model: def.model as any,
    metadata: def.metadata
  }));
}
