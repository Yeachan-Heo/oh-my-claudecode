/**
 * Doc contract for Fable/model-tier discoverability (issue #3738).
 *
 * #3246 added the FABLE family and #3727 widened ModelType so `fable` validates
 * everywhere a tier alias is accepted — but until this contract no shipped
 * documentation surface mentioned fable or explained that the session model
 * selected via `/model` governs only the main loop while delegated agents run
 * on their pinned tier. A user who selected Fable 5 had no discoverable path to
 * run delegated OMC work on Fable, even though three supported config surfaces
 * existed (explicit `model` param, `routing.modelAliases`, `agents.<name>.model`).
 *
 * This locks the documented contract so the resolution-layer support cannot
 * silently outpace the docs again. It intentionally does NOT require any agent
 * to be pinned to fable or inherit: per-agent tier pins are the deliberate
 * routing design (see docs/GETTING-STARTED.md agent table).
 */

import { readFileSync } from "fs";
import { join } from "path";
import { describe, it, expect } from "vitest";

const REPO_ROOT = join(import.meta.dirname, "../..");

const SURFACES: Record<string, string> = {
  "root CLAUDE.md": "CLAUDE.md",
  "shipped docs/CLAUDE.md": "docs/CLAUDE.md",
};

const read = (relativePath: string): string =>
  readFileSync(join(REPO_ROOT, relativePath), "utf-8");

describe("fable routing doc contract (issue #3738)", () => {
  it("root and shipped CLAUDE.md stay identical", () => {
    expect(read("CLAUDE.md")).toBe(read("docs/CLAUDE.md"));
  });

  describe.each(Object.entries(SURFACES))("%s documents the tier contract", (_label, relativePath) => {
    const content = read(relativePath);

    it("lists fable alongside the other tier aliases in <model_routing>", () => {
      const section = content.slice(
        content.indexOf("<model_routing>"),
        content.indexOf("</model_routing>") + "</model_routing>".length,
      );
      for (const alias of ["haiku", "sonnet", "opus", "fable"]) {
        expect(section).toContain(alias);
      }
    });

    it("states that the session model governs the main loop only", () => {
      expect(content).toContain("session model");
      expect(content).toContain("main loop only");
    });

    it("names the production-supported delegation override surface", () => {
      expect(content).toContain("agents.<name>.model");
      // modelAliases is SDK-side only (no consumer on the plugin hook path), so the
      // shipped prompt must not present it as a plugin-session remap surface.
      expect(content).not.toMatch(/modelAliases/);
    });
  });

  it("wiki skill documents fable and the delegation boundary", () => {
    const content = read("skills/wiki/SKILL.md");
    expect(content).toContain("`fable`");
    expect(content).toContain("main loop only");
    expect(content).toContain("agents.<name>.model");
    expect(content).not.toMatch(/modelAliases/);
  });

  it("GETTING-STARTED documents how to run delegated work on fable", () => {
    const content = read("docs/GETTING-STARTED.md");
    const section = content.slice(
      content.indexOf("### Model routing configuration"),
      content.indexOf("### CLAUDE.md configuration"),
    );
    expect(section).not.toBe("");
    expect(section).toContain("`/model` applies to the main conversation loop only");
    expect(section).toContain('"agents": { "planner": { "model": "fable" } }');
    expect(section).toContain("forceInherit");
    expect(section).toContain("| — | fable |");
    // The modelAliases caveat must stay: it is SDK-side only and must stay clearly
    // scoped away from plugin sessions so users do not pick a silent no-op.
    expect(section).toContain("honored by the SDK-side `enforceModel` API");
    expect(section).toContain("plugin hook path does not apply it");
  });
});
