/**
 * Agent v4 Registry
 *
 * Maps legacy agent names to v4 role/tier configurations.
 */

import type { AgentConfig, ModelType } from "../shared/types.js";
import type { LegacyAlias, ComposedAgentConfig } from "./types.js";
import { composeAgent, composeAllAgents } from "./composer.js";

type AgentDefinitionEntry = {
  description: string;
  prompt: string;
  tools: string[];
  model?: ModelType;
  defaultModel?: ModelType;
};

const SPECIAL_TOOL_OVERRIDES: Record<string, string[]> = {
  "git-master": ["Read", "Glob", "Grep", "Bash"],
};

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

/**
 * Legacy alias mapping for backward compatibility.
 */
export const LEGACY_ALIASES: Record<string, LegacyAlias> = {
  architect: { role: "architect", tier: "HIGH" },
  "architect-medium": { role: "architect", tier: "MEDIUM" },
  "architect-low": { role: "architect", tier: "LOW" },
  executor: { role: "executor", tier: "MEDIUM" },
  "executor-high": { role: "executor", tier: "HIGH" },
  "executor-low": { role: "executor", tier: "LOW" },
  explore: { role: "explore", tier: "LOW" },
  "explore-medium": { role: "explore", tier: "MEDIUM" },
  "explore-high": { role: "explore", tier: "HIGH" },
  designer: { role: "designer", tier: "MEDIUM" },
  "designer-low": { role: "designer", tier: "LOW" },
  "designer-high": { role: "designer", tier: "HIGH" },
  researcher: { role: "researcher", tier: "MEDIUM" },
  "researcher-low": { role: "researcher", tier: "LOW" },
  writer: { role: "writer", tier: "LOW" },
  vision: { role: "vision", tier: "MEDIUM" },
  critic: { role: "critic", tier: "HIGH" },
  analyst: { role: "analyst", tier: "HIGH" },
  planner: { role: "planner", tier: "HIGH" },
  "qa-tester": { role: "qa-tester", tier: "MEDIUM" },
  "qa-tester-high": { role: "qa-tester", tier: "HIGH" },
  scientist: { role: "scientist", tier: "MEDIUM" },
  "scientist-low": { role: "scientist", tier: "LOW" },
  "scientist-high": { role: "scientist", tier: "HIGH" },
  "security-reviewer": { role: "architect", tier: "HIGH" },
  "security-reviewer-low": { role: "architect", tier: "LOW" },
  "build-fixer": { role: "executor", tier: "MEDIUM" },
  "build-fixer-low": { role: "executor", tier: "LOW" },
  "tdd-guide": { role: "executor", tier: "MEDIUM" },
  "tdd-guide-low": { role: "executor", tier: "LOW" },
  "code-reviewer": { role: "critic", tier: "HIGH" },
  "code-reviewer-low": { role: "critic", tier: "LOW" },
  "git-master": { role: "executor", tier: "MEDIUM" },
  "deep-executor": { role: "executor", tier: "HIGH" },
};

/**
 * Resolve a legacy agent name into a role/tier pair.
 */
export function resolveAlias(name: string): LegacyAlias | null {
  return LEGACY_ALIASES[name] ?? null;
}

/**
 * Get v4 agent definitions with backward-compatible names.
 */
export function getAgentDefinitionsV4(
  overrides?: Partial<Record<string, Partial<AgentConfig>>>,
): Record<string, AgentDefinitionEntry> {
  const composedAgents = composeAllAgents();
  const definitions: Record<string, AgentDefinitionEntry> = {};

  for (const [name, alias] of Object.entries(LEGACY_ALIASES)) {
    const baseConfig =
      composedAgents[name] ?? composeAgent(alias.role, alias.tier);
    const finalConfig = applySpecialOverrides(name, baseConfig);
    const override = overrides?.[name];

    definitions[name] = {
      description: override?.description ?? finalConfig.description,
      prompt: override?.prompt ?? finalConfig.prompt,
      tools: override?.tools ?? finalConfig.tools,
      model: override?.model ?? finalConfig.model,
      defaultModel: override?.defaultModel ?? finalConfig.model,
    };
  }

  return definitions;
}
