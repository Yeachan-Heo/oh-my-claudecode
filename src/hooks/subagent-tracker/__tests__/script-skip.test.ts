import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

const scriptPath = resolve(process.cwd(), "scripts/subagent-tracker.mjs");

function runTrackerWithSkip(action: "start" | "stop", skipHooks: string): unknown {
  const stdout = execFileSync(process.execPath, [scriptPath, action], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      OMC_SKIP_HOOKS: skipHooks,
    },
    input: "",
    encoding: "utf8",
  });

  return JSON.parse(stdout.trim());
}

describe("subagent-tracker script skip guard", () => {
  it("honors the subagent-stop skip token before reading or importing hook logic", () => {
    expect(runTrackerWithSkip("stop", "keyword-detector, subagent-stop")).toEqual({
      continue: true,
      suppressOutput: true,
    });
  });

  it("honors the umbrella subagent-tracker skip token", () => {
    expect(runTrackerWithSkip("start", "subagent-tracker")).toEqual({
      continue: true,
      suppressOutput: true,
    });
  });
});
