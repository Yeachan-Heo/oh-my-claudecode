/**
 * Tests for ASCII progress rendering (graph runtime v2).
 *
 * Pins exact rendered strings for all five event kinds and every
 * node_result outcome tag, newline termination per event, and that the
 * reporter writes through an injected stream instead of console.
 */
import { PassThrough } from "stream";

import { describe, expect, it } from "vitest";

import {
  createAsciiProgressReporter,
  renderProgressEvent,
} from "../../runtime/progress.js";
import type { RuntimeProgressEvent } from "../../runtime/types.js";

describe("renderProgressEvent", () => {
  it("renders run_started", () => {
    const event: RuntimeProgressEvent = {
      type: "run_started",
      run_id: "run-abc",
      goal: "deploy the service",
    };
    expect(renderProgressEvent(event)).toBe("[run] run-abc — deploy the service");
  });

  it("renders replayed", () => {
    const event: RuntimeProgressEvent = { type: "replayed", records: 7, epoch: 2 };
    expect(renderProgressEvent(event)).toBe("[replay] 7 record(s) @ epoch 2");
  });

  it("renders activation_started", () => {
    const event: RuntimeProgressEvent = {
      type: "activation_started",
      node_id: "build",
      attempt_no: 3,
    };
    expect(renderProgressEvent(event)).toBe("[node] build attempt #3 started");
  });

  it("renders every node_result outcome tag", () => {
    const cases: ReadonlyArray<[RuntimeProgressEvent, string]> = [
      [{ type: "node_result", node_id: "a", outcome: "succeeded" }, "[ok] a"],
      [{ type: "node_result", node_id: "b", outcome: "failed" }, "[fail] b"],
      [{ type: "node_result", node_id: "c", outcome: "approved" }, "[approved] c"],
      [{ type: "node_result", node_id: "d", outcome: "denied" }, "[denied] d"],
      [{ type: "node_result", node_id: "e", outcome: "join_resolved" }, "[join] e"],
    ];
    for (const [event, expected] of cases) {
      expect(renderProgressEvent(event)).toBe(expected);
    }
  });

  it("renders run_ended", () => {
    const event: RuntimeProgressEvent = {
      type: "run_ended",
      terminal: "succeeded",
      summary: "4 nodes ok",
    };
    expect(renderProgressEvent(event)).toBe("[done] succeeded — 4 nodes ok");
  });
});

describe("createAsciiProgressReporter", () => {
  it("writes each rendered line plus newline via the injected stream", async () => {
    const out = new PassThrough();
    const chunks: string[] = [];
    out.on("data", (chunk) => chunks.push(chunk.toString()));

    const reporter = createAsciiProgressReporter(out);
    reporter.onEvent({ type: "run_started", run_id: "run-1", goal: "g" });
    reporter.onEvent({ type: "activation_started", node_id: "n1", attempt_no: 1 });
    reporter.onEvent({ type: "node_result", node_id: "n1", outcome: "succeeded" });
    reporter.onEvent({ type: "run_ended", terminal: "failed", summary: "boom" });

    await new Promise((resolve) => setImmediate(resolve));
    expect(chunks.join("")).toBe(
      [
        "[run] run-1 — g\n",
        "[node] n1 attempt #1 started\n",
        "[ok] n1\n",
        "[done] failed — boom\n",
      ].join(""),
    );
  });

  it("defaults to process.stdout and does not throw", () => {
    const reporter = createAsciiProgressReporter();
    expect(() =>
      reporter.onEvent({ type: "run_started", run_id: "r-default", goal: "" }),
    ).not.toThrow();
  });
});
