/**
 * Tests for the human approval gates (graph runtime v2).
 *
 * Covers y/yes/n/no parsing (case-insensitive, whitespace-trimmed), the
 * single re-prompt for unrecognized input, and fail-closed "denied" on
 * garbage-then-EOF and immediate EOF.
 */
import { PassThrough } from "stream";

import { describe, expect, it } from "vitest";

import {
  createFixedApprovalGate,
  createStdinApprovalGate,
} from "../../runtime/approval.js";
import type { ApprovalRequest } from "../../runtime/types.js";

const REQUEST: ApprovalRequest = {
  run_id: "run-1",
  node_id: "gate-node",
  activation_id: "act-1",
  prompt_text: "Deploy to production?",
};

describe("createStdinApprovalGate", () => {
  it("approves on y", async () => {
    const stdin = new PassThrough();
    stdin.write("y\n");
    const gate = createStdinApprovalGate(stdin);
    await expect(gate.prompt(REQUEST)).resolves.toBe("approved");
  });

  it("denies on n", async () => {
    const stdin = new PassThrough();
    stdin.write("n\n");
    const gate = createStdinApprovalGate(stdin);
    await expect(gate.prompt(REQUEST)).resolves.toBe("denied");
  });

  it("parses answers case-insensitively with surrounding whitespace", async () => {
    const yesStream = new PassThrough();
    yesStream.write("  YES \n");
    const yesGate = createStdinApprovalGate(yesStream);
    await expect(yesGate.prompt(REQUEST)).resolves.toBe("approved");

    const noStream = new PassThrough();
    noStream.write("No\n");
    const noGate = createStdinApprovalGate(noStream);
    await expect(noGate.prompt(REQUEST)).resolves.toBe("denied");
  });

  it("grants one retry so garbage followed by a valid answer counts", async () => {
    const stdin = new PassThrough();
    stdin.write("maybe\n");
    stdin.write("y\n");
    const gate = createStdinApprovalGate(stdin);
    await expect(gate.prompt(REQUEST)).resolves.toBe("approved");
  });

  it("fails closed to denied after garbage followed by EOF", async () => {
    const stdin = new PassThrough();
    stdin.write("banana\n");
    stdin.end();
    const gate = createStdinApprovalGate(stdin);
    await expect(gate.prompt(REQUEST)).resolves.toBe("denied");
  });

  it("fails closed to denied on immediate EOF", async () => {
    const stdin = new PassThrough();
    stdin.end();
    const gate = createStdinApprovalGate(stdin);
    await expect(gate.prompt(REQUEST)).resolves.toBe("denied");
  });
});

describe("createFixedApprovalGate", () => {
  it("always returns the fixed decision without touching streams", async () => {
    const approved = createFixedApprovalGate("approved");
    const denied = createFixedApprovalGate("denied");
    await expect(approved.prompt(REQUEST)).resolves.toBe("approved");
    await expect(denied.prompt(REQUEST)).resolves.toBe("denied");
    await expect(approved.prompt(REQUEST)).resolves.toBe("approved");
  });
});
