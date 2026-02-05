/**
 * Agent v4 Context Manager
 *
 * Provides minimal agent definitions for registration and
 * lazy-loaded full prompts for delegation.
 */

import type {
  AgentRole,
  ComplexityTier,
  ComposedAgentConfig,
} from "./types.js";
import { AGENT_ROLES } from "./roles.js";
import { TIER_OVERLAYS } from "./tiers.js";
import { composeAgent, composePrompt, getAgentName } from "./composer.js";
import { LEGACY_ALIASES, resolveAlias } from "./registry.js";
import { loadRoleMarkdown, loadAllSections } from "./loader.js";
import type { ModelType } from "../shared/types.js";

type MinimalAgentDefinition = {
  description: string;
  prompt: string;
  tools: string[];
  model?: ModelType;
  defaultModel?: ModelType;
};

const SPECIAL_TOOL_OVERRIDES: Record<string, string[]> = {
  "git-master": ["Read", "Glob", "Grep", "Bash"],
};

const PROMPT_SEPARATOR = "\n\n---\n\n";

const applySpecialOverrides = (
  name: string,
  config: ComposedAgentConfig,
): ComposedAgentConfig => {
  const toolOverride = SPECIAL_TOOL_OVERRIDES[name];
  if (!toolOverride) {
    return config;
  }

  return {
    ...config,
    tools: toolOverride,
  };
};

const buildMinimalPrompt = (
  role: AgentRole,
  tier: ComplexityTier,
  model: ModelType,
  tools: string[],
  description: string,
): string => {
  const toolList = tools.join(", ");
  return [
    `You are the ${role} agent (${tier.toLowerCase()} tier, ${model} model).`,
    description,
    "",
    `Tools: ${toolList}`,
    "",
    "Follow instructions provided in the task prompt.",
  ].join("\n");
};

const resolveAgentAlias = (
  agentName: string,
): {
  role: AgentRole;
  tier: ComplexityTier;
} => {
  const resolved = resolveAlias(agentName);
  if (!resolved) {
    throw new Error(`Unknown agent name: ${agentName}`);
  }
  return resolved;
};

const cacheKeyFor = (agentName: string, canonicalName: string): string =>
  `${agentName}:${canonicalName}`;

export class ContextManager {
  private readonly promptCache = new Map<string, string>();

  getMinimalAgentDefinitions(): Record<string, MinimalAgentDefinition> {
    const definitions: Record<string, MinimalAgentDefinition> = {};

    for (const [name, alias] of Object.entries(LEGACY_ALIASES)) {
      const baseConfig = composeAgent(alias.role, alias.tier);
      const finalConfig = applySpecialOverrides(name, baseConfig);
      const roleDefinition = AGENT_ROLES[alias.role];
      const tierModel = TIER_OVERLAYS[alias.tier].model;
      const minimalPrompt = buildMinimalPrompt(
        alias.role,
        alias.tier,
        tierModel,
        finalConfig.tools,
        roleDefinition.description,
      );

      definitions[name] = {
        description: roleDefinition.description,
        prompt: minimalPrompt,
        tools: finalConfig.tools,
        model: tierModel,
        defaultModel: tierModel,
      };
    }

    return definitions;
  }

  getFullAgentPrompt(agentName: string): string {
    const { role, tier } = resolveAgentAlias(agentName);
    const canonicalName = getAgentName(role, tier);
    const key = cacheKeyFor(agentName, canonicalName);
    const cached = this.promptCache.get(key);
    if (cached) {
      return cached;
    }
    const roleMarkdown = loadRoleMarkdown(role);
    AGENT_ROLES[role].rolePrompt = roleMarkdown;
    const sections = loadAllSections();
    const prompt = composePrompt(role, tier, sections);

    this.promptCache.set(key, prompt);
    return prompt;
  }

  buildDelegationPrompt(agentName: string, taskPrompt: string): string {
    const fullPrompt = this.getFullAgentPrompt(agentName);
    return `${fullPrompt}${PROMPT_SEPARATOR}${taskPrompt}`;
  }

  clearCache(): void {
    this.promptCache.clear();
  }
}

const defaultContextManager = new ContextManager();

export const getMinimalAgentDefinitions = (): Record<
  string,
  MinimalAgentDefinition
> => defaultContextManager.getMinimalAgentDefinitions();

export const getFullAgentPrompt = (agentName: string): string =>
  defaultContextManager.getFullAgentPrompt(agentName);

export const buildDelegationPrompt = (
  agentName: string,
  taskPrompt: string,
): string => defaultContextManager.buildDelegationPrompt(agentName, taskPrompt);
