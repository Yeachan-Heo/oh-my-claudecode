/**
 * Unit tests for the Herdr team runtime backend (src/team/herdr-session.ts)
 * and the provider classification helpers (src/team/tmux-session.ts).
 *
 * The Herdr CLI is faked through the injectable execFn — no binary needed.
 * Live integration lives in herdr-session-realherdr.test.ts.
 */

import { describe, expect, it } from "vitest";
import {
  HerdrError,
  HERDR_TEAM_WORKSPACE_LABEL_PREFIX,
  buildPaneReadArgs,
  buildTabCreateArgs,
  buildWorkspaceCreateArgs,
  captureHerdrWorkerPane,
  herdrCreateTeamWorkspace,
  herdrCreateWorkerTab,
  herdrRunPaneCommand,
  herdrSendKey,
  herdrSendPrompt,
  herdrWorkspaceIdFromPaneId,
  herdrWorkspaceIdFromSessionTarget,
  isHerdrWorkerAlive,
  listHerdrTeams,
  parseHerdrEnvelope,
  resolveHerdrBinary,
  teardownHerdrWorker,
} from "../herdr-session.js";
import {
  isHerdrPaneId,
  isHerdrSessionTarget,
  providerForTeamTarget,
  resolveTeamMultiplexer,
} from "../tmux-session.js";

function envelope(id: string, result: unknown): string {
  return JSON.stringify({ id, result });
}

/** Fake exec implementation scripting replies by argv inspection. */
function fakeExec(
  script: (args: string[]) => {
    stdout?: string;
    stderr?: string;
    fail?: Error & { stderr?: string };
  },
) {
  const calls: string[][] = [];
  const fn = (_bin: string, args: string[]) => {
    calls.push(args);
    const reply = script(args);
    if (reply.fail) return Promise.reject(reply.fail);
    return Promise.resolve({
      stdout: reply.stdout ?? "",
      stderr: reply.stderr ?? "",
    });
  };
  return { fn: fn as never, calls };
}

describe("herdr argv builders", () => {
  it("workspace create pins cwd, label, and focus", () => {
    expect(buildWorkspaceCreateArgs("/repo", "omc-team-alpha")).toEqual([
      "workspace",
      "create",
      "--cwd",
      "/repo",
      "--label",
      "omc-team-alpha",
      "--no-focus",
    ]);
  });

  it("tab create always pins the workspace and forwards env", () => {
    expect(
      buildTabCreateArgs("w5", "/repo", "worker-1", {
        OMX_TEAM_WORKER: "a/worker-1",
      }),
    ).toEqual([
      "tab",
      "create",
      "--workspace",
      "w5",
      "--cwd",
      "/repo",
      "--label",
      "worker-1",
      "--env",
      "OMX_TEAM_WORKER=a/worker-1",
      "--no-focus",
    ]);
  });

  it("pane read uses the unwrapped recent source", () => {
    expect(buildPaneReadArgs("w5:p2", 80)).toEqual([
      "pane",
      "read",
      "w5:p2",
      "--source",
      "recent-unwrapped",
      "--lines",
      "80",
    ]);
  });
});

describe("herdr envelope handling", () => {
  it("parses success and error envelopes", () => {
    expect(
      parseHerdrEnvelope('{"id":"cli:agent:list","result":{"agents":[]}}')
        .result,
    ).toEqual({ agents: [] });
    expect(
      parseHerdrEnvelope(
        '{"id":"x","error":{"code":"server_not_running","message":"down"}}',
      ).error?.code,
    ).toBe("server_not_running");
  });

  it("rejects empty and non-JSON output", () => {
    expect(() => parseHerdrEnvelope("")).toThrow(HerdrError);
    expect(() => parseHerdrEnvelope("not json")).toThrow(HerdrError);
  });

  it("maps spawn errors to typed HerdrError with the CLI error code", async () => {
    const { runHerdr } = await import("../herdr-session.js");
    const fail = Object.assign(new Error("agent_name_taken"), {
      stderr: JSON.stringify({
        error: { code: "agent_name_taken", message: "taken" },
      }),
    });
    const fake = fakeExec(() => ({ fail }));
    await expect(
      runHerdr(["agent", "start", "x"], { env: {}, execFn: fake.fn }),
    ).rejects.toThrow(/agent_name_taken/);
  });
});

describe("herdr binary resolution", () => {
  it("falls back to PATH herdr when the pin is not an existing absolute file", () => {
    expect(resolveHerdrBinary({})).toBe("herdr");
    expect(
      resolveHerdrBinary({ HERDR_BIN_PATH: "/opt/herdr/does-not-exist" }),
    ).toBe("herdr");
    expect(resolveHerdrBinary({ HERDR_BIN_PATH: "relative/herdr" })).toBe(
      "herdr",
    );
  });
});

describe("provider classification", () => {
  it("classifies herdr panes and sessions", () => {
    expect(isHerdrPaneId("w5:p2")).toBe(true);
    expect(isHerdrPaneId("%12")).toBe(false);
    expect(isHerdrPaneId("w5:")).toBe(false);
    expect(isHerdrSessionTarget("herdr:w5")).toBe(true);
    expect(isHerdrSessionTarget("cmux:workspace")).toBe(false);
  });

  it("herdr panes never fall through to the cmux branch", () => {
    expect(providerForTeamTarget("herdr:w5", "w5:p2")).toBe("herdr");
    expect(providerForTeamTarget(undefined, "w5:p2")).toBe("herdr");
    expect(providerForTeamTarget("cmux:ws", "surface-1")).toBe("cmux");
    expect(providerForTeamTarget("omc-team-x:1", "%3")).toBe("tmux");
    expect(providerForTeamTarget(undefined, undefined)).toBe("tmux");
  });

  it("resolves the multiplexer from env before config", () => {
    expect(
      resolveTeamMultiplexer(undefined, { OMC_TEAM_MULTIPLEXER: "herdr" }),
    ).toBe("herdr");
    expect(
      resolveTeamMultiplexer(undefined, { OMC_TEAM_MULTIPLEXER: "tmux" }),
    ).toBe("tmux");
    expect(
      resolveTeamMultiplexer("herdr", { OMC_TEAM_MULTIPLEXER: "tmux" }),
    ).toBe("herdr");
    expect(resolveTeamMultiplexer(undefined, {})).toBe("tmux");
  });
});

describe("herdr id derivation", () => {
  it("derives workspace ids from pane ids and session targets", () => {
    expect(herdrWorkspaceIdFromPaneId("w5:p12")).toBe("w5");
    expect(herdrWorkspaceIdFromSessionTarget("herdr:w5")).toBe("w5");
    expect(() => herdrWorkspaceIdFromPaneId("%12")).toThrow(HerdrError);
    expect(() => herdrWorkspaceIdFromSessionTarget("omc-team-x:1")).toThrow(
      HerdrError,
    );
  });
});

describe("herdr team operations", () => {
  it("creates the workspace and returns its id", async () => {
    const fake = fakeExec((args) => {
      if (args[1] === "list")
        return { stdout: envelope("cli:agent:list", { agents: [] }) };
      if (args[0] === "workspace" && args[1] === "create") {
        return {
          stdout: envelope("cli:workspace:create", {
            workspace: { workspace_id: "w9" },
          }),
        };
      }
      return { stdout: envelope("cli:ok", { type: "ok" }) };
    });
    const workspaceId = await herdrCreateTeamWorkspace(
      "/repo",
      "omc-team-alpha",
      { env: {}, execFn: fake.fn },
    );
    expect(workspaceId).toBe("w9");
  });

  it("creates a worker tab pinned to the workspace and returns its pane id", async () => {
    const fake = fakeExec((args) => {
      if (args[0] === "tab" && args[1] === "create") {
        return {
          stdout: envelope("cli:tab:create", {
            tab: { tab_id: "w9:t2" },
            root_pane: { pane_id: "w9:p2" },
          }),
        };
      }
      return { stdout: envelope("cli:ok", {}) };
    });
    const tab = await herdrCreateWorkerTab("w9", "/repo", "worker-1", {
      env: {},
      execFn: fake.fn,
    });
    expect(tab).toEqual({ paneId: "w9:p2", tabId: "w9:t2" });
    expect(fake.calls[0]).toContain("--workspace");
    expect(fake.calls[0]).toContain("w9");
  });

  it("delivers commands via pane run and prompts via agent prompt", async () => {
    const fake = fakeExec(() => ({ stdout: envelope("cli:ok", {}) }));
    await herdrRunPaneCommand("w9:p2", "env A=B claude --args", {
      env: {},
      execFn: fake.fn,
    });
    expect(fake.calls[0]).toEqual([
      "pane",
      "run",
      "w9:p2",
      "env A=B claude --args",
    ]);
    await herdrSendPrompt("w9:p2", "do the thing", {
      env: {},
      execFn: fake.fn,
    });
    expect(fake.calls[1]).toEqual(["agent", "prompt", "w9:p2", "do the thing"]);
    await herdrSendKey("w9:p2", "ctrl+c", { env: {}, execFn: fake.fn });
    expect(fake.calls[2]).toEqual(["agent", "send-keys", "w9:p2", "ctrl+c"]);
  });

  it("captures raw pane text (pane read prints plain text on the CLI)", async () => {
    const fake = fakeExec(() => ({ stdout: "line1\nline2" }));
    const text = await captureHerdrWorkerPane("w9:p2", 80, {
      env: {},
      execFn: fake.fn,
    });
    expect(text).toBe("line1\nline2");
  });

  it("proves liveness through the live-agent inventory", async () => {
    const fake = fakeExec(() => ({
      stdout: envelope("cli:agent:list", {
        agents: [{ pane_id: "w9:p2", agent: "claude" }],
      }),
    }));
    expect(
      await isHerdrWorkerAlive("w9:p2", { env: {}, execFn: fake.fn }),
    ).toBe(true);
    expect(
      await isHerdrWorkerAlive("w9:p3", { env: {}, execFn: fake.fn }),
    ).toBe(false);
  });

  it("propagates inventory failures instead of proving death", async () => {
    const fail = Object.assign(new Error("timed out"), {
      stderr: JSON.stringify({
        error: { code: "server_not_running", message: "down" },
      }),
    });
    const fake = fakeExec(() => ({ fail }));
    await expect(
      isHerdrWorkerAlive("w9:p2", { env: {}, execFn: fake.fn }),
    ).rejects.toThrow(HerdrError);
  });

  it("proves pane existence and workspace membership without a live agent", async () => {
    const { buildWorkspacePaneListArgs, herdrPaneWorkspaceMembership } =
      await import("../herdr-session.js");
    expect(buildWorkspacePaneListArgs("w9")).toEqual([
      "pane",
      "list",
      "--workspace",
      "w9",
    ]);
    const fake = fakeExec(() => ({
      stdout: envelope("cli:pane:list", {
        panes: [{ pane_id: "w9:p2", workspace_id: "w9" }],
      }),
    }));
    // No agent occupies w9:p2 in the inventory above; membership still holds.
    expect(
      await herdrPaneWorkspaceMembership("w9:p2", "w9", {
        env: {},
        execFn: fake.fn,
      }),
    ).toBe("member");
    expect(
      await herdrPaneWorkspaceMembership("w1:p1", "w9", {
        env: {},
        execFn: fake.fn,
      }),
    ).toBe("foreign");
    const failing = fakeExec(() => ({
      fail: Object.assign(new Error("boom"), {
        stderr: JSON.stringify({
          error: { code: "workspace_not_found", message: "gone" },
        }),
      }),
    }));
    expect(
      await herdrPaneWorkspaceMembership("w9:p2", "w9", {
        env: {},
        execFn: failing.fn,
      }),
    ).toBe("unavailable");
  });

  it("tears down panes directly and lists teams by label prefix", async () => {
    const fake = fakeExec((args) => {
      if (args[0] === "workspace" && args[1] === "list") {
        return {
          stdout: envelope("cli:workspace:list", {
            workspaces: [
              { workspace_id: "w1", label: "user-own" },
              {
                workspace_id: "w2",
                label: `${HERDR_TEAM_WORKSPACE_LABEL_PREFIX}alpha`,
              },
            ],
          }),
        };
      }
      return { stdout: envelope("cli:ok", { type: "ok" }) };
    });
    await teardownHerdrWorker("w9:p2", { env: {}, execFn: fake.fn });
    expect(fake.calls[0]).toEqual(["pane", "close", "w9:p2"]);
    const teams = await listHerdrTeams({ env: {}, execFn: fake.fn });
    expect(teams).toEqual([
      { workspaceId: "w2", teamName: "alpha", label: "omc-team-alpha" },
    ]);
  });


});
