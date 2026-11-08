/**
 * Runtime runner tests: orchestration loop over FileJournal/FileOwnershipFence/
 * FileProjectionStore with scripted executors (worker-6 brief).
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync, realpathSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, it } from "vitest";

import { canonicalJson, sealGraphDescriptor } from "../../descriptor.js";
import { isGraphSucceeded } from "../../scheduler.js";
import { runGraph } from "../../runtime/runner.js";
import { FileJournal } from "../../runtime/journal.js";
import { FileProjectionStore } from "../../runtime/store.js";
import { EXIT_CODES } from "../../runtime/types.js";
import type {
  NodeExecutionContext,
  NodeExecutionOutput,
  NodeExecutor,
  ProgressReporter,
  RunResult,
  RuntimeProgressEvent,
} from "../../runtime/types.js";
import type {
  GraphDescriptorInput,
} from "../../types.js";
import {
  approvalDescriptor,
  executableNode,
  forkJoinDescriptor,
} from "../fixtures.js";

const tempDirs: string[] = [];

function makeRunsRoot(): string {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), "omc-runner-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop() as string, { recursive: true, force: true });
  }
});

function okOutput(nodeId: string): NodeExecutionOutput {
  return {
    outcome: "succeeded",
    output_summary: `ok:${nodeId}`,
    evidence_refs: [{ kind: "command", ref: `cmd:${nodeId}` }],
  };
}

function failedOutput(nodeId: string): NodeExecutionOutput {
  return {
    outcome: "failed",
    output_summary: `boom:${nodeId}`,
    evidence_refs: [{ kind: "command", ref: `cmd:${nodeId}` }],
  };
}

/** Executor with per-node scripted behavior and an invocation log. */
class ScriptedExecutor implements NodeExecutor {
  readonly kinds = ["agent", "command"] as const;
  readonly calls: string[] = [];

  constructor(
    private readonly behavior: (
      nodeId: string,
    ) => Promise<NodeExecutionOutput> | NodeExecutionOutput,
  ) {}

  async execute(context: NodeExecutionContext): Promise<NodeExecutionOutput> {
    this.calls.push(context.node.id);
    return this.behavior(context.node.id);
  }
}

function allSucceed(): ScriptedExecutor {
  return new ScriptedExecutor((nodeId) => okOutput(nodeId));
}

function makeReporter(): {
  reporter: ProgressReporter;
  events: RuntimeProgressEvent[];
} {
  const events: RuntimeProgressEvent[] = [];
  return { reporter: { onEvent: (event) => void events.push(event) }, events };
}

function linearDescriptor(): GraphDescriptorInput {
  return {
    descriptor_version: 1,
    run_id: "run-runner-linear",
    revision_id: "rev-runner-linear",
    goal: "runner linear chain",
    nodes: [
      executableNode("a", "command"),
      executableNode("b", "command"),
      executableNode("term", "command"),
    ],
    edges: [
      { id: "e-a-b", kind: "fixed", from: "a", to: "b" },
      { id: "e-b-term", kind: "fixed", from: "b", to: "term" },
    ],
    entry_node_ids: ["a"],
    concurrency_limit: 1,
    terminal_verification_node_id: "term",
  };
}

describe("runGraph", () => {
  it("runs a linear 3-command graph to success with journal + snapshot", async () => {
    // Arrange
    const runsRoot = makeRunsRoot();
    const sealed = sealGraphDescriptor(linearDescriptor());
    const executor = allSucceed();
    const { reporter, events } = makeReporter();

    // Act
    const result = await runGraph(sealed, {
      runsRoot,
      executors: [executor],
      prompter: { prompt: async () => "approved" },
      reporter,
    });
    const journal = new FileJournal(runsRoot, sealed.run_id);
    const records = await journal.readAll();
    const store = new FileProjectionStore(runsRoot, sealed.run_id);
    const snapshot = await store.load();

    // Assert
    expect(result.terminal).toBe("succeeded");
    expect(result.exit_code).toBe(EXIT_CODES.OK);
    expect(result.epoch).toBe(1);
    expect(records.map((r) => r.transition.node_id)).toEqual(["a", "b", "term"]);
    expect(records.map((r) => r.seq)).toEqual([0, 1, 2]);
    expect(records.every((r) => r.epoch === 1)).toBe(true);
    expect(snapshot).not.toBeNull();
    expect(snapshot?.saved_at_seq).toBe(2);
    expect(isGraphSucceeded(sealed, snapshot?.projection as never)).toBe(true);
    const eventTypes = events.map((event) => event.type);
    expect(eventTypes).toContain("run_started");
    expect(eventTypes).toContain("activation_started");
    expect(eventTypes).toContain("node_result");
    expect(events.at(-1)?.type).toBe("run_ended");
    expect(existsSync(join(runsRoot, sealed.run_id, "owner.lock"))).toBe(false);
  });

  it("resumes a partial run without re-running completed nodes", async () => {
    // Arrange: run 1 hangs on `b` and is aborted after `a` commits.
    const runsRoot = makeRunsRoot();
    const sealed = sealGraphDescriptor(linearDescriptor());
    const controller = new AbortController();
    const runOneExecutor = new ScriptedExecutor((nodeId) =>
      nodeId === "b" ? new Promise<NodeExecutionOutput>(() => {}) : okOutput(nodeId),
    );
    const { events } = makeReporter();
    const reporter: ProgressReporter = {
      onEvent: (event) => {
        events.push(event);
        if (event.type === "node_result" && event.node_id === "a") {
          controller.abort();
        }
      },
    };

    // Act
    await expect(
      runGraph(sealed, {
        runsRoot,
        executors: [runOneExecutor],
        prompter: { prompt: async () => "approved" },
        reporter,
        signal: controller.signal,
      }),
    ).rejects.toThrow(/aborted/);

    // Simulate stale reap of the abandoned lock (crash semantics).
    rmSync(join(runsRoot, sealed.run_id, "owner.lock"), { force: true });

    // Run 2: everything succeeds; `a` must NOT execute again.
    const runTwoExecutor = allSucceed();
    const result = await runGraph(sealed, {
      runsRoot,
      executors: [runTwoExecutor],
      prompter: { prompt: async () => "approved" },
      reporter: { onEvent: () => undefined },
    });

    // Assert
    expect(result.terminal).toBe("succeeded");
    expect(runOneExecutor.calls).toEqual(["a"]);
    expect(runTwoExecutor.calls).toEqual(["b", "term"]);
    const journal = new FileJournal(runsRoot, sealed.run_id);
    const records = await journal.readAll();
    expect(records.map((r) => r.transition.node_id)).toEqual(["a", "b", "term"]);
    expect(records[0].epoch).toBe(1);
    expect(records.at(-1)?.epoch).toBeGreaterThanOrEqual(1);
  });

  it("rebuilds from the journal instead of accepting a stale projection snapshot", async () => {
    const runsRoot = makeRunsRoot();
    const sealed = sealGraphDescriptor(linearDescriptor());
    await runGraph(sealed, {
      runsRoot,
      executors: [allSucceed()],
      prompter: { prompt: async () => "approved" },
    });

    const projectionPath = join(runsRoot, sealed.run_id, "projection.json");
    const snapshot = JSON.parse(readFileSync(projectionPath, "utf8")) as {
      projection: Record<string, unknown>;
    };
    // Keep a structurally valid but stale cache. Resume must not consume it;
    // the committed journal is the sole source of scheduler truth.
    writeFileSync(
      projectionPath,
      canonicalJson({
        ...snapshot,
        saved_at_seq: -1,
        projection: { ...snapshot.projection, activations: {} },
      }),
      "utf8",
    );

    const resumeExecutor = allSucceed();
    const result = await runGraph(sealed, {
      runsRoot,
      executors: [resumeExecutor],
      prompter: { prompt: async () => "approved" },
    });

    expect(result.terminal).toBe("succeeded");
    expect(result.exit_code).toBe(EXIT_CODES.OK);
    expect(resumeExecutor.calls).toEqual([]);
  });

  it("rejects descriptor drift on resume with exit code 21", async () => {
    // Arrange
    const runsRoot = makeRunsRoot();
    const sealed = sealGraphDescriptor(linearDescriptor());
    const drifted = sealGraphDescriptor({
      ...linearDescriptor(),
      goal: "tampered goal",
    });
    mkdirSync(join(runsRoot, sealed.run_id), { recursive: true });
    writeFileSync(
      join(runsRoot, sealed.run_id, "descriptor.json"),
      canonicalJson(drifted),
      "utf8",
    );

    // Act
    const result: RunResult = await runGraph(sealed, {
      runsRoot,
      executors: [allSucceed()],
      prompter: { prompt: async () => "approved" },
    });

    // Assert
    expect(result.terminal).toBe("failed");
    expect(result.exit_code).toBe(EXIT_CODES.DESCRIPTOR_MISMATCH);
  });

  it("surfaces a corrupt journal tail as exit code 20", async () => {
    // Arrange: complete a run, then damage the journal tail.
    const runsRoot = makeRunsRoot();
    const sealed = sealGraphDescriptor(linearDescriptor());
    await runGraph(sealed, {
      runsRoot,
      executors: [allSucceed()],
      prompter: { prompt: async () => "approved" },
    });
    appendFileSync(
      join(runsRoot, sealed.run_id, "journal.jsonl"),
      '{"seq":3,"epoch":1,"descriptor_hash":"',
      "utf8",
    );

    // Act
    const result: RunResult = await runGraph(sealed, {
      runsRoot,
      executors: [allSucceed()],
      prompter: { prompt: async () => "approved" },
    });

    // Assert
    expect(result.terminal).toBe("failed");
    expect(result.exit_code).toBe(EXIT_CODES.CORRUPT_JOURNAL);
  });

  it("respects concurrency_limit with parallel dispatch", async () => {
    // Arrange: three entries fan into term; limit 2.
    const runsRoot = makeRunsRoot();
    const descriptorInput: GraphDescriptorInput = {
      descriptor_version: 1,
      run_id: "run-runner-concurrency",
      revision_id: "rev-runner-concurrency",
      goal: "runner concurrency cap",
      nodes: [
        executableNode("Zentry", "command"),
        executableNode("aentry", "command"),
        executableNode("zentry", "command"),
        executableNode("term", "command"),
      ],
      edges: [
        { id: "e-Z-term", kind: "fixed", from: "Zentry", to: "term" },
        { id: "e-a-term", kind: "fixed", from: "aentry", to: "term" },
        { id: "e-z-term", kind: "fixed", from: "zentry", to: "term" },
      ],
      entry_node_ids: ["Zentry", "aentry", "zentry"],
      concurrency_limit: 2,
      terminal_verification_node_id: "term",
    };
    const sealed = sealGraphDescriptor(descriptorInput);
    let activeCount = 0;
    let maxObserved = 0;
    const executor = new ScriptedExecutor((nodeId) => {
      activeCount += 1;
      maxObserved = Math.max(maxObserved, activeCount);
      const release = new Promise<NodeExecutionOutput>((resolve) => {
        setTimeout(() => {
          activeCount -= 1;
          resolve(okOutput(nodeId));
        }, 20);
      });
      return release;
    });

    // Act
    const result = await runGraph(sealed, {
      runsRoot,
      executors: [executor],
      prompter: { prompt: async () => "approved" },
    });

    // Assert
    expect(result.terminal).toBe("succeeded");
    expect(executor.calls.length).toBe(6); // 3 entries + 3 term activations
    expect(maxObserved).toBe(2);
  });

  it("drains other branches when one branch exhausts its retry budget (AC-9/AC-10)", async () => {
    // Arrange
    const runsRoot = makeRunsRoot();
    const descriptorInput = {
      ...forkJoinDescriptor(),
      run_id: "run-runner-budget",
      revision_id: "rev-runner-budget",
    };
    const sealed = sealGraphDescriptor({
      ...descriptorInput,
      nodes: descriptorInput.nodes.map((node) =>
        node.id === "b1" ? { ...node, max_attempts: 2 } : node,
      ),
    });
    const executor = new ScriptedExecutor((nodeId) =>
      nodeId === "b1" ? failedOutput(nodeId) : okOutput(nodeId),
    );
    const { reporter, events } = makeReporter();

    // Act
    const result = await runGraph(sealed, {
      runsRoot,
      executors: [executor],
      prompter: { prompt: async () => "approved" },
      reporter,
    });

    // Assert
    expect(result.terminal).toBe("failed");
    expect(result.exit_code).toBe(EXIT_CODES.FAILED_TERMINAL);
    expect(executor.calls.filter((id) => id === "b1")).toHaveLength(2);
    expect(executor.calls).toContain("b2"); // sibling branch still drained (AC-10)

    const journal = new FileJournal(runsRoot, sealed.run_id);
    const records = await journal.readAll();
    const failedB1 = records.filter(
      (r) => r.transition.node_id === "b1" && r.transition.outcome === "failed",
    );
    expect(failedB1).toHaveLength(2);
    expect(records.some((r) => r.transition.outcome === "join_resolved")).toBe(false);
    const runEnded = events.at(-1);
    expect(runEnded?.type).toBe("run_ended");
    if (runEnded?.type === "run_ended") {
      expect(runEnded.summary).toBe("no schedulable activations");
    }
  });

  it("runs fork/join to success with a join_resolved record (AC-13)", async () => {
    // Arrange
    const runsRoot = makeRunsRoot();
    const descriptorInput = {
      ...forkJoinDescriptor(),
      run_id: "run-runner-forkjoin",
      revision_id: "rev-runner-forkjoin",
    };
    const sealed = sealGraphDescriptor(descriptorInput);
    const executor = allSucceed();

    // Act
    const result = await runGraph(sealed, {
      runsRoot,
      executors: [executor],
      prompter: { prompt: async () => "approved" },
    });

    // Assert
    expect(result.terminal).toBe("succeeded");
    const journal = new FileJournal(runsRoot, sealed.run_id);
    const records = await journal.readAll();
    const joinRecord = records.find(
      (r) => r.transition.outcome === "join_resolved",
    );
    expect(joinRecord).toBeDefined();
    if (joinRecord?.transition.outcome === "join_resolved") {
      expect(joinRecord.transition.cohort_id).toBe("fan-coh0");
      expect(joinRecord.transition.created_activation_ids).toEqual(["term-act0"]);
    }
    const store = new FileProjectionStore(runsRoot, sealed.run_id);
    const snapshot = await store.load();
    expect(snapshot).not.toBeNull();
    if (snapshot) {
      const cohorts = Object.values(snapshot.projection.cohorts);
      expect(cohorts).toHaveLength(1);
      expect(cohorts[0].consumed).toBe(true);
      const tokens = Object.values(snapshot.projection.branch_tokens);
      expect(tokens.every((token) => token.status === "consumed")).toBe(true);
    }
  });

  it("prompts for human approval and proceeds when approved", async () => {
    // Arrange
    const runsRoot = makeRunsRoot();
    const descriptorInput = {
      ...approvalDescriptor(),
      run_id: "run-runner-approval",
      revision_id: "rev-runner-approval",
    };
    const sealed = sealGraphDescriptor(descriptorInput);
    let promptsSeen = 0;
    const prompter = {
      prompt: async () => {
        promptsSeen += 1;
        return "approved" as const;
      },
    };

    // Act
    const result = await runGraph(sealed, {
      runsRoot,
      executors: [allSucceed()],
      prompter,
    });

    // Assert
    expect(promptsSeen).toBe(1);
    expect(result.terminal).toBe("succeeded");
    const journal = new FileJournal(runsRoot, sealed.run_id);
    const records = await journal.readAll();
    expect(records.some((r) => r.transition.outcome === "approved")).toBe(true);
  });

  it("stops the graph when approval is denied", async () => {
    // Arrange
    const runsRoot = makeRunsRoot();
    const descriptorInput = {
      ...approvalDescriptor(),
      run_id: "run-runner-deny",
      revision_id: "rev-runner-deny",
    };
    const sealed = sealGraphDescriptor(descriptorInput);
    let promptsSeen = 0;
    const prompter = {
      prompt: async () => {
        promptsSeen += 1;
        return "denied" as const;
      },
    };

    // Act
    const result = await runGraph(sealed, {
      runsRoot,
      executors: [allSucceed()],
      prompter,
    });

    // Assert
    expect(promptsSeen).toBe(1);
    expect(result.terminal).toBe("failed");
    expect(result.exit_code).toBe(EXIT_CODES.FAILED_TERMINAL);
    const journal = new FileJournal(runsRoot, sealed.run_id);
    const records = await journal.readAll();
    expect(records.some((r) => r.transition.outcome === "denied")).toBe(true);
  });

  it("replays bit-for-bit: resume fold equals direct run snapshot (AC-3)", async () => {
    // Arrange
    const runsRootA = makeRunsRoot();
    const runsRootB = makeRunsRoot();
    const descriptorInput = {
      ...forkJoinDescriptor(),
      run_id: "run-runner-replay",
      revision_id: "rev-runner-replay",
    };
    const sealed = sealGraphDescriptor(descriptorInput);
    const options = {
      executors: [allSucceed()],
      prompter: { prompt: async () => "approved" as const },
    };

    // Act — control: direct full run.
    await runGraph(sealed, { ...options, runsRoot: runsRootA });

    // Act — resume path: abort after the fan node commits, then resume.
    const controller = new AbortController();
    const partialExecutor = new ScriptedExecutor((nodeId) =>
      nodeId === "b1" || nodeId === "b2"
        ? new Promise<NodeExecutionOutput>(() => {})
        : okOutput(nodeId),
    );
    await expect(
      runGraph(sealed, {
        runsRoot: runsRootB,
        executors: [partialExecutor],
        prompter: { prompt: async () => "approved" as const },
        signal: controller.signal,
        reporter: {
          onEvent: (event) => {
            if (event.type === "node_result" && event.node_id === "fan") {
              controller.abort();
            }
          },
        },
      }),
    ).rejects.toThrow(/aborted/);
    rmSync(join(runsRootB, sealed.run_id, "owner.lock"), { force: true });

    const resumed = await runGraph(sealed, { ...options, runsRoot: runsRootB });
    expect(resumed.terminal).toBe("succeeded");

    // Assert — canonicalJson equality of the two final projections.
    const storeA = new FileProjectionStore(runsRootA, sealed.run_id);
    const storeB = new FileProjectionStore(runsRootB, sealed.run_id);
    const snapshotA = await storeA.load();
    const snapshotB = await storeB.load();
    expect(snapshotA).not.toBeNull();
    expect(snapshotB).not.toBeNull();
    expect(canonicalJson(snapshotB?.projection)).toBe(
      canonicalJson(snapshotA?.projection),
    );
  });

  it("replays a crash between branch completions bit-for-bit (AC-3/AC-11b)", async () => {
    // Arrange: direct control run.
    const runsRootA = makeRunsRoot();
    const runsRootB = makeRunsRoot();
    const descriptorInput = {
      ...forkJoinDescriptor(),
      run_id: "run-runner-branch-crash",
      revision_id: "rev-runner-branch-crash",
    };
    const sealed = sealGraphDescriptor(descriptorInput);
    await runGraph(sealed, {
      runsRoot: runsRootA,
      executors: [allSucceed()],
      prompter: { prompt: async () => "approved" as const },
    });
    const storeA = new FileProjectionStore(runsRootA, sealed.run_id);
    const snapshotA = await storeA.load();
    expect(snapshotA).not.toBeNull();

    // Partial run: b1 commits then aborts while b2 hangs (crash between the
    // two fan-out branch completions).
    const controller = new AbortController();
    const partialExecutor = new ScriptedExecutor((nodeId) =>
      nodeId === "b2" ? new Promise<NodeExecutionOutput>(() => {}) : okOutput(nodeId),
    );
    await expect(
      runGraph(sealed, {
        runsRoot: runsRootB,
        executors: [partialExecutor],
        prompter: { prompt: async () => "approved" as const },
        signal: controller.signal,
        reporter: {
          onEvent: (event) => {
            if (event.type === "node_result" && event.node_id === "b1") {
              controller.abort();
            }
          },
        },
      }),
    ).rejects.toThrow(/aborted/);

    // Simulate stale reap of the abandoned lock, then resume.
    rmSync(join(runsRootB, sealed.run_id, "owner.lock"), { force: true });
    const resumed = await runGraph(sealed, {
      runsRoot: runsRootB,
      executors: [allSucceed()],
      prompter: { prompt: async () => "approved" as const },
    });
    expect(resumed.terminal).toBe("succeeded");

    // Un-normalized projection equality including every committed
    // transition's request_fingerprint.
    const storeB = new FileProjectionStore(runsRootB, sealed.run_id);
    const snapshotB = await storeB.load();
    expect(snapshotB).not.toBeNull();
    expect(canonicalJson(snapshotB?.projection)).toBe(
      canonicalJson(snapshotA?.projection),
    );
    const transitionsA = snapshotA?.projection.committed_transitions ?? {};
    const transitionsB = snapshotB?.projection.committed_transitions ?? {};
    for (const [transitionId, transition] of Object.entries(transitionsA)) {
      expect(transitionsB[transitionId]).toBeDefined();
      if (transitionsB[transitionId] !== undefined) {
        expect(transitionsB[transitionId].request_fingerprint).toBe(
          transition.request_fingerprint,
        );
      }
    }
    const journalB = new FileJournal(runsRootB, sealed.run_id);
    const recordsB = await journalB.readAll();
    expect(
      recordsB.some((r) => r.transition.outcome === "join_resolved"),
    ).toBe(true);
    expect(recordsB.some((r) => r.transition.node_id === "term")).toBe(true);
  });
});
