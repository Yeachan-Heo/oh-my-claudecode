import { describe, test, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import { LEGACY_ALIASES, resolveAlias } from "../agents-v4/registry.js";
import { AGENT_ROLES } from "../agents-v4/roles.js";
import {
  getMinimalAgentDefinitions,
  getFullAgentPrompt,
} from "../agents-v4/context-manager.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

describe("V4 Agent Registry Validation", () => {
  test("all legacy aliases resolve to valid role+tier", () => {
    for (const [name, alias] of Object.entries(LEGACY_ALIASES)) {
      expect(alias.role, `Alias ${name} has no role`).toBeTruthy();
      expect(alias.tier, `Alias ${name} has no tier`).toBeTruthy();
      expect(
        AGENT_ROLES[alias.role],
        `Alias ${name} maps to unknown role: ${alias.role}`,
      ).toBeDefined();
    }
  });

  test("minimal definitions cover all legacy aliases", () => {
    const defs = getMinimalAgentDefinitions();
    for (const name of Object.keys(LEGACY_ALIASES)) {
      expect(
        defs[name],
        `Missing minimal definition for: ${name}`,
      ).toBeDefined();
      expect(
        defs[name].prompt.length,
        `Empty prompt for: ${name}`,
      ).toBeGreaterThan(0);
      expect(defs[name].tools.length, `No tools for: ${name}`).toBeGreaterThan(
        0,
      );
      expect(defs[name].model, `No model for: ${name}`).toBeTruthy();
    }
  });

  test("minimal prompts are under budget (short, not full markdown)", () => {
    const defs = getMinimalAgentDefinitions();
    const MAX_MINIMAL_PROMPT_LENGTH = 500;
    for (const [name, def] of Object.entries(defs)) {
      expect(
        def.prompt.length,
        `Minimal prompt for ${name} is ${def.prompt.length} chars — exceeds ${MAX_MINIMAL_PROMPT_LENGTH} budget`,
      ).toBeLessThan(MAX_MINIMAL_PROMPT_LENGTH);
    }
  });

  test("full agent prompt loads markdown content", () => {
    const fullPrompt = getFullAgentPrompt("architect");
    expect(fullPrompt.length).toBeGreaterThan(100);
    expect(fullPrompt).not.toContain("Prompt unavailable");
  });

  test("all roles have markdown files in agents/roles/", () => {
    const rolesDir = path.join(__dirname, "../../agents/roles");
    for (const role of Object.keys(AGENT_ROLES)) {
      const mdPath = path.join(rolesDir, `${role}.md`);
      expect(fs.existsSync(mdPath), `Missing role markdown: ${role}.md`).toBe(
        true,
      );
    }
  });

  test("resolveAlias returns null for unknown names", () => {
    expect(resolveAlias("nonexistent-agent")).toBeNull();
  });
});
