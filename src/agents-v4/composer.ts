/**
 * Agent v4 Prompt Composer
 *
 * Builds prompts and agent configs from role and tier definitions.
 */

import type {
  AgentRole,
  ComplexityTier,
  ComposedAgentConfig,
  PromptSection,
} from "./types.js";
import { TIER_OVERLAYS } from "./tiers.js";
import { AGENT_ROLES } from "./roles.js";

const BASE_PROTOCOL_SECTION_ID = "base-protocol";
const DEFAULT_BASE_PROTOCOL_SECTION: PromptSection = {
  id: BASE_PROTOCOL_SECTION_ID,
  name: "Base Protocol",
  content: "Base protocol loaded from agents/sections/base-protocol.md",
  order: 0,
};

const PROMPT_SECTION_SEPARATOR = "\n\n---\n\n";

export const VALID_TIER_COMBINATIONS: Record<AgentRole, ComplexityTier[]> = {
  architect: ["LOW", "MEDIUM", "HIGH"],
  researcher: ["LOW", "MEDIUM"],
  explore: ["LOW", "MEDIUM", "HIGH"],
  designer: ["LOW", "MEDIUM", "HIGH"],
  writer: ["LOW"],
  vision: ["MEDIUM"],
  critic: ["HIGH"],
  analyst: ["HIGH"],
  executor: ["LOW", "MEDIUM", "HIGH"],
  planner: ["HIGH"],
  "qa-tester": ["MEDIUM", "HIGH"],
  scientist: ["LOW", "MEDIUM", "HIGH"],
};

const resolveBaseProtocolSection = (
  sections?: PromptSection[],
): PromptSection => {
  const baseSection = sections?.find(
    (section) => section.id === BASE_PROTOCOL_SECTION_ID,
  );
  return baseSection ?? DEFAULT_BASE_PROTOCOL_SECTION;
};

const resolveAdditionalSections = (
  role: AgentRole,
  sections?: PromptSection[],
): PromptSection[] => {
  const additionalSectionIds = AGENT_ROLES[role].additionalSections;
  if (!additionalSectionIds?.length || !sections?.length) {
    return [];
  }

  const sectionMap = new Map(
    sections.map((section) => [section.id, section] as const),
  );
  return additionalSectionIds
    .map((sectionId) => sectionMap.get(sectionId))
    .filter((section): section is PromptSection => Boolean(section));
};

const applyToolModifiers = (
  baseTools: string[],
  tier: ComplexityTier,
): string[] => {
  const overlay = TIER_OVERLAYS[tier];
  const removeTools = new Set(overlay.toolModifiers?.remove ?? []);
  const tools = baseTools.filter((tool) => !removeTools.has(tool));
  const addTools = overlay.toolModifiers?.add ?? [];

  for (const tool of addTools) {
    if (!tools.includes(tool)) {
      tools.push(tool);
    }
  }

  return tools;
};

/**
 * Compose the final prompt for a role and tier.
 */
export function composePrompt(
  role: AgentRole,
  tier: ComplexityTier,
  sections?: PromptSection[],
): string {
  const roleDefinition = AGENT_ROLES[role];
  const baseSection = resolveBaseProtocolSection(sections);

  const tierSection: PromptSection = {
    id: `tier-${tier.toLowerCase()}`,
    name: `${tier} Tier Instructions`,
    content: TIER_OVERLAYS[tier].instructions,
    order: baseSection.order + 1,
  };

  const roleSection: PromptSection = {
    id: `role-${role}`,
    name: `${role} Role Instructions`,
    content: roleDefinition.rolePrompt,
    order: baseSection.order + 2,
  };

  const additionalSections = resolveAdditionalSections(role, sections).filter(
    (section) => section.id !== BASE_PROTOCOL_SECTION_ID,
  );

  const combinedSections = [
    baseSection,
    tierSection,
    roleSection,
    ...additionalSections,
  ];
  const dedupedSections: PromptSection[] = [];
  const seen = new Set<string>();

  for (const section of combinedSections) {
    if (seen.has(section.id)) {
      continue;
    }
    seen.add(section.id);
    dedupedSections.push(section);
  }

  return dedupedSections
    .slice()
    .sort((first, second) => first.order - second.order)
    .map((section) => section.content.trim())
    .filter((content) => content.length > 0)
    .join(PROMPT_SECTION_SEPARATOR);
}

/**
 * Compose a full agent configuration for a role and tier.
 */
export function composeAgent(
  role: AgentRole,
  tier: ComplexityTier,
  sections?: PromptSection[],
): ComposedAgentConfig {
  const roleDefinition = AGENT_ROLES[role];
  const tools = applyToolModifiers([...roleDefinition.baseTools], tier);

  return {
    name: getAgentName(role, tier),
    role,
    tier,
    prompt: composePrompt(role, tier, sections),
    tools,
    model: TIER_OVERLAYS[tier].model,
    description: roleDefinition.description,
  };
}

/**
 * Compose all valid role/tier combinations.
 */
export function composeAllAgents(
  sections?: PromptSection[],
): Record<string, ComposedAgentConfig> {
  const agents: Record<string, ComposedAgentConfig> = {};

  for (const [role, tiers] of Object.entries(VALID_TIER_COMBINATIONS) as [
    AgentRole,
    ComplexityTier[],
  ][]) {
    for (const tier of tiers) {
      const agent = composeAgent(role, tier, sections);
      agents[agent.name] = agent;
    }
  }

  return agents;
}

/**
 * Resolve the legacy-compatible name for a role and tier.
 */
export function getAgentName(role: AgentRole, tier: ComplexityTier): string {
  const defaultTier = AGENT_ROLES[role].defaultTier;
  if (tier === defaultTier) {
    return role;
  }

  return `${role}-${tier.toLowerCase()}`;
}
