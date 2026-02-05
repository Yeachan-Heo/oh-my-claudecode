/**
 * Legacy compatibility exports for Agent v4.
 */

import type {
  AgentConfig as SharedAgentConfig,
  ModelType as SharedModelType,
} from "../shared/types.js";
import type {
  AgentRole,
  ComplexityTier,
  ComposedAgentConfig,
} from "./types.js";
import {
  AGENT_ROLES as V4_AGENT_ROLES,
  getAgentRole as getAgentRoleV4,
} from "./roles.js";
import { TIER_OVERLAYS as V4_TIER_OVERLAYS } from "./tiers.js";
import {
  composeAgent as composeAgentV4,
  getAgentName as getAgentNameV4,
} from "./composer.js";
import {
  LEGACY_ALIASES as V4_LEGACY_ALIASES,
  resolveAlias as resolveAliasV4,
  getAgentDefinitionsV4 as getAgentDefinitionsV4Internal,
} from "./registry.js";
import { loadAllSections, loadRoleMarkdown } from "./loader.js";

type LegacyPromptMetadata = {
  category:
    | "exploration"
    | "specialist"
    | "advisor"
    | "utility"
    | "orchestration"
    | "planner"
    | "reviewer";
  cost: "FREE" | "CHEAP" | "EXPENSIVE";
  triggers: string[];
};

const PROMPT_SECTION_SEPARATOR = "\n\n---\n\n";

const mapComposedAgentConfig = (
  config: ComposedAgentConfig,
): SharedAgentConfig => ({
  name: config.name,
  description: config.description,
  prompt: config.prompt,
  tools: config.tools,
  model: config.model,
  defaultModel: config.model,
});

const resolveRoleTier = (
  agentName: string,
): { role: AgentRole; tier: ComplexityTier } | null => {
  const alias = resolveAliasV4(agentName);
  if (alias) {
    return alias;
  }

  if (Object.prototype.hasOwnProperty.call(V4_AGENT_ROLES, agentName)) {
    const role = agentName as AgentRole;
    return { role, tier: getAgentRoleV4(role).defaultTier };
  }

  return null;
};

const composeLegacyPrompt = (role: AgentRole, tier: ComplexityTier): string => {
  const sections = loadAllSections();
  const baseSection = sections.find(
    (section) => section.id === "base-protocol",
  );
  const baseOrder = baseSection?.order ?? 0;
  const tierSectionId = `tier-${tier.toLowerCase()}`;
  const tierSection = sections.find((section) => section.id === tierSectionId);
  const tierFallback = {
    id: tierSectionId,
    name: `${tier} Tier Instructions`,
    content: V4_TIER_OVERLAYS[tier].instructions,
    order: baseOrder + 1,
  };

  const roleSection = {
    id: `role-${role}`,
    name: `${role} Role Instructions`,
    content: loadRoleMarkdown(role),
    order: baseOrder + 2,
  };

  const promptSections = [
    baseSection ?? {
      id: "base-protocol",
      name: "Base Protocol",
      content: "",
      order: 0,
    },
    tierSection ?? tierFallback,
    roleSection,
  ];

  const prompt = promptSections
    .slice()
    .sort((first, second) => first.order - second.order)
    .map((section) => section.content.trim())
    .filter((content) => content.length > 0)
    .join(PROMPT_SECTION_SEPARATOR);

  return prompt;
};

/** @deprecated Use V4 agent system directly. Will be removed in v5.0.0 */
export type AgentConfig = SharedAgentConfig;
/** @deprecated Use V4 agent system directly. Will be removed in v5.0.0 */
export type ModelType = SharedModelType;
/** @deprecated Use V4 agent system directly. Will be removed in v5.0.0 */
export type AgentCost = "FREE" | "CHEAP" | "EXPENSIVE";
/** @deprecated Use V4 agent system directly. Will be removed in v5.0.0 */
export type AgentCategory =
  | "exploration"
  | "specialist"
  | "advisor"
  | "utility"
  | "orchestration"
  | "planner"
  | "reviewer";

/** @deprecated Use V4 agent system directly. Will be removed in v5.0.0 */
export const AGENT_ROLES = V4_AGENT_ROLES;
/** @deprecated Use V4 agent system directly. Will be removed in v5.0.0 */
export const getAgentRole = getAgentRoleV4;
/** @deprecated Use V4 agent system directly. Will be removed in v5.0.0 */
export const TIER_OVERLAYS = V4_TIER_OVERLAYS;
/** @deprecated Use V4 agent system directly. Will be removed in v5.0.0 */
export const composeAgent = composeAgentV4;
/** @deprecated Use V4 agent system directly. Will be removed in v5.0.0 */
export const getAgentName = getAgentNameV4;
/** @deprecated Use V4 agent system directly. Will be removed in v5.0.0 */
export const LEGACY_ALIASES = V4_LEGACY_ALIASES;
/** @deprecated Use V4 agent system directly. Will be removed in v5.0.0 */
export const resolveAlias = resolveAliasV4;
/** @deprecated Use V4 agent system directly. Will be removed in v5.0.0 */
export const getAgentDefinitionsV4 = getAgentDefinitionsV4Internal;

/** @deprecated Use V4 agent system directly. Will be removed in v5.0.0 */
export const architectAgent: SharedAgentConfig = mapComposedAgentConfig(
  composeAgentV4("architect", "HIGH"),
);
/** @deprecated Use V4 agent system directly. Will be removed in v5.0.0 */
export const researcherAgent: SharedAgentConfig = mapComposedAgentConfig(
  composeAgentV4("researcher", "MEDIUM"),
);
/** @deprecated Use V4 agent system directly. Will be removed in v5.0.0 */
export const exploreAgent: SharedAgentConfig = mapComposedAgentConfig(
  composeAgentV4("explore", "LOW"),
);
/** @deprecated Use V4 agent system directly. Will be removed in v5.0.0 */
export const executorAgent: SharedAgentConfig = mapComposedAgentConfig(
  composeAgentV4("executor", "MEDIUM"),
);
/** @deprecated Use V4 agent system directly. Will be removed in v5.0.0 */
export const designerAgent: SharedAgentConfig = mapComposedAgentConfig(
  composeAgentV4("designer", "MEDIUM"),
);
/** @deprecated Use V4 agent system directly. Will be removed in v5.0.0 */
export const writerAgent: SharedAgentConfig = mapComposedAgentConfig(
  composeAgentV4("writer", "LOW"),
);
/** @deprecated Use V4 agent system directly. Will be removed in v5.0.0 */
export const visionAgent: SharedAgentConfig = mapComposedAgentConfig(
  composeAgentV4("vision", "MEDIUM"),
);
/** @deprecated Use V4 agent system directly. Will be removed in v5.0.0 */
export const criticAgent: SharedAgentConfig = mapComposedAgentConfig(
  composeAgentV4("critic", "HIGH"),
);
/** @deprecated Use V4 agent system directly. Will be removed in v5.0.0 */
export const analystAgent: SharedAgentConfig = mapComposedAgentConfig(
  composeAgentV4("analyst", "HIGH"),
);
/** @deprecated Use V4 agent system directly. Will be removed in v5.0.0 */
export const plannerAgent: SharedAgentConfig = mapComposedAgentConfig(
  composeAgentV4("planner", "HIGH"),
);
/** @deprecated Use V4 agent system directly. Will be removed in v5.0.0 */
export const qaTesterAgent: SharedAgentConfig = mapComposedAgentConfig(
  composeAgentV4("qa-tester", "MEDIUM"),
);
/** @deprecated Use V4 agent system directly. Will be removed in v5.0.0 */
export const scientistAgent: SharedAgentConfig = mapComposedAgentConfig(
  composeAgentV4("scientist", "MEDIUM"),
);
/** @deprecated Use V4 agent system directly. Will be removed in v5.0.0 */
export const deepExecutorAgent: SharedAgentConfig = mapComposedAgentConfig(
  composeAgentV4("executor", "HIGH"),
);
/** @deprecated Use V4 agent system directly. Will be removed in v5.0.0 */
export const coordinatorAgent: SharedAgentConfig = mapComposedAgentConfig(
  composeAgentV4("executor", "MEDIUM"),
);

/** @deprecated Use V4 agent system directly. Will be removed in v5.0.0 */
export const ARCHITECT_PROMPT_METADATA: LegacyPromptMetadata = {
  category: "advisor",
  cost: "EXPENSIVE",
  triggers: [],
};
/** @deprecated Use V4 agent system directly. Will be removed in v5.0.0 */
export const EXPLORE_PROMPT_METADATA: LegacyPromptMetadata = {
  category: "exploration",
  cost: "FREE",
  triggers: [],
};
/** @deprecated Use V4 agent system directly. Will be removed in v5.0.0 */
export const RESEARCHER_PROMPT_METADATA: LegacyPromptMetadata = {
  category: "specialist",
  cost: "CHEAP",
  triggers: [],
};
/** @deprecated Use V4 agent system directly. Will be removed in v5.0.0 */
export const SISYPHUS_JUNIOR_PROMPT_METADATA: LegacyPromptMetadata = {
  category: "specialist",
  cost: "CHEAP",
  triggers: [],
};
/** @deprecated Use V4 agent system directly. Will be removed in v5.0.0 */
export const FRONTEND_ENGINEER_PROMPT_METADATA: LegacyPromptMetadata = {
  category: "specialist",
  cost: "CHEAP",
  triggers: [],
};
/** @deprecated Use V4 agent system directly. Will be removed in v5.0.0 */
export const DOCUMENT_WRITER_PROMPT_METADATA: LegacyPromptMetadata = {
  category: "utility",
  cost: "FREE",
  triggers: [],
};
/** @deprecated Use V4 agent system directly. Will be removed in v5.0.0 */
export const MULTIMODAL_LOOKER_PROMPT_METADATA: LegacyPromptMetadata = {
  category: "advisor",
  cost: "CHEAP",
  triggers: [],
};
/** @deprecated Use V4 agent system directly. Will be removed in v5.0.0 */
export const CRITIC_PROMPT_METADATA: LegacyPromptMetadata = {
  category: "reviewer",
  cost: "EXPENSIVE",
  triggers: [],
};
/** @deprecated Use V4 agent system directly. Will be removed in v5.0.0 */
export const ANALYST_PROMPT_METADATA: LegacyPromptMetadata = {
  category: "planner",
  cost: "EXPENSIVE",
  triggers: [],
};
/** @deprecated Use V4 agent system directly. Will be removed in v5.0.0 */
export const PLANNER_PROMPT_METADATA: LegacyPromptMetadata = {
  category: "planner",
  cost: "EXPENSIVE",
  triggers: [],
};
/** @deprecated Use V4 agent system directly. Will be removed in v5.0.0 */
export const ORCHESTRATOR_SISYPHUS_PROMPT_METADATA: LegacyPromptMetadata = {
  category: "orchestration",
  cost: "CHEAP",
  triggers: [],
};
/** @deprecated Use V4 agent system directly. Will be removed in v5.0.0 */
export const QA_TESTER_PROMPT_METADATA: LegacyPromptMetadata = {
  category: "specialist",
  cost: "CHEAP",
  triggers: [],
};
/** @deprecated Use V4 agent system directly. Will be removed in v5.0.0 */
export const SCIENTIST_PROMPT_METADATA: LegacyPromptMetadata = {
  category: "specialist",
  cost: "CHEAP",
  triggers: [],
};
/** @deprecated Use V4 agent system directly. Will be removed in v5.0.0 */
export const DEEP_EXECUTOR_PROMPT_METADATA: LegacyPromptMetadata = {
  category: "specialist",
  cost: "EXPENSIVE",
  triggers: [],
};

const VALID_AGENT_NAME_PATTERN = /^[a-z][a-z0-9-]*$/;

const validateAgentName = (name: string): void => {
  if (name.includes("..") || name.includes("/") || name.includes("\\")) {
    throw new Error("Invalid agent name: path traversal detected");
  }
  if (!VALID_AGENT_NAME_PATTERN.test(name)) {
    throw new Error("Invalid agent name: contains disallowed characters");
  }
};

/** @deprecated Use V4 agent system directly. Will be removed in v5.0.0 */
export function loadAgentPrompt(agentName: string): string {
  validateAgentName(agentName);

  const alias = resolveRoleTier(agentName);
  if (!alias) {
    return `Agent: ${agentName}\n\nPrompt unavailable.`;
  }

  const prompt = composeLegacyPrompt(alias.role, alias.tier);
  if (prompt.length > 0) {
    return prompt;
  }

  const canonicalName = getAgentNameV4(alias.role, alias.tier);
  return `Agent: ${canonicalName}\n\nPrompt unavailable.`;
}

/** @deprecated Use V4 agent system directly. Will be removed in v5.0.0 */
export function createAgentToolRestrictions(blockedTools: string[]): {
  tools: Record<string, boolean>;
} {
  const restrictions: Record<string, boolean> = {};
  for (const tool of blockedTools) {
    restrictions[tool.toLowerCase()] = false;
  }
  return { tools: restrictions };
}

/** @deprecated Use V4 agent system directly. Will be removed in v5.0.0 */
export function mergeAgentConfig(
  base: SharedAgentConfig,
  override: unknown,
): SharedAgentConfig {
  const safeOverride =
    override && typeof override === "object"
      ? (override as Record<string, unknown>)
      : {};
  const promptAppend =
    typeof safeOverride.prompt_append === "string"
      ? safeOverride.prompt_append
      : undefined;
  const model =
    typeof safeOverride.model === "string"
      ? (safeOverride.model as SharedModelType)
      : undefined;
  const enabled =
    typeof safeOverride.enabled === "boolean"
      ? safeOverride.enabled
      : undefined;

  const merged: SharedAgentConfig & { enabled?: boolean } = {
    ...base,
    ...(model && { model }),
  };

  if (enabled !== undefined) {
    merged.enabled = enabled;
  }

  if (promptAppend && merged.prompt) {
    merged.prompt = `${merged.prompt}\n\n${promptAppend}`;
  }

  return merged;
}

/** @deprecated Use V4 agent system directly. Will be removed in v5.0.0 */
export function validateAgentConfig(config: SharedAgentConfig): string[] {
  const errors: string[] = [];

  if (!config.name) {
    errors.push("Agent name is required");
  }

  if (!config.description) {
    errors.push("Agent description is required");
  }

  if (!config.prompt) {
    errors.push("Agent prompt is required");
  }

  if (!config.tools || config.tools.length === 0) {
    errors.push("Agent must have at least one tool");
  }

  return errors;
}

const deepMergeInternal = <T extends Record<string, unknown>>(
  target: T,
  source: Partial<T>,
): T => {
  const result = { ...target };

  for (const key of Object.keys(source)) {
    const sourceValue = source[key as keyof T];
    const targetValue = target[key as keyof T];

    if (
      sourceValue &&
      typeof sourceValue === "object" &&
      !Array.isArray(sourceValue) &&
      targetValue &&
      typeof targetValue === "object" &&
      !Array.isArray(targetValue)
    ) {
      (result as Record<string, unknown>)[key] = deepMergeInternal(
        targetValue as Record<string, unknown>,
        sourceValue as Record<string, unknown>,
      );
    } else if (sourceValue !== undefined) {
      (result as Record<string, unknown>)[key] = sourceValue;
    }
  }

  return result;
};

/** @deprecated Use V4 agent system directly. Will be removed in v5.0.0 */
export function deepMerge<T extends Record<string, unknown>>(
  target: T,
  source: Partial<T>,
): T {
  return deepMergeInternal(target, source);
}

/** @deprecated Use V4 agent system directly. Will be removed in v5.0.0 */
export function getAvailableAgents(
  _: Record<string, SharedAgentConfig>,
): any[] {
  return [];
}

/** @deprecated Use V4 agent system directly. Will be removed in v5.0.0 */
export function buildDelegationTable(_: any[]): string {
  return "";
}

/** @deprecated Use V4 agent system directly. Will be removed in v5.0.0 */
export function buildUseAvoidSection(_: any): string {
  return "";
}

/** @deprecated Use V4 agent system directly. Will be removed in v5.0.0 */
export function createEnvContext(): string {
  const now = new Date();
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const locale = Intl.DateTimeFormat().resolvedOptions().locale;

  const timeStr = now.toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  });

  return `
<env-context>
  Current time: ${timeStr}
  Timezone: ${timezone}
  Locale: ${locale}
</env-context>`;
}

/** @deprecated Use V4 agent system directly. Will be removed in v5.0.0 */
export function buildKeyTriggersSection(_: any[]): string {
  return "";
}
