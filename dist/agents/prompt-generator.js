/**
 * Dynamic Prompt Generator for Oh-My-Claude-Sisyphus
 *
 * Generates orchestrator prompts dynamically from agent metadata.
 * Adding a new agent to definitions.ts automatically includes it in the generated prompt.
 */
import { buildHeader, buildAgentRegistry, buildTriggerTable, buildToolSelectionSection, buildDelegationMatrix, buildOrchestrationPrinciples, buildWorkflow, buildCriticalRules, buildCompletionChecklist } from './prompt-sections/index.js';
/**
 * Default generator options (all sections enabled)
 */
const DEFAULT_OPTIONS = {
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
export function generateOrchestratorPrompt(agents, options) {
    const opts = { ...DEFAULT_OPTIONS, ...options };
    const sections = [];
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
export function buildAgentSection(agents) {
    return buildAgentRegistry(agents);
}
/**
 * Build triggers section only
 */
export function buildTriggersSection(agents) {
    return buildTriggerTable(agents);
}
/**
 * Build tool selection section only (alias for buildToolSelectionSection from prompt-sections)
 */
export { buildToolSelectionSection };
/**
 * Build delegation table section only
 */
export function buildDelegationTableSection(agents) {
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
export function convertDefinitionsToConfigs(definitions) {
    return Object.entries(definitions).map(([name, def]) => ({
        name,
        description: def.description,
        prompt: def.prompt,
        tools: def.tools,
        disallowedTools: def.disallowedTools,
        model: def.model,
        metadata: def.metadata
    }));
}
//# sourceMappingURL=prompt-generator.js.map