/**
 * CommandNodeExecutor tests (worker-4).
 *
 * Deterministic and cross-platform: every spawned command is a
 * `node -e "<js>"` one-liner, so behavior does not depend on the host shell.
 */

import { describe, expect, it } from "vitest";

import { isProcessAlive } from "../../../../platform/process-utils.js";
import { CommandNodeExecutor } from "../../../runtime/executors/command.js";
import type { CommandExecutionOutput } from "../../../runtime/executors/command.js";
import type { NodeExecutionContext } from "../../../runtime/types.js";
import type {
  GraphCommandNode,
  SealedGraphDescriptor,
} from "../../../types.js";

function commandNode(overrides: Partial<GraphCommandNode> = {}): GraphCommandNode {
  return {
    id: "cmd",
    kind: "command",
    title: "Command node",
    timeout_ms: 60_000,
    max_attempts: 3,
    effect_policy: { policy: "side_effect_free" },
    command: "node -e \"process.exit(0)\"",
    ...overrides,
  };
}

function contextFor(
  node: GraphCommandNode,
  overrides: Partial<NodeExecutionContext> = {},
): NodeExecutionContext {
  const descriptor: SealedGraphDescriptor = {
    descriptor_version: 1,
    run_id: "run-test",
    revision_id: "rev-test",
    goal: "test goal",
    nodes: [node],
    edges: [],
    entry_node_ids: [node.id],
    concurrency_limit: 1,
    terminal_verification_node_id: node.id,
    descriptor_hash: "a".repeat(64),
  };
  return {
    descriptor,
    node,
    activation_id: "act-1",
    attempt_id: "att-1",
    attempt_no: 2,
    ...overrides,
  };
}

describe("CommandNodeExecutor", () => {
  it("reports succeeded for an exiting-zero command with evidence", async () => {
    const executor = new CommandNodeExecutor();
    const node = commandNode({ command: "node -e \"process.exit(0)\"" });

    const output = await executor.execute(contextFor(node));

    expect(output.outcome).toBe("succeeded");
    const primary = output.evidence_refs.find((ref) => ref.ref === node.command);
    expect(primary).toBeDefined();
    expect(primary?.kind).toBe("command");
    expect(primary?.summary).toMatch(/exit=0 duration_ms=\d+/);
  });

  it("reports failed for a non-zero exit code", async () => {
    const executor = new CommandNodeExecutor();
    const node = commandNode({ command: "node -e \"process.exit(3)\"" });

    const output = await executor.execute(contextFor(node));

    expect(output.outcome).toBe("failed");
    expect(output.output_summary).toContain("exit=3");
  });

  it("captures stdout excerpts into the summary and evidence", async () => {
    const executor = new CommandNodeExecutor();
    const node = commandNode({
      command: "node -e \"console.log('hello-graph')\"",
    });

    const output = (await executor.execute(
      contextFor(node),
    )) as CommandExecutionOutput;

    expect(output.outcome).toBe("succeeded");
    expect(output.output_summary).toContain("hello-graph");
    const stdoutEvidence = output.evidence_refs.find((ref) =>
      ref.ref.startsWith("stdout:"),
    );
    expect(stdoutEvidence?.summary).toContain("hello-graph");
    expect(output.external_idempotency_key).toBeUndefined();
  });

  it("fails fast on timeout, kills the tree, and leaves no orphaned grandchild", async () => {
    const executor = new CommandNodeExecutor();
    const node = commandNode({
      command:
        "node -e \"console.log('GPID:' + process.pid); setTimeout(()=>{},10000)\"",
      timeout_ms: 300,
    });
    const startedAtMs = Date.now();

    const output = await executor.execute(contextFor(node));

    const elapsedMs = Date.now() - startedAtMs;
    expect(output.outcome).toBe("failed");
    expect(output.output_summary).toContain("timeout after 300ms");
    // Must not wait for the child's own 10s timer to elapse.
    expect(elapsedMs).toBeLessThan(9_000);

    // Deterministic orphan check: the grandchild printed its own PID before
    // sleeping; after the tree kill that process must be gone.
    const gpid = Number(
      /\bGPID:(\d+)\b/.exec(output.output_summary ?? "")?.[1] ?? "0",
    );
    expect(gpid).toBeGreaterThan(0);
    const deadline = Date.now() + 2_000;
    let quiescent = false;
    while (Date.now() < deadline && !quiescent) {
      quiescent = !isProcessAlive(gpid);
      if (!quiescent) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    expect(quiescent).toBe(true);
  }, 20_000);

  it("substitutes idempotency key tokens for idempotent policies", async () => {
    const executor = new CommandNodeExecutor();
    const node = commandNode({
      effect_policy: {
        policy: "idempotent",
        idempotency_key_template: "{run_id}:{node_id}:{attempt_no}",
      },
      command:
        "node -e \"process.stdout.write(process.env.GRAPH_IDEMPOTENCY_KEY ?? '')\"",
    });

    const output = (await executor.execute(
      contextFor(node),
    )) as CommandExecutionOutput;

    expect(output.external_idempotency_key).toBe("run-test:cmd:2");
    expect(output.output_summary).toContain("run-test:cmd:2");
  });

  it("fails closed for reconcile policy instead of executing an unreconciled effect", async () => {
    const executor = new CommandNodeExecutor();
    const node = commandNode({
      effect_policy: { policy: "reconcile" },
      command: "node -e \"throw new Error('must not execute')\"",
    });

    const output = await executor.execute(contextFor(node));

    expect(output.outcome).toBe("failed");
    expect(output.output_summary).toBe(
      "reconcile policy requires a custom executor",
    );
  });

  it("keeps only the tail when stdout exceeds the 2000-char cap", async () => {
    const executor = new CommandNodeExecutor();
    const node = commandNode({
      command:
        "node -e \"console.log('START-MARKER' + '#'.repeat(3000) + 'END-MARKER')\"",
    });

    const output = await executor.execute(contextFor(node));

    expect(output.outcome).toBe("succeeded");
    expect(output.output_summary).toContain("END-MARKER");
    expect(output.output_summary).not.toContain("START-MARKER");
  });

  it("scrubs non-allowlisted env from the child; GRAPH_* passes through", async () => {
    const executor = new CommandNodeExecutor();
    process.env.PARENT_SECRET_TOKEN = "leak-me";
    process.env.GRAPH_TEST_MARKER = "sentinel-ok";
    try {
      const node = commandNode({
        command:
          "node -e \"process.stdout.write(String(process.env['PARENT_SECRET_TOKEN']===undefined)+'|'+String(process.env['GRAPH_TEST_MARKER']))\"",
      });

      const output = await executor.execute(contextFor(node));

      expect(output.outcome).toBe("succeeded");
      expect(output.output_summary).toContain("true|sentinel-ok");
    } finally {
      delete process.env.PARENT_SECRET_TOKEN;
      delete process.env.GRAPH_TEST_MARKER;
    }
  });
});
