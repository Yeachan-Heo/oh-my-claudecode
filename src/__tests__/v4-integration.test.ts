import { describe, test, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

import { LEGACY_ALIASES, resolveAlias } from "../agents-v4/registry.js";
import { AGENT_ROLES } from "../agents-v4/roles.js";
import { TIER_OVERLAYS } from "../agents-v4/tiers.js";
import {
  composeAgent,
  composeAllAgents,
  getAgentName,
  VALID_TIER_COMBINATIONS,
} from "../agents-v4/composer.js";
import {
  loadRoleMarkdown,
  loadAllSections,
  loadSectionMarkdown,
  clearLoaderCache,
} from "../agents-v4/loader.js";
import {
  ContextManager,
  getMinimalAgentDefinitions,
  getFullAgentPrompt,
  buildDelegationPrompt,
} from "../agents-v4/context-manager.js";
import {
  generateSystemPrompt,
  omcSystemPromptV4,
} from "../agents-v4/system-prompt.js";
import {
  architectAgent,
  executorAgent,
  exploreAgent,
  researcherAgent,
  designerAgent,
  writerAgent,
  visionAgent,
  criticAgent,
  analystAgent,
  plannerAgent,
  coordinatorAgent,
  loadAgentPrompt,
  createAgentToolRestrictions,
  mergeAgentConfig,
  validateAgentConfig,
  deepMerge,
  createEnvContext,
} from "../agents-v4/compat.js";

import type { AgentRole, ComplexityTier } from "../agents-v4/types.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const ALL_ROLES: AgentRole[] = [
  "architect",
  "researcher",
  "explore",
  "designer",
  "writer",
  "vision",
  "critic",
  "analyst",
  "executor",
  "planner",
  "qa-tester",
  "scientist",
];

const ALL_TIERS: ComplexityTier[] = ["LOW", "MEDIUM", "HIGH"];

describe("V4 Integration — Exhaustive Agent Verification", () => {
  describe("Phase 1: Role Definitions", () => {
    test.each(ALL_ROLES)("role '%s' is defined in AGENT_ROLES", (role) => {
      const def = AGENT_ROLES[role];
      expect(def).toBeDefined();
      expect(def.role).toBe(role);
      expect(def.description.length).toBeGreaterThan(10);
      expect(def.baseTools.length).toBeGreaterThan(0);
      expect(ALL_TIERS).toContain(def.defaultTier);
      expect(typeof def.readOnly).toBe("boolean");
      expect(def.category).toBeTruthy();
    });

    test("AGENT_ROLES contains exactly 12 roles", () => {
      expect(Object.keys(AGENT_ROLES)).toHaveLength(12);
    });
  });

  describe("Phase 2: Tier Overlays", () => {
    test.each(ALL_TIERS)("tier '%s' is defined in TIER_OVERLAYS", (tier) => {
      const overlay = TIER_OVERLAYS[tier];
      expect(overlay).toBeDefined();
      expect(overlay.tier).toBe(tier);
      expect(overlay.model).toBeTruthy();
      expect(overlay.instructions.length).toBeGreaterThan(20);
      expect(typeof overlay.maxFileExploration).toBe("number");
      expect(typeof overlay.canEscalate).toBe("boolean");
    });

    test("tier models map correctly", () => {
      expect(TIER_OVERLAYS.LOW.model).toBe("haiku");
      expect(TIER_OVERLAYS.MEDIUM.model).toBe("sonnet");
      expect(TIER_OVERLAYS.HIGH.model).toBe("opus");
    });
  });

  describe("Phase 3: Markdown Loader — All Role Files", () => {
    test.each(ALL_ROLES)("role '%s' markdown file exists on disk", (role) => {
      const rolesDir = path.join(__dirname, "../../agents/roles");
      const filePath = path.join(rolesDir, `${role}.md`);
      expect(fs.existsSync(filePath)).toBe(true);
      const content = fs.readFileSync(filePath, "utf-8");
      expect(content.length).toBeGreaterThan(50);
    });

    test.each(ALL_ROLES)(
      "loadRoleMarkdown('%s') returns non-empty content without frontmatter",
      (role) => {
        clearLoaderCache();
        const content = loadRoleMarkdown(role);
        expect(content.length).toBeGreaterThan(50);
        expect(content).not.toMatch(/^---/);
        expect(content).not.toContain("Prompt unavailable");
      },
    );
  });

  describe("Phase 4: Markdown Loader — All Section Files", () => {
    const SECTION_IDS = [
      "base-protocol",
      "tier-low",
      "tier-medium",
      "tier-high",
      "verification-protocol",
      "escalation-protocol",
    ];

    test.each(SECTION_IDS)(
      "section '%s' markdown file exists on disk",
      (sectionId) => {
        const sectionsDir = path.join(__dirname, "../../agents/sections");
        const filePath = path.join(sectionsDir, `${sectionId}.md`);
        expect(fs.existsSync(filePath)).toBe(true);
      },
    );

    test.each(SECTION_IDS)(
      "loadSectionMarkdown('%s') returns non-empty content",
      (sectionId) => {
        clearLoaderCache();
        const content = loadSectionMarkdown(sectionId);
        expect(content.length).toBeGreaterThan(10);
        expect(content).not.toContain("Prompt unavailable");
      },
    );

    test("loadAllSections returns 6 sections with correct ordering", () => {
      clearLoaderCache();
      const sections = loadAllSections();
      expect(sections).toHaveLength(6);
      for (const section of sections) {
        expect(section.id).toBeTruthy();
        expect(section.name).toBeTruthy();
        expect(section.content.length).toBeGreaterThan(0);
        expect(typeof section.order).toBe("number");
      }
    });
  });

  describe("Phase 5: Composer — All Valid Tier Combinations", () => {
    const validCombinations: [AgentRole, ComplexityTier][] = [];
    for (const [role, tiers] of Object.entries(VALID_TIER_COMBINATIONS)) {
      for (const tier of tiers) {
        validCombinations.push([role as AgentRole, tier]);
      }
    }

    test.each(validCombinations)(
      "composeAgent('%s', '%s') produces valid config",
      (role, tier) => {
        const agent = composeAgent(role, tier);
        expect(agent.name).toBeTruthy();
        expect(agent.role).toBe(role);
        expect(agent.tier).toBe(tier);
        expect(agent.prompt.length).toBeGreaterThan(0);
        expect(agent.tools.length).toBeGreaterThan(0);
        expect(agent.model).toBeTruthy();
        expect(agent.description.length).toBeGreaterThan(0);
      },
    );

    test("composeAllAgents returns all valid combinations", () => {
      const all = composeAllAgents();
      const expectedCount = validCombinations.length;
      expect(Object.keys(all).length).toBe(expectedCount);
    });

    test("getAgentName uses role as name for default tier", () => {
      for (const role of ALL_ROLES) {
        const defaultTier = AGENT_ROLES[role].defaultTier;
        expect(getAgentName(role, defaultTier)).toBe(role);
      }
    });

    test("getAgentName appends tier suffix for non-default tier", () => {
      expect(getAgentName("architect", "LOW")).toBe("architect-low");
      expect(getAgentName("executor", "HIGH")).toBe("executor-high");
      expect(getAgentName("explore", "MEDIUM")).toBe("explore-medium");
    });
  });

  describe("Phase 6: Registry — All 35 Legacy Aliases", () => {
    const aliasEntries = Object.entries(LEGACY_ALIASES);

    test(`registry has ${aliasEntries.length} aliases`, () => {
      expect(aliasEntries.length).toBeGreaterThanOrEqual(30);
    });

    test.each(aliasEntries)(
      "alias '%s' resolves to valid role '%s' tier",
      (name, alias) => {
        const resolved = resolveAlias(name);
        expect(resolved).not.toBeNull();
        expect(resolved!.role).toBe(alias.role);
        expect(resolved!.tier).toBe(alias.tier);
        expect(AGENT_ROLES[resolved!.role]).toBeDefined();
        expect(ALL_TIERS).toContain(resolved!.tier);
      },
    );

    test("resolveAlias returns null for unknown agents", () => {
      expect(resolveAlias("fake-agent-xyz")).toBeNull();
      expect(resolveAlias("")).toBeNull();
      expect(resolveAlias("sisyphus-junior")).toBeNull();
    });
  });

  describe("Phase 7: Context Manager — Minimal Definitions", () => {
    test("getMinimalAgentDefinitions returns entry for every alias", () => {
      const defs = getMinimalAgentDefinitions();
      for (const name of Object.keys(LEGACY_ALIASES)) {
        const def = defs[name];
        expect(def, `Missing definition for: ${name}`).toBeDefined();
        expect(
          def.description.length,
          `Empty description: ${name}`,
        ).toBeGreaterThan(0);
        expect(def.prompt.length, `Empty prompt: ${name}`).toBeGreaterThan(0);
        expect(def.tools.length, `No tools: ${name}`).toBeGreaterThan(0);
        expect(def.model, `No model: ${name}`).toBeTruthy();
      }
    });

    test("minimal prompts stay under 500 chars (token budget)", () => {
      const defs = getMinimalAgentDefinitions();
      for (const [name, def] of Object.entries(defs)) {
        expect(
          def.prompt.length,
          `${name} prompt is ${def.prompt.length} chars`,
        ).toBeLessThan(500);
      }
    });

    test("no extra agents beyond LEGACY_ALIASES", () => {
      const defs = getMinimalAgentDefinitions();
      const defNames = new Set(Object.keys(defs));
      const aliasNames = new Set(Object.keys(LEGACY_ALIASES));
      expect(defNames).toEqual(aliasNames);
    });
  });

  describe("Phase 8: Context Manager — Full Prompt Loading (per agent)", () => {
    const agentNames = Object.keys(LEGACY_ALIASES);

    test.each(agentNames)(
      "getFullAgentPrompt('%s') loads real markdown content",
      (name) => {
        const prompt = getFullAgentPrompt(name);
        expect(prompt.length).toBeGreaterThan(100);
        expect(prompt).not.toContain("Prompt unavailable");
      },
    );

    test.each(agentNames)(
      "buildDelegationPrompt('%s', task) wraps correctly",
      (name) => {
        const taskPrompt = "Test task for verification";
        const result = buildDelegationPrompt(name, taskPrompt);
        expect(result).toContain(taskPrompt);
        expect(result.length).toBeGreaterThan(taskPrompt.length + 100);
      },
    );

    test("ContextManager caching works", () => {
      const cm = new ContextManager();
      const first = cm.getFullAgentPrompt("architect");
      const second = cm.getFullAgentPrompt("architect");
      expect(first).toBe(second);
      cm.clearCache();
      const third = cm.getFullAgentPrompt("architect");
      expect(third).toEqual(first);
    });
  });

  describe("Phase 9: System Prompt Generation", () => {
    test("generateSystemPrompt produces non-empty output", () => {
      const prompt = generateSystemPrompt();
      expect(prompt.length).toBeGreaterThan(200);
    });

    test("system prompt contains agent menu table", () => {
      const prompt = generateSystemPrompt();
      expect(prompt).toContain("## Agent Menu");
      expect(prompt).toContain("| Agent | Model | Use For |");
    });

    test("system prompt includes all composed agents", () => {
      const prompt = generateSystemPrompt();
      const allComposed = composeAllAgents();
      for (const agentName of Object.keys(allComposed)) {
        expect(prompt).toContain(agentName);
      }
    });

    test("system prompt contains orchestration sections", () => {
      const prompt = generateSystemPrompt();
      expect(prompt).toContain("## Identity");
      expect(prompt).toContain("## Orchestration Principles");
      expect(prompt).toContain("## Workflow");
      expect(prompt).toContain("## Critical Rules");
      expect(prompt).toContain("## Completion Checklist");
    });

    test("omcSystemPromptV4 lazy evaluation works", () => {
      const asString = String(omcSystemPromptV4);
      expect(asString.length).toBeGreaterThan(200);
      expect(asString).toContain("## Agent Menu");
    });
  });

  describe("Phase 10: Compat Layer — All Legacy Exports", () => {
    test("architectAgent is valid", () => {
      expect(architectAgent.name).toBeTruthy();
      expect(architectAgent.prompt.length).toBeGreaterThan(0);
      expect(architectAgent.tools.length).toBeGreaterThan(0);
    });

    test("executorAgent is valid", () => {
      expect(executorAgent.name).toBeTruthy();
      expect(executorAgent.prompt.length).toBeGreaterThan(0);
    });

    test("exploreAgent is valid", () => {
      expect(exploreAgent.name).toBeTruthy();
      expect(exploreAgent.prompt.length).toBeGreaterThan(0);
    });

    test("researcherAgent is valid", () => {
      expect(researcherAgent.name).toBeTruthy();
      expect(researcherAgent.prompt.length).toBeGreaterThan(0);
    });

    test("designerAgent is valid", () => {
      expect(designerAgent.name).toBeTruthy();
      expect(designerAgent.prompt.length).toBeGreaterThan(0);
    });

    test("writerAgent is valid", () => {
      expect(writerAgent.name).toBeTruthy();
      expect(writerAgent.prompt.length).toBeGreaterThan(0);
    });

    test("visionAgent is valid", () => {
      expect(visionAgent.name).toBeTruthy();
      expect(visionAgent.prompt.length).toBeGreaterThan(0);
    });

    test("criticAgent is valid", () => {
      expect(criticAgent.name).toBeTruthy();
      expect(criticAgent.prompt.length).toBeGreaterThan(0);
    });

    test("analystAgent is valid", () => {
      expect(analystAgent.name).toBeTruthy();
      expect(analystAgent.prompt.length).toBeGreaterThan(0);
    });

    test("plannerAgent is valid", () => {
      expect(plannerAgent.name).toBeTruthy();
      expect(plannerAgent.prompt.length).toBeGreaterThan(0);
    });

    test("coordinatorAgent (deprecated) is valid", () => {
      expect(coordinatorAgent.name).toBeTruthy();
      expect(coordinatorAgent.prompt.length).toBeGreaterThan(0);
    });

    test("loadAgentPrompt works for all standard roles", () => {
      for (const role of ALL_ROLES) {
        const prompt = loadAgentPrompt(role);
        expect(prompt.length, `Empty prompt for ${role}`).toBeGreaterThan(50);
        expect(prompt).not.toContain("Prompt unavailable");
      }
    });

    test("createAgentToolRestrictions works", () => {
      const result = createAgentToolRestrictions(["Bash", "Write"]);
      expect(result.tools.bash).toBe(false);
      expect(result.tools.write).toBe(false);
    });

    test("mergeAgentConfig works", () => {
      const merged = mergeAgentConfig(architectAgent, {
        model: "sonnet",
        prompt_append: "Extra instructions.",
      });
      expect(merged.model).toBe("sonnet");
      expect(merged.prompt).toContain("Extra instructions.");
    });

    test("validateAgentConfig catches missing fields", () => {
      const errors = validateAgentConfig({} as any);
      expect(errors.length).toBeGreaterThan(0);
    });

    test("validateAgentConfig accepts valid config", () => {
      const errors = validateAgentConfig(architectAgent);
      expect(errors).toHaveLength(0);
    });

    test("deepMerge works", () => {
      const result = deepMerge({ a: 1, b: { c: 2 } }, { b: { d: 3 } } as any);
      expect(result.a).toBe(1);
      expect((result.b as any).c).toBe(2);
      expect((result.b as any).d).toBe(3);
    });

    test("createEnvContext returns env string", () => {
      const ctx = createEnvContext();
      expect(ctx).toContain("env-context");
      expect(ctx).toContain("Timezone");
    });
  });

  describe("Phase 11: Entry Point Integration (src/index.ts)", () => {
    test("getAgentDefinitions (deprecated alias) returns same as getMinimalAgentDefinitions", async () => {
      const mod = await import("../index.js");
      const defs = mod.getAgentDefinitions();
      const minDefs = getMinimalAgentDefinitions();
      expect(Object.keys(defs).sort()).toEqual(Object.keys(minDefs).sort());
    });

    test("omcSystemPrompt (deprecated alias) resolves to V4", async () => {
      const mod = await import("../index.js");
      const prompt = String(mod.omcSystemPrompt);
      expect(prompt).toContain("## Agent Menu");
    });

    test("createSisyphusSession returns valid session", async () => {
      const mod = await import("../index.js");
      const session = mod.createSisyphusSession({
        skipConfigLoad: true,
        skipContextInjection: true,
      });
      expect(session.queryOptions.options.systemPrompt).toContain("Agent Menu");
      expect(
        Object.keys(session.queryOptions.options.agents).length,
      ).toBeGreaterThan(25);

      for (const [name, agent] of Object.entries(
        session.queryOptions.options.agents,
      )) {
        expect(agent.description, `${name} missing description`).toBeTruthy();
        expect(agent.prompt, `${name} missing prompt`).toBeTruthy();
        expect(agent.tools.length, `${name} has no tools`).toBeGreaterThan(0);
      }
    });
  });

  describe("Phase 12: Tool Assignment Verification", () => {
    test("read-only agents do NOT have Write/Edit/Bash", () => {
      const readOnlyRoles = ALL_ROLES.filter((r) => AGENT_ROLES[r].readOnly);
      expect(readOnlyRoles.length).toBeGreaterThan(0);

      for (const role of readOnlyRoles) {
        const tools = AGENT_ROLES[role].baseTools;
        expect(tools).not.toContain("Write");
        expect(tools).not.toContain("Edit");
        expect(tools).not.toContain("Bash");
      }
    });

    test("executor agents HAVE Edit/Write/Bash", () => {
      const executorTools = AGENT_ROLES.executor.baseTools;
      expect(executorTools).toContain("Edit");
      expect(executorTools).toContain("Write");
      expect(executorTools).toContain("Bash");
    });

    test("LOW tier removes expensive tools", () => {
      const lowOverlay = TIER_OVERLAYS.LOW;
      expect(lowOverlay.toolModifiers?.remove).toContain("WebSearch");
      expect(lowOverlay.toolModifiers?.remove).toContain("WebFetch");
    });

    test("HIGH tier adds advanced tools", () => {
      const highOverlay = TIER_OVERLAYS.HIGH;
      expect(highOverlay.toolModifiers?.add).toContain("ast_grep_search");
      expect(highOverlay.toolModifiers?.add).toContain("lsp_find_references");
    });

    test("git-master agent has restricted tool set", () => {
      const defs = getMinimalAgentDefinitions();
      const gitMaster = defs["git-master"];
      expect(gitMaster).toBeDefined();
      expect(gitMaster.tools).toContain("Bash");
      expect(gitMaster.tools).toContain("Read");
    });
  });
});
