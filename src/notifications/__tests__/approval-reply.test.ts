/**
 * Approval reply handling: keyword parsing and decision-file resolution
 * via the reply-listener path (Telegram/Discord/Slack reply channels).
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, it } from "vitest";

import { handleApprovalReply, parseApprovalReply } from "../reply-listener.js";

const tempDirs: string[] = [];

function makeRunsRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "omc-approval-reply-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

describe("parseApprovalReply", () => {
  it("maps approval keywords (case-insensitive, first word)", () => {
    expect(parseApprovalReply("approved")).toBe("approved");
    expect(parseApprovalReply("  Approve ")).toBe("approved");
    expect(parseApprovalReply("YES ship it")).toBe("approved");
    expect(parseApprovalReply("批准")).toBe("approved");
  });

  it("maps deny keywords", () => {
    expect(parseApprovalReply("deny")).toBe("denied");
    expect(parseApprovalReply("No")).toBe("denied");
    expect(parseApprovalReply("REJECTED")).toBe("denied");
    expect(parseApprovalReply("拒绝")).toBe("denied");
  });

  it("returns null for non-decision text", () => {
    expect(parseApprovalReply("maybe later")).toBeNull();
    expect(parseApprovalReply("")).toBeNull();
    expect(parseApprovalReply("fix the tests first")).toBeNull();
  });
});

describe("handleApprovalReply", () => {
  it("writes a decision file attributed to the reply channel", () => {
    const runsRoot = makeRunsRoot();
    // The gate creates the run directory when it persists the pending record;
    // decisions are only accepted for runs that exist.
    mkdirSync(join(runsRoot, "run-1"), { recursive: true });
    const decision = handleApprovalReply(
      { runsRoot, runId: "run-1", activationId: "act-1" },
      "approved",
      "telegram",
    );
    expect(decision).toBe("approved");

    const decisionPath = join(runsRoot, "run-1", "approvals", "decisions", "act-1.json");
    expect(existsSync(decisionPath)).toBe(true);
    const record = JSON.parse(readFileSync(decisionPath, "utf8"));
    expect(record).toMatchObject({ decision: "approved", decided_by: "reply:telegram" });
  });

  it("returns null and writes nothing for non-decision text", () => {
    const runsRoot = makeRunsRoot();
    const decision = handleApprovalReply(
      { runsRoot, runId: "run-1", activationId: "act-1" },
      "looks good but wait",
      "discord",
    );
    expect(decision).toBeNull();
    expect(
      existsSync(join(runsRoot, "run-1", "approvals", "decisions", "act-1.json")),
    ).toBe(false);
  });

  it("returns null instead of throwing for a stale approval ref", () => {
    const runsRoot = makeRunsRoot();
    // No run directory: the run ended or the ref is cross-session garbage.
    expect(
      handleApprovalReply(
        { runsRoot, runId: "gone-run", activationId: "act-1" },
        "approved",
        "telegram",
      ),
    ).toBeNull();
  });

  it("does not treat casual chat as a decision", () => {
    expect(parseApprovalReply("lgtm")).toBeNull();
    expect(parseApprovalReply("looks good")).toBeNull();
  });
});
