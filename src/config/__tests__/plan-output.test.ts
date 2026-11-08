import { describe, expect, it } from "vitest";
import {
  DEFAULT_PLAN_OUTPUT_DIRECTORY,
  DEFAULT_PLAN_OUTPUT_FILENAME_TEMPLATE,
  getPlanOutputDirectory,
  getPlanOutputFilenameTemplate,
  resolveAutopilotPlanPath,
  resolveOpenQuestionsPlanPath,
  resolvePlanOutputAbsolutePath,
  resolvePlanOutputFilename,
  resolvePlanOutputPath,
} from "../plan-output.js";

describe("plan output helpers", () => {
  it("uses default directory and filename template", () => {
    expect(getPlanOutputDirectory()).toBe(DEFAULT_PLAN_OUTPUT_DIRECTORY);
    expect(getPlanOutputFilenameTemplate()).toBe(
      DEFAULT_PLAN_OUTPUT_FILENAME_TEMPLATE,
    );
  });

  it("renders default artifact paths", () => {
    expect(resolveAutopilotPlanPath()).toBe(".omc/plans/autopilot-impl.md");
    expect(resolveOpenQuestionsPlanPath()).toBe(".omc/plans/open-questions.md");
  });

  it("applies custom directory and filename template", () => {
    const config = {
      planOutput: {
        directory: "docs/plans",
        filenameTemplate: "plan-{{name}}.md",
      },
    };

    expect(resolvePlanOutputFilename("autopilot-impl", config)).toBe(
      "plan-autopilot-impl.md",
    );
    expect(resolvePlanOutputPath("autopilot-impl", config)).toBe(
      "docs/plans/plan-autopilot-impl.md",
    );
  });

  it("falls back safely for invalid directory and filename templates", () => {
    const config = {
      planOutput: {
        directory: "../outside",
        filenameTemplate: "../bad.md",
      },
    };

    expect(resolvePlanOutputPath("Autopilot Impl", config)).toBe(
      ".omc/plans/autopilot-impl.md",
    );
  });

  it("builds absolute paths from the configured relative output path", () => {
    const config = {
      planOutput: {
        directory: "docs/plans",
        filenameTemplate: "{{kind}}.plan.md",
      },
    };

    expect(
      resolvePlanOutputAbsolutePath("/repo", "autopilot-impl", config),
    ).toBe("/repo/docs/plans/autopilot-impl.plan.md");
  });
});
