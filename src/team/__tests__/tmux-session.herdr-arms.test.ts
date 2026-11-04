/**
 * Herdr provider arms in src/team/tmux-session.ts (Codex review fixes).
 *
 * Covers the ownership proof (workspace membership, not agent liveness),
 * copy-mode observation, owned liveness dispatch, and owned pane teardown.
 * The Herdr engine runs for real with an injected fake exec; the tmux
 * utilities are module-mocked so no tmux binary is required.
 */

import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

const tmuxMocks = vi.hoisted(() => ({
  tmuxCmdAsync: vi.fn(),
}));

vi.mock("../../cli/tmux-utils.js", () => ({
  tmuxExec: vi.fn(),
  tmuxExecAsync: vi.fn(),
  tmuxShell: vi.fn(),
  tmuxCmdAsync: tmuxMocks.tmuxCmdAsync,
}));

const herdrMocks = vi.hoisted(() => ({
  herdrClosePane: vi.fn(),
  isHerdrWorkerAlive: vi.fn(),
  herdrPaneWorkspaceMembership: vi.fn(),
  herdrCreateWorkerTab: vi.fn(),
}));

vi.mock("../herdr-session.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../herdr-session.js")>();
  return {
    ...actual,
    herdrClosePane: herdrMocks.herdrClosePane,
    isHerdrWorkerAlive: herdrMocks.isHerdrWorkerAlive,
    herdrCreateWorkerTab: herdrMocks.herdrCreateWorkerTab,
    // Passthrough by default so exec-injection tests exercise the real
    // membership logic; individual tests shortcut it where the call site
    // offers no dependency injection (killOwnedWorkerPane).
    herdrPaneWorkspaceMembership:
      herdrMocks.herdrPaneWorkspaceMembership.mockImplementation(((
        paneId: string,
        workspaceId: string,
        options?: { execFn?: unknown },
      ) =>
        actual.herdrPaneWorkspaceMembership(
          paneId,
          workspaceId,
          options as never,
        )) as never),
  };
});

import {
  getOwnedWorkerLiveness,
  getWorkerLiveness,
  killOwnedWorkerPane,
  paneCopyModeObservation,
  splitTeamWorkerPaneWithEvidence,
  verifyTeamTargetOwnership,
  type MailboxTargetOwnershipDependencies,
  type WorkerPaneOwnership,
} from "../tmux-session.js";
import type { MailboxNotificationTarget } from "../mailbox-notification-guard.js";

function envelope(id: string, result: unknown): string {
  return JSON.stringify({ id, result });
}

/** Fake herdr exec (execFile shape) scripting `pane list --workspace` replies. */
function fakeHerdrExec(reply: {
  panes?: string[];
  fail?: Error & { stderr?: string };
}) {
  const calls: string[][] = [];
  const fn = (_bin: string, args: string[]) => {
    calls.push(args);
    if (reply.fail) return Promise.reject(reply.fail);
    return Promise.resolve({
      stdout: envelope("cli:pane:list", {
        panes: (reply.panes ?? []).map((paneId) => ({
          pane_id: paneId,
          workspace_id: args[3],
        })),
      }),
      stderr: "",
    });
  };
  return { fn: fn as never, calls };
}

function herdrDependencies(
  herdrExec: MailboxTargetOwnershipDependencies["herdrExec"],
): MailboxTargetOwnershipDependencies {
  return {
    tmuxExec: vi.fn(async () => ({ stdout: "", stderr: "" })),
    cmuxExec: vi.fn(async () => ({ stdout: "", stderr: "" })),
    herdrExec,
  };
}

function herdrTarget(): MailboxNotificationTarget {
  return {
    provider: "herdr",
    providerTarget: "herdr:w2",
    recipient: "worker-1",
    recipientRole: "worker",
    paneId: "w2:p5",
    workerIndex: 1,
  };
}

function herdrOwnership(): WorkerPaneOwnership {
  return {
    provider: "herdr",
    providerTarget: "herdr:w2",
    paneId: "w2:p5",
    splitTarget: "w2:p4",
    leaderPaneId: "w1:p1",
    reservedPaneIds: [],
    source: "split",
  };
}

beforeEach(() => {
  herdrMocks.herdrClosePane.mockReset();
  herdrMocks.isHerdrWorkerAlive.mockReset();
  herdrMocks.herdrPaneWorkspaceMembership.mockClear();
});

describe("verifyTeamTargetOwnership herdr arm", () => {
  it("proves pre-launch ownership through workspace membership, not agent liveness", async () => {
    // The fresh worker tab hosts only a shell: no agent occupies it yet.
    // Membership in the configured workspace list is the ownership proof.
    const fake = fakeHerdrExec({ panes: ["w2:p4", "w2:p5"] });
    const ownership = await verifyTeamTargetOwnership(
      herdrTarget(),
      herdrDependencies(fake.fn),
    );
    expect(ownership).toEqual({
      kind: "owned",
      provider: "herdr",
      providerTarget: "herdr:w2",
      paneId: "w2:p5",
    });
    // The proof queries the configured workspace's live pane list.
    expect(fake.calls[0]).toEqual(["pane", "list", "--workspace", "w2"]);
  });

  it("reports foreign only for a successfully answered exclusion", async () => {
    const fake = fakeHerdrExec({ panes: ["w2:p4"] });
    expect(
      await verifyTeamTargetOwnership(
        herdrTarget(),
        herdrDependencies(fake.fn),
      ),
    ).toEqual({ kind: "foreign" });
  });

  it("reports unavailable when the workspace query fails", async () => {
    const fail = Object.assign(new Error("server down"), {
      stderr: JSON.stringify({
        error: { code: "server_not_running", message: "down" },
      }),
    });
    const fake = fakeHerdrExec({ fail });
    expect(
      await verifyTeamTargetOwnership(
        herdrTarget(),
        herdrDependencies(fake.fn),
      ),
    ).toEqual({ kind: "unavailable" });
  });
});

describe("paneCopyModeObservation herdr arm", () => {
  it("answers definitively not-in-copy-mode for herdr panes without a tmux identity", async () => {
    // Herdr panes have no tmux copy mode; null here would fail
    // waitForStartupPaneReady with copy_mode_unknown before any capture.
    expect(await paneCopyModeObservation("w2:p5", undefined)).toBe(false);
    // tmux panes without a server identity remain unknown.
    expect(await paneCopyModeObservation("%5", undefined)).toBeNull();
  });
});

describe("herdr worker liveness", () => {
  it("proves alive and dead only from an answered inventory", async () => {
    herdrMocks.isHerdrWorkerAlive.mockResolvedValueOnce(true);
    expect(await getWorkerLiveness("w2:p5")).toBe("alive");
    herdrMocks.isHerdrWorkerAlive.mockResolvedValueOnce(false);
    expect(await getWorkerLiveness("w2:p5")).toBe("dead");
  });

  it("reports unknown when the herdr inventory query fails", async () => {
    herdrMocks.isHerdrWorkerAlive.mockRejectedValueOnce(
      new Error("herdr_server_not_running"),
    );
    expect(await getWorkerLiveness("w2:p5")).toBe("unknown");
  });

  it("dispatches owned herdr liveness through the herdr backend", async () => {
    // Before the herdr arm, owned herdr liveness skipped only cmux and then
    // returned 'unknown' at the tmux identity guard — even for a live worker.
    herdrMocks.isHerdrWorkerAlive.mockResolvedValueOnce(true);
    expect(await getOwnedWorkerLiveness(herdrOwnership())).toBe("alive");
    expect(herdrMocks.isHerdrWorkerAlive).toHaveBeenCalledWith("w2:p5");
    herdrMocks.isHerdrWorkerAlive.mockRejectedValueOnce(new Error("timeout"));
    expect(await getOwnedWorkerLiveness(herdrOwnership())).toBe("unknown");
  });
});

describe("killOwnedWorkerPane herdr arm", () => {
  it("closes owned herdr panes through herdrClosePane", async () => {
    // Membership is proven (shortcut: no exec injection point here), then
    // teardown must route to herdrClosePane instead of the guarded tmux
    // kill-pane, which would fail owned_pane_tmux_server_guard_failed.
    herdrMocks.herdrPaneWorkspaceMembership.mockResolvedValueOnce("member");
    herdrMocks.herdrClosePane.mockResolvedValueOnce(undefined);
    await expect(
      killOwnedWorkerPane(herdrOwnership()),
    ).resolves.toBeUndefined();
    expect(herdrMocks.herdrClosePane).toHaveBeenCalledWith("w2:p5");
  });

  it("refuses teardown when herdr membership cannot be proven", async () => {
    herdrMocks.herdrPaneWorkspaceMembership.mockResolvedValueOnce(
      "unavailable",
    );
    await expect(killOwnedWorkerPane(herdrOwnership())).rejects.toThrow(
      /owned_pane_membership_unverified/,
    );
    expect(herdrMocks.herdrClosePane).not.toHaveBeenCalled();
  });
});

describe("splitTeamWorkerPaneWithEvidence herdr workspace threading", () => {
  beforeEach(() => {
    herdrMocks.herdrCreateWorkerTab.mockReset();
    herdrMocks.herdrCreateWorkerTab.mockResolvedValue({
      paneId: "w2:p7",
      tabId: "w2:t7",
    });
  });

  it("allocates in the explicitly provided team workspace, not the leader's", async () => {
    // The leader occupies w1:p1 while the team workspace is herdr:w2; the
    // persisted workspace argument must win over derivation from the split
    // target (spawnV2Worker/scaleUpOwned/recovery all thread it).
    const evidence = await splitTeamWorkerPaneWithEvidence(
      "w1:p1",
      "right",
      "/repo",
      "herdr",
      undefined,
      undefined,
      "w2",
    );
    expect(evidence).toMatchObject({
      commandSucceeded: true,
      provider: "herdr",
      paneId: "w2:p7",
    });
    expect(herdrMocks.herdrCreateWorkerTab).toHaveBeenCalledWith(
      "w2",
      "/repo",
      "worker-split",
    );
  });

  it("still derives the workspace from a herdr split target when omitted", async () => {
    await splitTeamWorkerPaneWithEvidence(
      "w2:p5",
      "down",
      "/repo",
      "herdr",
      undefined,
      undefined,
      undefined,
    );
    expect(herdrMocks.herdrCreateWorkerTab).toHaveBeenCalledWith(
      "w2",
      "/repo",
      "worker-split",
    );
  });

  it("refuses without any workspace when the split target is not a herdr pane", async () => {
    const evidence = await splitTeamWorkerPaneWithEvidence(
      "%5",
      "right",
      "/repo",
      "herdr",
      undefined,
      undefined,
      undefined,
    );
    expect(evidence).toMatchObject({
      commandSucceeded: false,
      stderr: "herdr_workspace_unknown",
      paneId: null,
    });
    expect(herdrMocks.herdrCreateWorkerTab).not.toHaveBeenCalled();
  });
});

describe("herdr split callers thread the persisted team workspace", () => {
  // Source-level assertions (same pattern as the adaptive-retry source
  // test): spawnV2Worker, the recovery saga, and scaleUpOwned must hand the
  // PERSISTED workspace id (derived from the session target) to the splitter
  // instead of letting it derive one from the leader pane, and must exempt
  // the herdr leader pane from the in-workspace membership proof.
  const whitespaceCollapsed = (source: string): string =>
    source.replace(/\s+/g, " ");
  const runtimeSource = readFileSync(
    new URL("../runtime-v2.ts", import.meta.url),
    "utf8",
  );
  const scalingSource = readFileSync(
    new URL("../scaling.ts", import.meta.url),
    "utf8",
  );

  it("spawnV2Worker threads the session workspace and exempts the leader split target", () => {
    expect(runtimeSource).toContain(
      "herdrWorkspaceIdFromSessionTarget(opts.sessionName)",
    );
    expect(runtimeSource).toContain(
      'launchProvider === "herdr" && splitTarget === opts.leaderPaneId',
    );
  });

  it("the recovery saga classifies the provider and threads the workspace", () => {
    expect(whitespaceCollapsed(runtimeSource)).toContain(
      "providerForTeamTarget( owner.config.tmux_session!, splitTarget, )",
    );
    expect(runtimeSource).toContain(
      "herdrWorkspaceIdFromSessionTarget(owner.config.tmux_session!)",
    );
  });

  it("scaleUpOwned threads the configured workspace and adopts herdr panes as herdr", () => {
    expect(scalingSource).toContain(
      "herdrWorkspaceIdFromSessionTarget(config.tmux_session)",
    );
    expect(scalingSource).toContain(
      "providerForTeamTarget(config.tmux_session, paneId)",
    );
  });
});
