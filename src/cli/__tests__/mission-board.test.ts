import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { recordMissionAgentStart } from "../../hud/mission-board.js";

const originalCwd = process.cwd();
const originalSkipParse = process.env.OMC_CLI_SKIP_PARSE;
const originalEnvironment = {
  HOME: process.env.HOME,
  USERPROFILE: process.env.USERPROFILE,
  OMC_STATE_DIR: process.env.OMC_STATE_DIR,
  OMC_DISABLE_MULTIREPO: process.env.OMC_DISABLE_MULTIREPO,
  CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
};
process.env.OMC_CLI_SKIP_PARSE = "1";

afterAll(() => {
  process.chdir(originalCwd);
  if (originalSkipParse === undefined) delete process.env.OMC_CLI_SKIP_PARSE;
  else process.env.OMC_CLI_SKIP_PARSE = originalSkipParse;
  for (const [name, value] of Object.entries(originalEnvironment)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

interface MissionBoardJson {
  missions: Array<{ id: string; source: "session" | "team" }>;
}

function createWorkspace(): string {
  return mkdtempSync(join(tmpdir(), "omc-mission-board-cli-"));
}

function useWorkspace(workspace: string): void {
  process.env.HOME = workspace;
  process.env.USERPROFILE = workspace;
  process.env.OMC_STATE_DIR = "";
  process.env.OMC_DISABLE_MULTIREPO = "1";
  process.env.CLAUDE_CONFIG_DIR = join(workspace, ".claude");
}

function addTeam(workspace: string, teamName: string): void {
  const teamRoot = join(workspace, ".omc", "state", "team", teamName);
  mkdirSync(join(teamRoot, "tasks"), { recursive: true });
  writeFileSync(
    join(teamRoot, "config.json"),
    JSON.stringify({
      name: teamName,
      task: "Implement mission board discovery",
      created_at: "2026-10-29T18:00:00.000Z",
      workers: [{ name: "worker-1", role: "executor", assigned_tasks: ["1"] }],
    }),
  );
  writeFileSync(
    join(teamRoot, "tasks", "1.json"),
    JSON.stringify({
      id: "1",
      subject: "Discover live teams",
      status: "in_progress",
      owner: "worker-1",
    }),
  );
}

async function runMissionBoard(
  workspace: string,
  args: string[] = [],
): Promise<MissionBoardJson> {
  useWorkspace(workspace);
  process.chdir(workspace);
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  try {
    const { buildProgram } = await import("../index.js");
    await buildProgram().parseAsync([
      "node",
      "omc",
      "mission-board",
      ...args,
      "--json",
    ]);
    return JSON.parse(String(log.mock.calls.at(-1)?.[0])) as MissionBoardJson;
  } finally {
    log.mockRestore();
    process.chdir(originalCwd);
  }
}

function expectNoProcessScopedSessionDirectories(workspace: string): void {
  const sessionsRoot = join(workspace, ".omc", "state", "sessions");
  const processScopedDirs = existsSync(sessionsRoot)
    ? readdirSync(sessionsRoot).filter((entry) => entry.startsWith("pid-"))
    : [];
  expect(processScopedDirs).toEqual([]);
}

describe("mission-board CLI", () => {
  it("discovers team missions without persisted session snapshots", async () => {
    const workspace = createWorkspace();
    try {
      useWorkspace(workspace);
      addTeam(workspace, "team-without-session");

      const state = await runMissionBoard(workspace);

      expect(state.missions.map((mission) => mission.id)).toEqual([
        "team:team-without-session",
      ]);
      expectNoProcessScopedSessionDirectories(workspace);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("aggregates session and team missions once without creating process-scoped state", async () => {
    const workspace = createWorkspace();
    try {
      useWorkspace(workspace);
      addTeam(workspace, "team-with-session");
      for (const [sessionId, parentMode] of [
        ["session-with-snapshot", "verification"],
        ["second-session", "planning"],
      ]) {
        recordMissionAgentStart(
          workspace,
          {
            sessionId,
            agentId: "worker-2",
            agentType: "oh-my-claudecode:test-engineer",
            parentMode,
            taskDescription: "Verify session mission aggregation",
            at: "2026-10-29T18:05:00.000Z",
          },
          sessionId,
        );
      }

      const state = await runMissionBoard(workspace);

      expect(
        state.missions.filter((mission) => mission.source === "team"),
      ).toHaveLength(1);
      expect(state.missions.map((mission) => mission.id).sort()).toEqual([
        "session:second-session:planning",
        "session:session-with-snapshot:verification",
        "team:team-with-session",
      ]);
      expectNoProcessScopedSessionDirectories(workspace);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("keeps --session restricted to the selected session while including team missions", async () => {
    const workspace = createWorkspace();
    try {
      useWorkspace(workspace);
      addTeam(workspace, "team-with-explicit-session");
      for (const [sessionId, parentMode] of [
        ["selected-session", "selected-work"],
        ["other-session", "other-work"],
      ]) {
        recordMissionAgentStart(
          workspace,
          {
            sessionId,
            agentId: "worker-3",
            agentType: "oh-my-claudecode:executor",
            parentMode,
            taskDescription: "Verify explicit session selection",
            at: "2026-10-29T18:05:00.000Z",
          },
          sessionId,
        );
      }

      const state = await runMissionBoard(workspace, [
        "--session",
        "selected-session",
      ]);

      expect(state.missions.map((mission) => mission.id).sort()).toEqual([
        "session:selected-session:selected-work",
        "team:team-with-explicit-session",
      ]);
      expectNoProcessScopedSessionDirectories(workspace);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});
