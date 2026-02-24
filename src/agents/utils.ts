/**
 * Agent Utilities
 *
 * Shared utilities for agent creation and management.
 * Includes prompt builders and configuration helpers.
 *
 * Ported from oh-my-opencode's agent utils.
 */

import { readFileSync } from 'fs';
import { join, dirname, resolve, relative, isAbsolute } from 'path';
import { fileURLToPath } from 'url';

import type {
  AgentConfig,
  AgentPromptMetadata,
  AvailableAgent,
  AgentOverrideConfig,
  ModelType
} from './types.js';
// ============================================================
// DYNAMIC PROMPT LOADING
// ============================================================

/**
 * Build-time injected agent prompts map.
 * esbuild replaces this with a { role: "prompt content" } object during bridge builds.
 * In dev/test (unbundled), this remains undefined and we fall back to runtime file reads.
 */
declare const __AGENT_PROMPTS__: Record<string, string> | undefined;

/**
 * Get the package root directory (where agents/ folder lives).
 * Handles both ESM (import.meta.url) and CJS bundle (__dirname) contexts.
 * When esbuild bundles to CJS, import.meta is replaced with {} so we
 * fall back to __dirname which is natively available in CJS.
 */
function getPackageDir(): string {
  try {
    if (import.meta?.url) {
      const __filename = fileURLToPath(import.meta.url);
      const __dirname = dirname(__filename);
      // From src/agents/ or dist/agents/ go up to package root
      return join(__dirname, '..', '..');
    }
  } catch {
    // import.meta.url unavailable — fall through to CJS path
  }
  // CJS bundle path: from bridge/ go up 1 level to package root
  if (typeof __dirname !== 'undefined') {
    return join(__dirname, '..');
  }
  return process.cwd();
}

/**
 * Strip YAML frontmatter from markdown content.
 */
function stripFrontmatter(content: string): string {
  const match = content.match(/^---[\s\S]*?---\s*([\s\S]*)$/);
  return match ? match[1].trim() : content.trim();
}

/**
 * Load an agent prompt from /agents/{agentName}.md
 * Uses build-time embedded prompts when available (CJS bundles),
 * falls back to runtime file reads (dev/test environments).
 *
 * Security: Validates agent name to prevent path traversal attacks
 */
export function loadAgentPrompt(agentName: string): string {
  // Security: Validate agent name contains only safe characters (alphanumeric and hyphens)
  // This prevents path traversal attacks like "../../etc/passwd"
  if (!/^[a-z0-9-]+$/i.test(agentName)) {
    throw new Error(`Invalid agent name: contains disallowed characters`);
  }

  // Prefer build-time embedded prompts (always available in CJS bundles)
  try {
    if (typeof __AGENT_PROMPTS__ !== 'undefined' && __AGENT_PROMPTS__ !== null) {
      const prompt = __AGENT_PROMPTS__[agentName];
      if (prompt) return prompt;
    }
  } catch {
    // __AGENT_PROMPTS__ not defined — fall through to runtime file read
  }

  // Runtime fallback: read from filesystem (dev/test environments)
  try {
    const agentsDir = join(getPackageDir(), 'agents');
    const agentPath = join(agentsDir, `${agentName}.md`);

    // Security: Verify resolved path is within the agents directory
    const resolvedPath = resolve(agentPath);
    const resolvedAgentsDir = resolve(agentsDir);
    const rel = relative(resolvedAgentsDir, resolvedPath);
    if (rel.startsWith('..') || isAbsolute(rel)) {
      throw new Error(`Invalid agent name: path traversal detected`);
    }

    const content = readFileSync(agentPath, 'utf-8');
    return stripFrontmatter(content);
  } catch (error) {
    // Don't leak internal paths in error messages
    const message = error instanceof Error && error.message.includes('Invalid agent name')
      ? error.message
      : 'Agent prompt file not found';
    console.warn(`[loadAgentPrompt] ${message}`);
    return `Agent: ${agentName}\n\nPrompt unavailable.`;
  }
}

/**
 * Create tool restrictions configuration
 * Returns an object that can be spread into agent config to restrict tools
 */
export function createAgentToolRestrictions(
  blockedTools: string[]
): { tools: Record<string, boolean> } {
  const restrictions: Record<string, boolean> = {};
  for (const tool of blockedTools) {
    restrictions[tool.toLowerCase()] = false;
  }
  return { tools: restrictions };
}

/**
 * Merge agent configuration with overrides
 */
export function mergeAgentConfig(
  base: AgentConfig,
  override: AgentOverrideConfig
): AgentConfig {
  const { prompt_append, ...rest } = override;

  const merged: AgentConfig = {
    ...base,
    ...(rest.model && { model: rest.model as ModelType }),
    ...(rest.enabled !== undefined && { enabled: rest.enabled })
  };

  if (prompt_append && merged.prompt) {
    merged.prompt = merged.prompt + '\n\n' + prompt_append;
  }

  return merged;
}

/**
 * Build delegation table section for OMC prompt
 */
export function buildDelegationTable(availableAgents: AvailableAgent[]): string {
  if (availableAgents.length === 0) {
    return '';
  }

  const rows = availableAgents
    .filter(a => a.metadata.triggers.length > 0)
    .map(a => {
      const triggers = a.metadata.triggers
        .map(t => `${t.domain}: ${t.trigger}`)
        .join('; ');
      return `| ${a.metadata.promptAlias || a.name} | ${a.metadata.cost} | ${triggers} |`;
    });

  if (rows.length === 0) {
    return '';
  }

  return `### Agent Delegation Table

| Agent | Cost | When to Use |
|-------|------|-------------|
${rows.join('\n')}`;
}

/**
 * Build use/avoid section for an agent
 */
export function buildUseAvoidSection(metadata: AgentPromptMetadata): string {
  const sections: string[] = [];

  if (metadata.useWhen && metadata.useWhen.length > 0) {
    sections.push(`**USE when:**
${metadata.useWhen.map(u => `- ${u}`).join('\n')}`);
  }

  if (metadata.avoidWhen && metadata.avoidWhen.length > 0) {
    sections.push(`**AVOID when:**
${metadata.avoidWhen.map(a => `- ${a}`).join('\n')}`);
  }

  return sections.join('\n\n');
}

/**
 * Create environment context for agents
 */
export function createEnvContext(): string {
  const now = new Date();
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const locale = Intl.DateTimeFormat().resolvedOptions().locale;

  const timeStr = now.toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: true,
  });

  return `
<env-context>
  Current time: ${timeStr}
  Timezone: ${timezone}
  Locale: ${locale}
</env-context>`;
}

/**
 * Get all available agents as AvailableAgent descriptors
 */
export function getAvailableAgents(
  agents: Record<string, AgentConfig>
): AvailableAgent[] {
  return Object.entries(agents)
    .filter(([_, config]) => config.metadata)
    .map(([name, config]) => ({
      name,
      description: config.description,
      metadata: config.metadata!
    }));
}

/**
 * Build key triggers section for OMC prompt
 */
export function buildKeyTriggersSection(
  availableAgents: AvailableAgent[]
): string {
  const triggers: string[] = [];

  for (const agent of availableAgents) {
    for (const trigger of agent.metadata.triggers) {
      triggers.push(`- **${trigger.domain}** → ${agent.metadata.promptAlias || agent.name}: ${trigger.trigger}`);
    }
  }

  if (triggers.length === 0) {
    return '';
  }

  return `### Key Triggers (CHECK BEFORE ACTING)

${triggers.join('\n')}`;
}

/**
 * Validate agent configuration
 */
export function validateAgentConfig(config: AgentConfig): string[] {
  const errors: string[] = [];

  if (!config.name) {
    errors.push('Agent name is required');
  }

  if (!config.description) {
    errors.push('Agent description is required');
  }

  if (!config.prompt) {
    errors.push('Agent prompt is required');
  }

  // Note: tools is now optional - agents get all tools by default if omitted

  return errors;
}

/**
 * Parse disallowedTools from agent markdown frontmatter
 */
export function parseDisallowedTools(agentName: string): string[] | undefined {
  // Security: Validate agent name contains only safe characters (alphanumeric and hyphens)
  if (!/^[a-z0-9-]+$/i.test(agentName)) {
    return undefined;
  }

  try {
    const agentsDir = join(getPackageDir(), 'agents');
    const agentPath = join(agentsDir, `${agentName}.md`);

    // Security: Verify resolved path is within the agents directory
    const resolvedPath = resolve(agentPath);
    const resolvedAgentsDir = resolve(agentsDir);
    const rel = relative(resolvedAgentsDir, resolvedPath);
    if (rel.startsWith('..') || isAbsolute(rel)) {
      return undefined;
    }

    const content = readFileSync(agentPath, 'utf-8');

    // Extract frontmatter
    const match = content.match(/^---[\s\S]*?---/);
    if (!match) return undefined;

    // Look for disallowedTools line
    const disallowedMatch = match[0].match(/^disallowedTools:\s*(.+)/m);
    if (!disallowedMatch) return undefined;

    // Parse comma-separated list
    return disallowedMatch[1].split(',').map(t => t.trim()).filter(Boolean);
  } catch {
    return undefined;
  }
}

/**
 * Standard path for open questions file
 */
export const OPEN_QUESTIONS_PATH = '.omc/plans/open-questions.md';

/**
 * Format open questions for appending to the standard open-questions.md file.
 *
 * @param topic - The plan or analysis topic name
 * @param questions - Array of { question, reason } objects
 * @returns Formatted markdown string ready to append
 */
export function formatOpenQuestions(
  topic: string,
  questions: Array<{ question: string; reason: string }>
): string {
  if (questions.length === 0) return '';

  const date = new Date().toISOString().split('T')[0];
  const items = questions
    .map(q => `- [ ] ${q.question} — ${q.reason}`)
    .join('\n');

  return `\n## ${topic} - ${date}\n${items}\n`;
}

/**
 * Deep merge utility for configurations
 */
export function deepMerge<T extends Record<string, unknown>>(
  target: T,
  source: Partial<T>
): T {
  const result = { ...target };

  for (const key of Object.keys(source)) {
    const sourceValue = source[key as keyof T];
    const targetValue = target[key as keyof T];

    if (
      sourceValue &&
      typeof sourceValue === 'object' &&
      !Array.isArray(sourceValue) &&
      targetValue &&
      typeof targetValue === 'object' &&
      !Array.isArray(targetValue)
    ) {
      (result as Record<string, unknown>)[key] = deepMerge(
        targetValue as Record<string, unknown>,
        sourceValue as Record<string, unknown>
      );
    } else if (sourceValue !== undefined) {
      (result as Record<string, unknown>)[key] = sourceValue;
    }
  }

  return result;
}
