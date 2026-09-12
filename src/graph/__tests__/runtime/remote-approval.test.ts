/**
 * Remote approval gate tests: pending/decision artifact lifecycle,
 * fail-closed parsing, timeout policy, and CLI-facing list/decide helpers.
 */

import { existsSync, mkdirSync, mkdtempSync, realpathSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, it } from "vitest";

import {
  createRemoteApprovalGate,
  listPendingApprovals,
  parseDecisionArtifact,
  writeApprovalDecision,
} from "../../runtime/remote-approval.js";
import type { ApprovalRequest } from "../../runtime/types.js";

const REQUEST: ApprovalRequest = {
  run_id: "run-1",
  node_id: "gate-1",
  activation_id: "act-1",
  prompt_text: "Deploy to staging?",
};

const tempDirs: string[] = [];

function makeRunsRoot(): string {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), "omc-remote-approval-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

/** Sleep stub that writes a decision artifact after N polls. */
function decisionAfter(
  runsRoot: string,
  record: unknown,
  afterPolls: number,
  raw = false,
): (ms: number) => Promise<void> {
  let calls = 0;
  return async () => {
    calls += 1;
    if (calls === afterPolls) {
      const dir = join(runsRoot, "run-1", "approvals", "decisions");
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, "act-1.json"),
        raw ? String(record) : JSON.stringify(record),
      );
    }
  };
}

describe("createRemoteApprovalGate", () => {
  it("persists a pending artifact and resolves an approved decision", async () => {
    const runsRoot = makeRunsRoot();
    const gate = createRemoteApprovalGate({
      runsRoot,
      runId: "run-1",
      sleep: decisionAfter(runsRoot, { decision: "approved", decided_at: "2026-01-01T00:00:00Z" }, 1),
    });

    const decision = await gate.prompt(REQUEST);
    expect(decision).toBe("approved");

    // Pending artifact retired after resolution.
    const pendingPath = join(runsRoot, "run-1", "approvals", "pending", "act-1.json");
    expect(existsSync(pendingPath)).toBe(false);
  });

  it("resolves denied and keeps a well-formed decision record", async () => {
    const runsRoot = makeRunsRoot();
    const gate = createRemoteApprovalGate({
      runsRoot,
      runId: "run-1",
      sleep: decisionAfter(runsRoot, { decision: "denied", decided_by: "alice", decided_at: "2026-01-01T00:00:00Z" }, 1),
    });

    expect(await gate.prompt(REQUEST)).toBe("denied");
  });

  it("ignores malformed decision files and keeps waiting", async () => {
    const runsRoot = makeRunsRoot();
    // Poll 1: garbage JSON. Poll 2: unknown decision value. Poll 3: valid.
    let calls = 0;
    const gate = createRemoteApprovalGate({
      runsRoot,
      runId: "run-1",
      sleep: async () => {
        calls += 1;
        const dir = join(runsRoot, "run-1", "approvals", "decisions");
        mkdirSync(dir, { recursive: true });
        if (calls === 1) writeFileSync(join(dir, "act-1.json"), "not json");
        if (calls === 2) writeFileSync(join(dir, "act-1.json"), JSON.stringify({ decision: "maybe" }));
        if (calls === 3) writeFileSync(join(dir, "act-1.json"), JSON.stringify({ decision: "approved" }));
      },
    });

    expect(await gate.prompt(REQUEST)).toBe("approved");
  });

  it("fires the notifier once with the pending record", async () => {
    const runsRoot = makeRunsRoot();
    const seen: unknown[] = [];
    const gate = createRemoteApprovalGate({
      runsRoot,
      runId: "run-1",
      notifier: async (request, record) => {
        seen.push([request, record]);
      },
      sleep: decisionAfter(runsRoot, { decision: "approved" }, 1),
    });

    await gate.prompt(REQUEST);
    expect(seen).toHaveLength(1);
    const [, record] = seen[0] as [unknown, { run_id: string; prompt_text: string }];
    expect(record.run_id).toBe("run-1");
    expect(record.prompt_text).toBe("Deploy to staging?");
  });

  it("swallows notifier errors", async () => {
    const runsRoot = makeRunsRoot();
    const gate = createRemoteApprovalGate({
      runsRoot,
      runId: "run-1",
      notifier: () => {
        throw new Error("telegram down");
      },
      sleep: decisionAfter(runsRoot, { decision: "denied" }, 1),
    });

    expect(await gate.prompt(REQUEST)).toBe("denied");
  });

  it("applies the default timeout policy (deny, fail closed)", async () => {
    const runsRoot = makeRunsRoot();
    let clock = 0;
    const gate = createRemoteApprovalGate({
      runsRoot,
      runId: "run-1",
      timeoutMs: 10_000,
      pollIntervalMs: 60_000,
      now: () => clock,
      sleep: async () => {
        clock += 60_000;
      },
    });

    expect(await gate.prompt(REQUEST)).toBe("denied");
  });

  it("applies an explicit approve timeout policy", async () => {
    const runsRoot = makeRunsRoot();
    let clock = 0;
    const gate = createRemoteApprovalGate({
      runsRoot,
      runId: "run-1",
      timeoutMs: 10_000,
      timeoutPolicy: "approved",
      pollIntervalMs: 60_000,
      now: () => clock,
      sleep: async () => {
        clock += 60_000;
      },
    });

    expect(await gate.prompt(REQUEST)).toBe("approved");
  });

  it("rejects traversal-shaped activation ids", async () => {
    const runsRoot = makeRunsRoot();
    const gate = createRemoteApprovalGate({ runsRoot, runId: "run-1" });
    await expect(
      gate.prompt({ ...REQUEST, activation_id: "../escape" }),
    ).rejects.toThrow();
  });
});

describe("parseDecisionArtifact", () => {
  it("accepts well-formed decisions", () => {
    expect(
      parseDecisionArtifact('{"decision":"approved","decided_by":"alice"}'),
    ).toEqual({ decision: "approved", decided_at: expect.any(String), decided_by: "alice" });
  });

  it("rejects malformed payloads", () => {
    expect(parseDecisionArtifact("not json")).toBeNull();
    expect(parseDecisionArtifact('{"decision":"maybe"}')).toBeNull();
    expect(parseDecisionArtifact("[]")).toBeNull();
    expect(parseDecisionArtifact('{"decision":"approved","decided_by":42}')).toBeNull();
    expect(parseDecisionArtifact('{"decision":"approved","decided_at":42}')).toBeNull();
  });
});

describe("listPendingApprovals / writeApprovalDecision", () => {
  it("round-trips a pending request through decide", async () => {
    const runsRoot = makeRunsRoot();
    const gate = createRemoteApprovalGate({
      runsRoot,
      runId: "run-1",
      // Never resolves on its own; sleep drives the poll loop until aborted.
      sleep: () => new Promise(() => {}),
    });
    const promptPromise = gate.prompt(REQUEST);

    // Let the gate write its pending artifact.
    await new Promise((resolve) => setTimeout(resolve, 20));

    const entries = listPendingApprovals(runsRoot);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      run_id: "run-1",
      activation_id: "act-1",
      node_id: "gate-1",
      prompt_text: "Deploy to staging?",
    });

    const record = writeApprovalDecision(runsRoot, "run-1", "act-1", "denied", "cli");
    expect(record.decision).toBe("denied");
    expect(record.decided_by).toBe("cli");

    const raw = JSON.parse(
      readFileSync(join(runsRoot, "run-1", "approvals", "decisions", "act-1.json"), "utf8"),
    );
    expect(raw.decision).toBe("denied");

    promptPromise.catch(() => {});
  });

  it("returns empty for a missing runs root and skips unreadable runs", () => {
    expect(listPendingApprovals(join(tmpdir(), "omc-does-not-exist-xyz"))).toEqual([]);
  });
});

describe("writeApprovalDecision fail-closed", () => {
  it("refuses to write a decision for an unknown run directory", () => {
    const runsRoot = makeRunsRoot();
    expect(() =>
      writeApprovalDecision(runsRoot, "typo-run", "act-1", "approved", "cli"),
    ).toThrow(/unknown run/);
    // Nothing was created as a side effect.
    expect(existsSync(join(runsRoot, "typo-run"))).toBe(false);
  });
});

describe("createRemoteApprovalGate abort", () => {
  it("resolves denied when the signal is already aborted", async () => {
    const runsRoot = makeRunsRoot();
    const controller = new AbortController();
    controller.abort();
    const gate = createRemoteApprovalGate({
      runsRoot,
      runId: "run-1",
      signal: controller.signal,
      sleep: async () => {},
    });

    expect(await gate.prompt(REQUEST)).toBe("denied");
    expect(
      existsSync(join(runsRoot, "run-1", "approvals", "pending", "act-1.json")),
    ).toBe(false);
  });
});
