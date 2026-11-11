/**
 * Integration test against a real `herdr` binary (v0.9.x), self-skipping when
 * herdr is not installed (same policy as the real-tmux suites). Exercises the
 * exact surface the team runtime uses: workspace create, worker tab, pane
 * command delivery, capture, liveness, teardown. Uses a plain shell command
 * (not a coding agent) so no API traffic is generated.
 */

import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { execFile } from "child_process";
import { promisify } from "util";
import {
  HERDR_TEAM_WORKSPACE_LABEL_PREFIX,
  captureHerdrWorkerPane,
  ensureHerdrServer,
  herdrCreateTeamWorkspace,
  herdrCreateWorkerTab,
  herdrPaneWorkspaceMembership,
  herdrRunPaneCommand,
  isHerdrBinaryCallable,
  isHerdrWorkerAlive,
  listHerdrAgents,
  listHerdrTeams,
  resolveHerdrBinary,
  teardownHerdrWorker,
  destroyHerdrTeam,
} from "../herdr-session.js";

const execFileAsync = promisify(execFile);

describe("herdr team session (real herdr)", () => {
  it("creates a workspace and worker tab, delivers a command, captures, and tears down", async () => {
    if (!(await isHerdrBinaryCallable())) return; // skip: herdr not installed

    const dir = mkdtempSync(join(tmpdir(), "omc-herdr-itest-"));
    const serverState = await ensureHerdrServer();
    let teamWorkspaceId: string | null = null;
    try {
      const workspaceId = await herdrCreateTeamWorkspace(
        dir,
        `${HERDR_TEAM_WORKSPACE_LABEL_PREFIX}itest${Date.now().toString(36)}`,
      );
      expect(workspaceId).toMatch(/^w[0-9a-z]+$/i);
      teamWorkspaceId = workspaceId;

      const tab = await herdrCreateWorkerTab(workspaceId, dir, "worker-1");
      expect(tab.paneId).toMatch(/^w[0-9a-z]+:p[0-9a-z]+$/i);

      // Deliver a plain shell command through the pane surface (the team start
      // command rides this path; agents then replace the shell occupant).
      await herdrRunPaneCommand(tab.paneId, "echo OMC_HERDR_E2E_OK");
      await new Promise((resolve) => setTimeout(resolve, 800));
      const captured = await captureHerdrWorkerPane(tab.paneId, 20);
      expect(captured).toContain("OMC_HERDR_E2E_OK");

      const teams = await listHerdrTeams();
      expect(teams.some((team) => team.workspaceId === workspaceId)).toBe(true);

      // A plain shell pane hosts no agent: the inventory proves non-agents are
      // not "alive workers" — liveness is agent-scoped by design.
      expect(await isHerdrWorkerAlive(tab.paneId)).toBe(false);

      await teardownHerdrWorker(tab.paneId);
      await destroyHerdrTeam(workspaceId);
      const teamsAfter = await listHerdrTeams();
      expect(teamsAfter.some((team) => team.workspaceId === workspaceId)).toBe(
        false,
      );
    } finally {
      if (teamWorkspaceId) {
        try {
          await destroyHerdrTeam(teamWorkspaceId);
        } catch {
          /* best-effort */
        }
      }
      rmSync(dir, { recursive: true, force: true });
      if (serverState === "started") {
        // We spawned the headless server for this test; stop it again. The
        // `server stop` command prints no JSON, so bypass the envelope parser.
        const bin = resolveHerdrBinary();
        if (bin) {
          try {
            await execFileAsync(bin, ["server", "stop"]);
          } catch {
            /* best-effort */
          }
        }
      }
    }
  });
  it("exposes the live agent inventory for detector surfaces", async () => {
    if (!(await isHerdrBinaryCallable())) return; // skip: herdr not installed

    const serverState = await ensureHerdrServer();
    try {
      const agents = await listHerdrAgents();
      expect(Array.isArray(agents)).toBe(true);
      // Every inventory entry addresses a pane (the liveness grammar the
      // rate-limit detector keys on).
      for (const agent of agents) {
        expect(typeof agent.pane_id).toBe("string");
        expect(agent.pane_id).toMatch(/^w[0-9a-z]+:p[0-9a-z]+$/i);
      }
    } finally {
      if (serverState === "started") {
        const bin = resolveHerdrBinary();
        if (bin) {
          try {
            await execFileAsync(bin, ["server", "stop"]);
          } catch {
            /* best-effort */
          }
        }
      }
    }
  });
  it("proves workspace membership for agentless panes and foreign panes", async () => {
    if (!(await isHerdrBinaryCallable())) return; // skip: herdr not installed

    const dir = mkdtempSync(join(tmpdir(), "omc-herdr-itest-"));
    const serverState = await ensureHerdrServer();
    let teamWorkspaceId: string | null = null;
    try {
      const workspaceId = await herdrCreateTeamWorkspace(
        dir,
        `${HERDR_TEAM_WORKSPACE_LABEL_PREFIX}member${Date.now().toString(36)}`,
      );
      teamWorkspaceId = workspaceId;
      const tab = await herdrCreateWorkerTab(workspaceId, dir, "worker-1");

      // Fresh tab hosts only a shell; membership must not depend on an agent.
      expect(await herdrPaneWorkspaceMembership(tab.paneId, workspaceId)).toBe(
        "member",
      );
      // A pane id from another workspace is provably not owned by this one.
      expect(
        await herdrPaneWorkspaceMembership("w999999:p999", workspaceId),
      ).toBe("foreign");
      // A closed pane drops out of the workspace pane list.
      await teardownHerdrWorker(tab.paneId);
      expect(await herdrPaneWorkspaceMembership(tab.paneId, workspaceId)).toBe(
        "foreign",
      );
    } finally {
      if (teamWorkspaceId) {
        try {
          await destroyHerdrTeam(teamWorkspaceId);
        } catch {
          /* best-effort */
        }
      }
      rmSync(dir, { recursive: true, force: true });
      if (serverState === "started") {
        const bin = resolveHerdrBinary();
        if (bin) {
          try {
            await execFileAsync(bin, ["server", "stop"]);
          } catch {
            /* best-effort */
          }
        }
      }
    }
  });
});
