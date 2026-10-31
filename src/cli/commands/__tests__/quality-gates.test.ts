import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { PluginConfig } from "../../../shared/types.js";
import { qualityGatesListCommand } from "../quality-gates.js";

describe("omc quality-gates list", () => {
  let project: string;

  beforeEach(() => {
    project = mkdtempSync(join(tmpdir(), "omc-quality-gates-cli-"));
    mkdirSync(join(project, ".claude", "skills", "project-check"), {
      recursive: true,
    });
    writeFileSync(
      join(project, ".claude", "skills", "project-check", "SKILL.md"),
      "---\nname: project-check\n---\n",
    );
  });

  afterEach(() => {
    rmSync(project, { recursive: true, force: true });
  });

  function options() {
    return {
      config: {
        qualityGates: {
          ralplan: [
            { skill: "project-check", mode: "blocking", model: "claude-opus" },
            "missing-check",
          ],
          "code-review": [],
        },
      } as unknown as PluginConfig,
      skillResolution: {
        cwd: project,
        userConfigDir: join(project, "user-claude"),
        omcRoot: join(project, ".omc"),
        bundledSkillsDir: join(project, "bundled"),
        pluginRoot: null,
      },
    };
  }

  it("prints normalized JSON with resolved paths, gate_unavailable warnings, and legacy-key errors", () => {
    const report = JSON.parse(
      qualityGatesListCommand("ralplan", true, options()),
    );
    expect(report.stage).toBe("ralplan");
    expect(report.gates).toEqual([
      {
        skill: "project-check",
        mode: "blocking",
        model: "claude-opus",
        resolvedPath: join(
          project,
          ".claude",
          "skills",
          "project-check",
          "SKILL.md",
        ),
      },
      { skill: "missing-check", mode: "advisory", status: "gate_unavailable" },
    ]);
    expect(report.warnings).toEqual([
      expect.objectContaining({
        gate: "missing-check",
        status: "gate_unavailable",
      }),
    ]);
    expect(report.validationErrors).toEqual([
      expect.objectContaining({
        stage: "code-review",
        error:
          "Legacy stage key 'code-review' is not accepted; use 'omc-review'",
      }),
    ]);
  });

  it("prints unavailable warnings and validation errors in human-readable output", () => {
    const output = qualityGatesListCommand("ralplan", false, options());
    expect(output).toContain(
      "project-check (mode=blocking, model=claude-opus, path=",
    );
    expect(output).toContain(
      "missing-check (mode=advisory, status=gate_unavailable)",
    );
    expect(output).toContain(
      "Warning: Quality gate skill 'missing-check' could not be resolved",
    );
    expect(output).toContain(
      "Legacy stage key 'code-review' is not accepted; use 'omc-review'",
    );
  });
});
