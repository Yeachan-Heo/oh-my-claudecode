/**
 * Unit tests for the agent node executor. All SDK interactions go through
 * injected fakes — zero network in CI.
 */

import { describe, expect, it } from "vitest";
import { sealGraphDescriptor } from "../../../descriptor.js";
import { approvalDescriptor } from "../../fixtures.js";
import { AgentNodeExecutor } from "../../../runtime/executors/agent.js";
import type {
  NodeExecutionContext,
  NodeExecutionOutput,
} from "../../../runtime/types.js";
import type { GraphAgentNode } from "../../../types.js";

function makeContext(overrides?: Partial<NodeExecutionContext>): NodeExecutionContext {
  const descriptor = sealGraphDescriptor(approvalDescriptor());
  const node = descriptor.nodes.find((n) => n.id === "entry") as GraphAgentNode;
  return {
    descriptor,
    node,
    activation_id: "act-1",
    attempt_id: "att-1",
    attempt_no: 1,
    ...overrides,
  };
}

describe("AgentNodeExecutor", () => {
  it("succeeds and summarizes final text from a fake stream", async () => {
    let receivedOptions: unknown;
    const executor = new AgentNodeExecutor(async function* (
      options: unknown,
    ) {
      receivedOptions = options;
      yield {
        type: "assistant",
        message: { content: [{ type: "text", text: "Analysis complete." }] },
      };
      yield {
        type: "result",
        subtype: "success",
        is_error: false,
        result: "Analysis complete.",
      };
    });

    const output: NodeExecutionOutput = await executor.execute(makeContext());

    expect(output.outcome).toBe("succeeded");
    expect(output.output_summary).toContain("Analysis complete.");
    expect(output.evidence_refs).toEqual([
      {
        kind: "url",
        ref: "agent://act-1",
        summary: "agent attempt att-1",
      },
    ]);
    expect(receivedOptions).toMatchObject({
      prompt: expect.stringContaining("\n\nGoal: Verify human approval gate"),
      options: {
        cwd: process.cwd(),
        tools: ["Read", "Glob", "Grep"],
        permissionMode: "dontAsk",
        additionalDirectories: [],
        persistSession: false,
      },
    });
    expect((receivedOptions as { options: { env: NodeJS.ProcessEnv } }).options.env)
      .not.toHaveProperty("PARENT_SECRET_TOKEN");
  });

  it("fails when the query throws", async () => {
    const executor = new AgentNodeExecutor(() => {
      throw new Error("boom");
    });

    const output = await executor.execute(makeContext());

    expect(output.outcome).toBe("failed");
    expect(output.output_summary).toContain("error:");
    expect(output.output_summary).toContain("boom");
  });

  it("fails with timeout noted when timeout fires before the impl settles", async () => {
    const executor = new AgentNodeExecutor(
      (_options: unknown) => new Promise(() => {}), // never settles
    );

    const base = makeContext();
    const output = await executor.execute({
      ...base,
      node: { ...base.node, timeout_ms: 10 },
    });

    expect(output.outcome).toBe("failed");
    expect(output.output_summary).toBe("timeout after 10ms");
  });

  it("aborts and interrupts a streaming query at the timeout boundary", async () => {
    let interrupted = 0;
    let signal: AbortSignal | undefined;
    const query = {
      [Symbol.asyncIterator]() {
        return this;
      },
      next: () => new Promise<never>(() => {}),
      interrupt: async () => {
        interrupted += 1;
      },
    };
    const executor = new AgentNodeExecutor((options: unknown) => {
      signal =
        (options as { options: { abortController: AbortController } }).options
          .abortController.signal;
      return query;
    });

    const base = makeContext();
    const output = await executor.execute({
      ...base,
      node: { ...base.node, timeout_ms: 10 },
    });

    expect(output.output_summary).toBe("timeout after 10ms");
    expect(signal?.aborted).toBe(true);
    expect(interrupted).toBe(1);
  });

  it("fails on empty response", async () => {
    const executor = new AgentNodeExecutor(async function* () {});

    const output = await executor.execute(makeContext());

    expect(output.outcome).toBe("failed");
    expect(output.output_summary).toBe("empty response");
  });

  it("truncates summaries to 2000 characters", async () => {
    const long = "x".repeat(3000);
    const executor = new AgentNodeExecutor(async function* () {
      yield {
        type: "assistant",
        message: { content: [{ type: "text", text: long }] },
      };
    });

    const output = await executor.execute(makeContext());

    expect(output.outcome).toBe("succeeded");
    expect(output.output_summary?.length).toBe(2000);
  });

  it("accumulates multi-message streams instead of keeping only the last chunk", async () => {
    const executor = new AgentNodeExecutor(async function* () {
      yield {
        type: "assistant",
        message: { content: [{ type: "text", text: "part one." }] },
      };
      yield {
        type: "assistant",
        message: { content: [{ type: "text", text: "part two." }] },
      };
    });

    const output = await executor.execute(makeContext());

    expect(output.outcome).toBe("succeeded");
    expect(output.output_summary).toContain("part one.");
    expect(output.output_summary).toContain("part two.");
  });

  it("rejects reconcile policy without invoking the SDK", async () => {
    let invoked = false;
    const executor = new AgentNodeExecutor(() => {
      invoked = true;
      return Promise.resolve({});
    });
    const base = makeContext();
    const output = await executor.execute({
      ...base,
      node: { ...base.node, effect_policy: { policy: "reconcile" } },
    });

    expect(output.outcome).toBe("failed");
    expect(output.output_summary).toBe(
      "reconcile policy requires a custom executor",
    );
    expect(invoked).toBe(false);
  });

  it("surfaces an idempotency key before the agent effect starts", async () => {
    let receivedOptions: unknown;
    const executor = new AgentNodeExecutor(async function* (options: unknown) {
      receivedOptions = options;
      yield {
        type: "assistant",
        message: { content: [{ type: "text", text: "read-only result" }] },
      };
    });
    const base = makeContext();
    const output = await executor.execute({
      ...base,
      node: {
        ...base.node,
        effect_policy: {
          policy: "idempotent",
          idempotency_key_template: "{run_id}:{activation_id}",
        },
      },
    });

    expect(output.external_idempotency_key).toBe("run-approval:act-1");
    expect(
      (receivedOptions as { options: { env: NodeJS.ProcessEnv } }).options.env
        .GRAPH_IDEMPOTENCY_KEY,
    ).toBe("run-approval:act-1");
  });
});
