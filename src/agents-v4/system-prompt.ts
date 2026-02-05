import type { AgentRole, ComplexityTier } from "./types.js";
import { AGENT_ROLES } from "./roles.js";
import { TIER_OVERLAYS } from "./tiers.js";
import { composeAllAgents, getAgentName } from "./composer.js";

const TIER_ORDER: ComplexityTier[] = ["LOW", "MEDIUM", "HIGH"];

const formatTriggers = (
  name: string,
  role: AgentRole,
  tier: ComplexityTier,
): string => {
  const triggers = new Set<string>([name, role, tier.toLowerCase()]);
  return Array.from(triggers).join(", ");
};

const buildAgentMenuRows = (): string[] => {
  const agents = composeAllAgents();
  const roles = Object.values(AGENT_ROLES).map((role) => role.role);
  const rows: string[] = [];

  for (const role of roles) {
    for (const tier of TIER_ORDER) {
      const name = getAgentName(role, tier);
      const agent = agents[name];
      if (!agent) {
        continue;
      }

      const description = AGENT_ROLES[role].description;
      const model = TIER_OVERLAYS[tier].model;
      const triggers = formatTriggers(name, role, tier);
      rows.push(
        `| ${name} (${tier}) | ${model} | ${description} Triggers: ${triggers}. |`,
      );
    }
  }

  return rows;
};

export function generateSystemPrompt(): string {
  const agentRows = buildAgentMenuRows();

  const lines: string[] = [
    "## Identity",
    "You are the orchestrator of a multi-agent development system.",
    "Coordinate specialized agents to deliver correct, verifiable outcomes.",
    "Delegate, parallelize, and persist until all tasks are complete.",
    "Communicate clearly and stay aligned with the user's intent.",
    "",
    "## Agent Menu",
    "| Agent | Model | Use For |",
    "| --- | --- | --- |",
    ...agentRows,
    "",
    "## Orchestration Principles",
    "- Delegate to the best-fit specialist.",
    "- Parallelize independent work streams.",
    "- Persist until verification and todo completion.",
    "- Verify via tests or direct checks.",
    "- Communicate progress tersely and truthfully.",
    "",
    "## Workflow",
    "1. Parse the request and create todos.",
    "2. Mark the first task in_progress and start work.",
    "3. Delegate specialized subtasks to agents.",
    "4. Parallelize work when tasks are independent.",
    "5. Integrate results and resolve blockers.",
    "6. Verify outputs before marking tasks complete.",
    "7. Repeat until all tasks are completed.",
    "8. Final pass: confirm todos, tests, and request.",
    "",
    "## Critical Rules",
    "1. Never stop with pending or in_progress tasks.",
    "2. Always verify before claiming completion.",
    "3. Ask questions only when truly blocked.",
    "",
    "## Completion Checklist",
    "- All todos are completed.",
    "- Tests/build pass when applicable.",
    "- The user request is fully satisfied.",
  ];

  return lines.join("\n");
}

let cachedSystemPrompt: string | null = null;

const getCachedSystemPrompt = (): string => {
  if (cachedSystemPrompt === null) {
    cachedSystemPrompt = generateSystemPrompt();
  }
  return cachedSystemPrompt;
};

class LazySystemPrompt extends String {
  override toString(): string {
    return getCachedSystemPrompt();
  }

  override valueOf(): string {
    return getCachedSystemPrompt();
  }

  [Symbol.toPrimitive](): string {
    return getCachedSystemPrompt();
  }
}

export const omcSystemPromptV4: string =
  new LazySystemPrompt() as unknown as string;
