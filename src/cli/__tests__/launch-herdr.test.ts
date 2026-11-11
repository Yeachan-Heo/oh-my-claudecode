/**
 * Tests for the Herdr launch arm in src/cli/launch.ts
 *
 * When the team multiplexer resolves to 'herdr', `omc` launches Claude as a
 * tab in a Herdr workspace instead of a tmux session. The Herdr engine is
 * module-mocked here (unit level); argv-level behavior lives in
 * src/team/__tests__/herdr-session.test.ts.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { execFileSync } from "child_process";

vi.mock("child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("child_process")>();
  return {
    ...actual,
    execFileSync: vi.fn(),
    spawnSync: vi.fn(),
  };
});

const herdrMocks = vi.hoisted(() => ({
  ensureHerdrServer: vi.fn(async () => "running" as const),
  herdrCreateWorkspace: vi.fn(async () => "w9"),
  herdrCreateWorkerTab: vi.fn(async () => ({
    paneId: "w9:p2",
    tabId: "w9:t2",
  })),
  herdrRunPaneCommand: vi.fn(async () => undefined),
}));

vi.mock("../../team/herdr-session.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../team/herdr-session.js")>();
  return {
    ...actual,
    ensureHerdrServer: herdrMocks.ensureHerdrServer,
    herdrCreateWorkspace: herdrMocks.herdrCreateWorkspace,
    herdrCreateWorkerTab: herdrMocks.herdrCreateWorkerTab,
    herdrRunPaneCommand: herdrMocks.herdrRunPaneCommand,
  };
});

vi.mock("../tmux-utils.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../tmux-utils.js")>();
  return {
    ...actual,
    resolveLaunchPolicy: vi.fn(() => "direct" as const),
    buildTmuxSessionName: vi.fn(() => "test-session"),
    isClaudeAvailable: vi.fn(() => true),
    isTmuxAvailable: vi.fn(() => true),
    tmuxExec: vi.fn(),
  };
});

import { runClaude, sanitizeHerdrWorkspaceLabel } from "../launch.js";
import { tmuxExec } from "../tmux-utils.js";

describe("runClaude herdr arm", () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;
  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    // Deterministic dispatch: env override beats plugin config everywhere.
    process.env.OMC_TEAM_MULTIPLEXER = "herdr";
    // Keep the sensitive-env file transport out of the picture.
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_AUTH_TOKEN;
    delete process.env.AWS_SECRET_ACCESS_KEY;
    vi.clearAllMocks();
    stderrSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    stdoutSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    process.env = originalEnv;
    stderrSpy.mockRestore();
    stdoutSpy.mockRestore();
  });

  it("launches Claude in a Herdr workspace tab and prints attach guidance", async () => {
    await runClaude("/tmp", [], "sid");

    expect(herdrMocks.ensureHerdrServer).toHaveBeenCalledTimes(1);
    expect(herdrMocks.herdrCreateWorkspace).toHaveBeenCalledWith(
      "/tmp",
      "test-session",
    );
    expect(herdrMocks.herdrCreateWorkerTab).toHaveBeenCalledWith(
      "w9",
      "/tmp",
      "claude",
    );
    expect(herdrMocks.herdrRunPaneCommand).toHaveBeenCalledWith(
      "w9:p2",
      expect.stringContaining("claude"),
    );
    expect(tmuxExec).not.toHaveBeenCalled();

    const printed = stdoutSpy.mock.calls
      .map((call: unknown[]) => call.join(" "))
      .join("\n");
    expect(printed).toContain('Herdr workspace "test-session"');
    expect(printed).toContain("herdr");
  });

  it("falls back to the default launch flow when the Herdr workspace fails", async () => {
    herdrMocks.herdrCreateWorkspace.mockRejectedValueOnce(
      new Error("herdr_spawn_failed: nope"),
    );

    await runClaude("/tmp", [], "sid");

    expect(herdrMocks.herdrCreateWorkerTab).not.toHaveBeenCalled();
    const errors = stderrSpy.mock.calls
      .map((call: unknown[]) => call.join(" "))
      .join("\n");
    expect(errors).toContain("Herdr launch failed");
    expect(errors).toContain("Falling back");
    // resolveLaunchPolicy is mocked to 'direct': Claude still starts.
    expect(execFileSync).toHaveBeenCalledWith("claude", [], expect.anything());
  });

  it("never routes print mode through Herdr", async () => {
    await runClaude("/tmp", ["--print"], "sid");

    expect(herdrMocks.ensureHerdrServer).not.toHaveBeenCalled();
    expect(herdrMocks.herdrCreateWorkspace).not.toHaveBeenCalled();
    expect(execFileSync).toHaveBeenCalledWith(
      "claude",
      ["--print"],
      expect.anything(),
    );
  });

  it("keeps the tmux/direct flow when the multiplexer is not herdr", async () => {
    process.env.OMC_TEAM_MULTIPLEXER = "tmux";

    await runClaude("/tmp", [], "sid");

    expect(herdrMocks.ensureHerdrServer).not.toHaveBeenCalled();
    expect(herdrMocks.herdrCreateWorkspace).not.toHaveBeenCalled();
    expect(execFileSync).toHaveBeenCalledWith("claude", [], expect.anything());
  });
});

describe("sanitizeHerdrWorkspaceLabel", () => {
  it("keeps the conservative label alphabet and collapses the rest", () => {
    expect(
      sanitizeHerdrWorkspaceLabel("omc-launch-main-detached-20260101"),
    ).toBe("omc-launch-main-detached-20260101");
    expect(sanitizeHerdrWorkspaceLabel("omc-feat/slash br@nch")).toBe(
      "omc-feat-slash-br-nch",
    );
    expect(sanitizeHerdrWorkspaceLabel("  ---omc..x---  ")).toBe("omc..x");
  });

  it("caps length and falls back for empty input", () => {
    expect(sanitizeHerdrWorkspaceLabel("a".repeat(200))).toHaveLength(80);
    expect(sanitizeHerdrWorkspaceLabel("///***///")).toBe("omc-claude");
  });
});
