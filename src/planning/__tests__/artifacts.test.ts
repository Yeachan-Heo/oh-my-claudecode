import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  readPlanningArtifacts,
  isPlanningComplete,
  readApprovedExecutionLaunchHint,
  readApprovedExecutionLaunchHintOutcome,
} from "../artifacts.js";
import {
  planningArtifactTimestamp,
  selectMatchingTestSpecsForPrd,
} from "../artifact-names.js";

describe("planning/artifacts", () => {
  let testDir: string;
  let plansDir: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), "artifacts-test-"));
    plansDir = join(testDir, ".omc", "plans");
    mkdirSync(plansDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  function writeValidArtifacts(
    prdName = "prd-feature.md",
    specName = "test-spec-feature.md",
  ): void {
    writeFileSync(
      join(plansDir, prdName),
      [
        "# PRD",
        "",
        "## Acceptance criteria",
        "- done",
        "",
        "## Requirement coverage map",
        "- req -> impl",
        "",
        'omc team 3:claude "implement auth"',
        "",
      ].join("\n"),
    );
    writeFileSync(
      join(plansDir, specName),
      [
        "# Test Spec",
        "",
        "## Unit coverage",
        "- unit",
        "",
        "## Verification mapping",
        "- verify",
        "",
      ].join("\n"),
    );
  }

  describe("readPlanningArtifacts", () => {
    it("returns empty arrays when plans dir does not exist", () => {
      const result = readPlanningArtifacts(join(testDir, "nonexistent"));
      expect(result).toEqual({ prdPaths: [], testSpecPaths: [] });
    });

    it("returns empty arrays when plans dir is empty", () => {
      const result = readPlanningArtifacts(testDir);
      expect(result).toEqual({ prdPaths: [], testSpecPaths: [] });
    });

    it("returns prd paths for prd-*.md files", () => {
      writeFileSync(join(plansDir, "prd-feature.md"), "# PRD");
      const result = readPlanningArtifacts(testDir);
      expect(result.prdPaths).toHaveLength(1);
      expect(result.prdPaths[0]).toContain("prd-feature.md");
    });

    it("returns test-spec paths for test-spec-*.md files", () => {
      writeFileSync(join(plansDir, "test-spec-feature.md"), "# Test Spec");
      const result = readPlanningArtifacts(testDir);
      expect(result.testSpecPaths).toHaveLength(1);
      expect(result.testSpecPaths[0]).toContain("test-spec-feature.md");
    });

    it("ignores non-matching files", () => {
      writeFileSync(join(plansDir, "notes.md"), "# Notes");
      writeFileSync(join(plansDir, "README.txt"), "readme");
      const result = readPlanningArtifacts(testDir);
      expect(result.prdPaths).toHaveLength(0);
      expect(result.testSpecPaths).toHaveLength(0);
    });

    it("returns multiple files sorted descending", () => {
      writeFileSync(join(plansDir, "prd-aaa.md"), "# PRD A");
      writeFileSync(join(plansDir, "prd-bbb.md"), "# PRD B");
      const result = readPlanningArtifacts(testDir);
      expect(result.prdPaths).toHaveLength(2);
      expect(result.prdPaths[0]).toContain("prd-bbb.md");
    });

    it("reads artifacts from .omx/plans when OMX writes the planning outputs", () => {
      const omxPlansDir = join(testDir, ".omx", "plans");
      mkdirSync(omxPlansDir, { recursive: true });
      writeFileSync(join(omxPlansDir, "prd-omx.md"), "# PRD");
      writeFileSync(join(omxPlansDir, "test-spec-omx.md"), "# Test Spec");

      const result = readPlanningArtifacts(testDir);

      expect(result.prdPaths).toHaveLength(1);
      expect(result.prdPaths[0]).toContain(join(".omx", "plans", "prd-omx.md"));
      expect(result.testSpecPaths).toHaveLength(1);
      expect(result.testSpecPaths[0]).toContain(join(".omx", "plans", "test-spec-omx.md"));
    });

    it("prefers the lexicographically latest artifact name across .omc and .omx plan roots", () => {
      const omxPlansDir = join(testDir, ".omx", "plans");
      mkdirSync(omxPlansDir, { recursive: true });
      writeFileSync(join(plansDir, "prd-aaa.md"), "# PRD A");
      writeFileSync(join(omxPlansDir, "prd-zzz.md"), "# PRD Z");

      const result = readPlanningArtifacts(testDir);

      expect(result.prdPaths).toHaveLength(2);
      expect(result.prdPaths[0]).toContain(join(".omx", "plans", "prd-zzz.md"));
      expect(result.prdPaths[1]).toContain(join(".omc", "plans", "prd-aaa.md"));
    });

    it("orders timestamped artifacts after legacy names by timestamp", () => {
      writeFileSync(join(plansDir, "prd-alpha.md"), "# PRD A");
      writeFileSync(join(plansDir, "prd-20260502T090000Z-alpha.md"), "# PRD B");
      writeFileSync(join(plansDir, "prd-20260502T091500Z-alpha.md"), "# PRD C");

      const result = readPlanningArtifacts(testDir);

      expect(result.prdPaths[0]).toContain("prd-20260502T091500Z-alpha.md");
      expect(result.prdPaths[1]).toContain("prd-20260502T090000Z-alpha.md");
      expect(result.prdPaths[2]).toContain("prd-alpha.md");
    });
  });

  describe("artifact names", () => {
    it("formats canonical artifact timestamps without milliseconds", () => {
      expect(planningArtifactTimestamp(new Date("2026-05-02T08:09:10.456Z"))).toBe(
        "20260502T080910Z",
      );
    });

    it("selects exact timestamped test specs for timestamped PRDs", () => {
      const prdPath = join(plansDir, "prd-20260502T080910Z-alpha.md");
      const matching = join(plansDir, "test-spec-20260502T080910Z-alpha.md");
      const stale = join(plansDir, "test-spec-alpha.md");

      expect(selectMatchingTestSpecsForPrd(prdPath, [stale, matching])).toEqual([matching]);
    });
  });

  describe("isPlanningComplete", () => {
    it("returns false when no PRDs", () => {
      expect(
        isPlanningComplete({ prdPaths: [], testSpecPaths: ["spec.md"] }),
      ).toBe(false);
    });

    it("returns false when no test specs", () => {
      expect(
        isPlanningComplete({ prdPaths: ["prd.md"], testSpecPaths: [] }),
      ).toBe(false);
    });

    it("returns false when the latest PRD is missing requirement coverage", () => {
      writeFileSync(
        join(plansDir, "prd-feature.md"),
        ["# PRD", "", "## Acceptance criteria", "- done", ""].join("\n"),
      );
      writeFileSync(
        join(plansDir, "test-spec-feature.md"),
        [
          "# Test Spec",
          "",
          "## Unit coverage",
          "- unit",
          "",
          "## Verification mapping",
          "- verify",
          "",
        ].join("\n"),
      );
      expect(isPlanningComplete(readPlanningArtifacts(testDir))).toBe(false);
    });

    it("returns false when the latest PRD is missing acceptance criteria", () => {
      writeFileSync(
        join(plansDir, "prd-feature.md"),
        ["# PRD", "", "## Requirement coverage map", "- req -> impl", ""].join(
          "\n",
        ),
      );
      writeFileSync(
        join(plansDir, "test-spec-feature.md"),
        [
          "# Test Spec",
          "",
          "## Unit coverage",
          "- unit",
          "",
          "## Verification mapping",
          "- verify",
          "",
        ].join("\n"),
      );
      expect(isPlanningComplete(readPlanningArtifacts(testDir))).toBe(false);
    });

    it("returns false when the latest test spec is missing verification mapping", () => {
      writeFileSync(
        join(plansDir, "prd-feature.md"),
        [
          "# PRD",
          "",
          "## Acceptance criteria",
          "- done",
          "",
          "## Requirement coverage map",
          "- req -> impl",
          "",
        ].join("\n"),
      );
      writeFileSync(
        join(plansDir, "test-spec-feature.md"),
        ["# Test Spec", "", "## Unit coverage", "- unit", ""].join("\n"),
      );
      expect(isPlanningComplete(readPlanningArtifacts(testDir))).toBe(false);
    });

    it("returns false when the latest test spec is missing unit coverage", () => {
      writeFileSync(
        join(plansDir, "prd-feature.md"),
        [
          "# PRD",
          "",
          "## Acceptance criteria",
          "- done",
          "",
          "## Requirement coverage map",
          "- req -> impl",
          "",
        ].join("\n"),
      );
      writeFileSync(
        join(plansDir, "test-spec-feature.md"),
        ["# Test Spec", "", "## Verification mapping", "- verify", ""].join(
          "\n",
        ),
      );
      expect(isPlanningComplete(readPlanningArtifacts(testDir))).toBe(false);
    });

    it("returns false for whitespace-only sections", () => {
      writeFileSync(
        join(plansDir, "prd-feature.md"),
        [
          "# PRD",
          "",
          "## Acceptance criteria",
          "   ",
          "",
          "## Requirement coverage map",
          "- req -> impl",
          "",
        ].join("\n"),
      );
      writeFileSync(
        join(plansDir, "test-spec-feature.md"),
        [
          "# Test Spec",
          "",
          "## Unit coverage",
          "- unit",
          "",
          "## Verification mapping",
          "- verify",
          "",
        ].join("\n"),
      );
      expect(isPlanningComplete(readPlanningArtifacts(testDir))).toBe(false);
    });

    it("returns true when both latest artifacts contain required sections", () => {
      writeValidArtifacts();
      expect(isPlanningComplete(readPlanningArtifacts(testDir))).toBe(true);
    });

    it("requires timestamped PRDs to use matching timestamped test specs", () => {
      writeValidArtifacts(
        "prd-20260502T080910Z-alpha.md",
        "test-spec-alpha.md",
      );
      expect(isPlanningComplete(readPlanningArtifacts(testDir))).toBe(false);

      writeValidArtifacts(
        "prd-20260502T080910Z-alpha.md",
        "test-spec-20260502T080910Z-alpha.md",
      );
      expect(isPlanningComplete(readPlanningArtifacts(testDir))).toBe(true);
    });

    it("treats valid OMX planning artifacts as planning-complete", () => {
      const omxPlansDir = join(testDir, ".omx", "plans");
      mkdirSync(omxPlansDir, { recursive: true });
      writeFileSync(
        join(omxPlansDir, "prd-feature.md"),
        [
          "# PRD",
          "",
          "## Acceptance criteria",
          "- done",
          "",
          "## Requirement coverage map",
          "- req -> impl",
          "",
          'omx team ".omx/plans/ralplan-feature.md"',
          "",
        ].join("\n"),
      );
      writeFileSync(
        join(omxPlansDir, "test-spec-feature.md"),
        [
          "# Test Spec",
          "",
          "## Unit coverage",
          "- unit",
          "",
          "## Verification mapping",
          "- verify",
          "",
        ].join("\n"),
      );

      expect(isPlanningComplete(readPlanningArtifacts(testDir))).toBe(true);
    });

    it("treats required heading matches as case-insensitive", () => {
      writeFileSync(
        join(plansDir, "prd-feature.md"),
        [
          "# PRD",
          "",
          "## ACCEPTANCE CRITERIA",
          "- done",
          "",
          "## requirement coverage map",
          "- req -> impl",
          "",
        ].join("\n"),
      );
      writeFileSync(
        join(plansDir, "test-spec-feature.md"),
        [
          "# Test Spec",
          "",
          "## UNIT COVERAGE",
          "- unit",
          "",
          "## verification mapping",
          "- verify",
          "",
        ].join("\n"),
      );
      expect(isPlanningComplete(readPlanningArtifacts(testDir))).toBe(true);
    });


    it("uses the latest artifacts when older ones were valid", () => {
      writeValidArtifacts("prd-aaa.md", "test-spec-aaa.md");
      writeFileSync(
        join(plansDir, "prd-zzz.md"),
        ["# PRD", "", "## Acceptance criteria", "- done", ""].join("\n"),
      );
      writeFileSync(
        join(plansDir, "test-spec-zzz.md"),
        [
          "# Test Spec",
          "",
          "## Unit coverage",
          "- unit",
          "",
          "## Verification mapping",
          "- verify",
          "",
        ].join("\n"),
      );
      expect(isPlanningComplete(readPlanningArtifacts(testDir))).toBe(false);
    });
  });

  describe("readApprovedExecutionLaunchHint", () => {
    it("returns null when no plans dir", () => {
      const result = readApprovedExecutionLaunchHint(
        join(testDir, "nope"),
        "team",
      );
      expect(result).toBeNull();
    });

    it("returns null when PRD has no launch command", () => {
      writeFileSync(
        join(plansDir, "prd-feature.md"),
        "# PRD\n\nNo commands here.",
      );
      const result = readApprovedExecutionLaunchHint(testDir, "team");
      expect(result).toBeNull();
    });

    it("extracts team launch hint with worker count and agent type", () => {
      writeValidArtifacts();
      const result = readApprovedExecutionLaunchHint(testDir, "team");
      expect(result).not.toBeNull();
      expect(result!.mode).toBe("team");
      expect(result!.task).toBe("implement auth");
      expect(result!.workerCount).toBe(3);
      expect(result!.agentType).toBe("claude");
      expect(result!.linkedRalph).toBe(false);
      expect(result!.sourcePath).toContain("prd-feature.md");
    });

    it("marks launch hints incomplete when planning-complete validation is required", () => {
      writeFileSync(
        join(plansDir, "prd-feature.md"),
        [
          "# PRD",
          "",
          "## Acceptance criteria",
          "- done",
          "",
          "## Requirement coverage map",
          "- req -> impl",
          "",
          'omc team 3:claude "implement auth"',
          "",
        ].join("\n"),
      );

      expect(readApprovedExecutionLaunchHint(testDir, "team")!.task).toBe(
        "implement auth",
      );
      expect(
        readApprovedExecutionLaunchHintOutcome(testDir, "team", {
          requirePlanningComplete: true,
        }),
      ).toEqual({ status: "incomplete" });
    });

    it("resolves launch hints when required planning artifacts are complete", () => {
      writeValidArtifacts();

      const outcome = readApprovedExecutionLaunchHintOutcome(testDir, "team", {
        requirePlanningComplete: true,
      });

      expect(outcome.status).toBe("resolved");
      expect(outcome.status === "resolved" ? outcome.hint.task : null).toBe(
        "implement auth",
      );
    });

    it("extracts team launch hint without worker spec", () => {
      writeFileSync(
        join(plansDir, "prd-feature.md"),
        [
          "# PRD",
          "",
          "## Acceptance criteria",
          "- done",
          "",
          "## Requirement coverage map",
          "- req -> impl",
          "",
          'Run: omc team "implement the feature"',
          "",
        ].join("\n"),
      );
      const result = readApprovedExecutionLaunchHint(testDir, "team");
      expect(result).not.toBeNull();
      expect(result!.task).toBe("implement the feature");
      expect(result!.workerCount).toBeUndefined();
      expect(result!.agentType).toBeUndefined();
    });

    it("resolves exact team launch hints by command when tasks repeat", () => {
      const firstCommand = 'omc team 2:claude "ship it"';
      const secondCommand = 'omc team 4:codex "ship it"';
      writeFileSync(
        join(plansDir, "prd-feature.md"),
        [
          "# PRD",
          "",
          "## Acceptance criteria",
          "- done",
          "",
          "## Requirement coverage map",
          "- req -> impl",
          "",
          `Run: ${firstCommand}`,
          `Run: ${secondCommand}`,
          "",
        ].join("\n"),
      );
      writeFileSync(
        join(plansDir, "test-spec-feature.md"),
        [
          "# Test Spec",
          "",
          "## Unit coverage",
          "- unit",
          "",
          "## Verification mapping",
          "- verify",
          "",
        ].join("\n"),
      );

      expect(readApprovedExecutionLaunchHint(testDir, "team", { task: "ship it" })).toBeNull();
      const result = readApprovedExecutionLaunchHint(testDir, "team", {
        task: "ship it",
        command: secondCommand,
      });

      expect(result).not.toBeNull();
      expect(result!.workerCount).toBe(4);
      expect(result!.agentType).toBe("codex");
      expect(result!.command).toBe(secondCommand);
    });

    it("does not treat ralph-prefixed mode names as ralph launch hints", () => {
      writeFileSync(
        join(plansDir, "prd-feature.md"),
        [
          "# PRD",
          "",
          "## Acceptance criteria",
          "- done",
          "",
          "## Requirement coverage map",
          "- req -> impl",
          "",
          'omc ralph-verify "do the work"',
          "",
        ].join("\n"),
      );
      writeFileSync(
        join(plansDir, "test-spec-feature.md"),
        [
          "# Test Spec",
          "",
          "## Unit coverage",
          "- unit",
          "",
          "## Verification mapping",
          "- verify",
          "",
        ].join("\n"),
      );

      expect(readApprovedExecutionLaunchHint(testDir, "ralph")).toBeNull();
    });

    it("extracts OMX team launch hints from PRDs written under .omx/plans", () => {
      const omxPlansDir = join(testDir, ".omx", "plans");
      mkdirSync(omxPlansDir, { recursive: true });
      writeFileSync(
        join(omxPlansDir, "prd-feature.md"),
        [
          "# PRD",
          "",
          "## Acceptance criteria",
          "- done",
          "",
          "## Requirement coverage map",
          "- req -> impl",
          "",
          'omx team ".omx/plans/ralplan-capture-page-ui-draft-v7.md"',
          "",
        ].join("\n"),
      );

      const result = readApprovedExecutionLaunchHint(testDir, "team");

      expect(result).not.toBeNull();
      expect(result!.task).toBe(".omx/plans/ralplan-capture-page-ui-draft-v7.md");
      expect(result!.command).toBe('omx team ".omx/plans/ralplan-capture-page-ui-draft-v7.md"');
      expect(result!.sourcePath).toContain(join(".omx", "plans", "prd-feature.md"));
    });

    it("detects --linked-ralph flag", () => {
      writeFileSync(
        join(plansDir, "prd-feature.md"),
        [
          "# PRD",
          "",
          "## Acceptance criteria",
          "- done",
          "",
          "## Requirement coverage map",
          "- req -> impl",
          "",
          'omc team 2:codex "fix the bug" --linked-ralph',
          "",
        ].join("\n"),
      );
      const result = readApprovedExecutionLaunchHint(testDir, "team");
      expect(result).not.toBeNull();
      expect(result!.linkedRalph).toBe(true);
    });

    it("extracts ralph launch hint", () => {
      writeFileSync(
        join(plansDir, "prd-feature.md"),
        [
          "# PRD",
          "",
          "## Acceptance criteria",
          "- done",
          "",
          "## Requirement coverage map",
          "- req -> impl",
          "",
          'omc ralph "do the work"',
          "",
        ].join("\n"),
      );
      const result = readApprovedExecutionLaunchHint(testDir, "ralph");
      expect(result).not.toBeNull();
      expect(result!.mode).toBe("ralph");
      expect(result!.task).toBe("do the work");
    });

    it("returns null for ralph mode when only team command present", () => {
      writeValidArtifacts();
      const result = readApprovedExecutionLaunchHint(testDir, "ralph");
      expect(result).toBeNull();
    });

    it("still parses launch hints even when quality gates fail", () => {
      writeFileSync(
        join(plansDir, "prd-feature.md"),
        '# PRD\n\nRun: omc team "new task"\n',
      );
      writeFileSync(
        join(plansDir, "test-spec-feature.md"),
        [
          "# Test Spec",
          "",
          "## Unit coverage",
          "- unit",
          "",
          "## Verification mapping",
          "- verify",
          "",
        ].join("\n"),
      );
      expect(isPlanningComplete(readPlanningArtifacts(testDir))).toBe(false);
      expect(readApprovedExecutionLaunchHint(testDir, "team")!.task).toBe(
        "new task",
      );
    });
  });
});
