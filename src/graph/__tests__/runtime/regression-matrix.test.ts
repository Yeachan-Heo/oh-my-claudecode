/**
 * Regression matrix tests (AC-9/10/11/11b) — runner level with fake executors.
 *
 * AC-9  max_attempts: an always-failing executor terminal-fails the node
 *       after exactly its descriptor budget; no infinite retry.
 * AC-10 no-wedge: one branch failing terminally still drains sibling work and
 *       reaches a defined end state with an empty ready set.
 * AC-11 traversal round-trip: a bounded back-edge loop runs to terminal and
 *       an in-process journal replay-fold reproduces the live projection
 *       bit-for-bit under canonicalJson equality.
 * AC-11b tamper: flipping a journaled transition outcome makes the resume
 *       fold fail closed (CORRUPT_JOURNAL) without executing any node.
 */

import { afterEach, describe, expect, it } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync, realpathSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

import { canonicalJson, sealGraphDescriptor } from "../../descriptor.js";
import {
  applyNodeResult,
  beginActivationAttempt,
  initializeGraphProjection,
  listReadyExecutableActivations,
  listReadyJoinActivations,
} from "../../scheduler.js";
import { runGraph } from "../../runtime/runner.js";
import {
  computeJournalFingerprint,
  FileJournal,
} from "../../runtime/journal.js";
import { FileProjectionStore } from "../../runtime/store.js";
import { EXIT_CODES } from "../../runtime/types.js";
import type {
  JournalRecord,
  NodeExecutionContext,
  NodeExecutionOutput,
  NodeExecutor,
} from "../../runtime/types.js";
import type {
  GraphCommittedTransition,
  GraphDescriptorInput,
  GraphSchedulerProjection,
  SealedGraphDescriptor,
} from "../../types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = join(__dirname, "fixtures");

function loadFixture(name: string): GraphDescriptorInput {
  return JSON.parse(
    readFileSync(join(FIXTURES_DIR, name), "utf8"),
  ) as GraphDescriptorInput;
}

const tempDirs: string[] = [];

function makeRunsRoot(): string {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), "omc-regression-matrix-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop() as string, { recursive: true, force: true });
  }
});

function okOutput(
  nodeId: string,
  route?: string,
): NodeExecutionOutput {
  return {
    outcome: "succeeded",
    output_summary: `ok:${nodeId}`,
    evidence_refs: [{ kind: "command", ref: `cmd:${nodeId}` }],
    ...(route !== undefined && { route }),
  };
}

function failedOutput(nodeId: string): NodeExecutionOutput {
  return {
    outcome: "failed",
    output_summary: `boom:${nodeId}`,
    evidence_refs: [{ kind: "command", ref: `cmd:${nodeId}` }],
  };
}

/** Executor with context-aware scripted behavior and an invocation log. */
class ScriptedExecutor implements NodeExecutor {
  readonly kinds = ["agent", "command"] as const;
  readonly calls: string[] = [];

  constructor(
    private readonly behavior: (
      context: NodeExecutionContext,
    ) => Promise<NodeExecutionOutput> | NodeExecutionOutput,
  ) {}

  async execute(context: NodeExecutionContext): Promise<NodeExecutionOutput> {
    this.calls.push(context.node.id);
    return this.behavior(context);
  }
}

function runOptions(
  runsRoot: string,
  executor: NodeExecutor,
): Parameters<typeof runGraph>[1] {
  return {
    runsRoot,
    executors: [executor],
    prompter: { prompt: async () => "approved" },
  };
}

describe("regression matrix (AC-9/10/11/11b)", () => {
  it("terminal-fails a node after exactly its max_attempts budget (AC-9)", async () => {
    // Arrange: b1 gets a reduced descriptor budget; executor always fails it.
    const input = loadFixture("fanout-join-graph.json");
    const sealed = sealGraphDescriptor({
      ...input,
      nodes: input.nodes.map((node) =>
        node.id === "b1" ? { ...node, max_attempts: 2 } : node,
      ),
    });
    const runsRoot = makeRunsRoot();
    const executor = new ScriptedExecutor((context) =>
      context.node.id === "b1"
        ? failedOutput(context.node.id)
        : okOutput(context.node.id),
    );

    // Act
    const result = await runGraph(sealed, runOptions(runsRoot, executor));

    // Assert: defined end state, budget respected, every attempt journaled.
    expect(result.terminal).toBe("failed");
    expect(result.exit_code).toBe(EXIT_CODES.FAILED_TERMINAL);
    expect(executor.calls.filter((id) => id === "b1")).toHaveLength(2);

    const records = await new FileJournal(runsRoot, sealed.run_id).readAll();
    const b1Failures = records.filter(
      (record) =>
        record.transition.node_id === "b1" &&
        record.transition.outcome === "failed",
    );
    expect(b1Failures).toHaveLength(2);
    // The join never resolved and the terminal never ran: no infinite retry.
    expect(records.some((r) => r.transition.outcome === "join_resolved")).toBe(
      false,
    );
    expect(records.some((r) => r.transition.node_id === "term")).toBe(false);
  });

  it("drains sibling work to a defined end state when one branch fails terminally (AC-10)", async () => {
    // Arrange
    const input = loadFixture("fanout-join-graph.json");
    const sealed = sealGraphDescriptor({
      ...input,
      nodes: input.nodes.map((node) =>
        node.id === "b2" ? { ...node, max_attempts: 1 } : node,
      ),
    });
    const runsRoot = makeRunsRoot();
    const executor = new ScriptedExecutor((context) =>
      context.node.id === "b2"
        ? failedOutput(context.node.id)
        : okOutput(context.node.id),
    );

    // Act
    const result = await runGraph(sealed, runOptions(runsRoot, executor));

    // Assert: the run ends (no wedge), and the ready set is fully drained.
    expect(result.terminal).toBe("failed");
    expect(result.exit_code).toBe(EXIT_CODES.FAILED_TERMINAL);
    expect(executor.calls).toContain("fan");
    expect(executor.calls).toContain("b1"); // healthy sibling still drained

    const store = new FileProjectionStore(runsRoot, sealed.run_id);
    const snapshot = await store.load();
    expect(snapshot).not.toBeNull();
    const projection = snapshot?.projection as GraphSchedulerProjection;
    expect(listReadyExecutableActivations(sealed, projection)).toHaveLength(0);
    expect(listReadyJoinActivations(sealed, projection)).toHaveLength(0);
    for (const activation of Object.values(projection.activations)) {
      expect(["completed", "failed"]).toContain(activation.status);
    }
  });

  it("runs a bounded back-edge loop to terminal and replays the journal to the identical projection (AC-11)", async () => {
    // Arrange
    const sealed = sealGraphDescriptor(loadFixture("back-edge-graph.json"));
    const runsRoot = makeRunsRoot();
    let workRuns = 0;
    const executor = new ScriptedExecutor((context) => {
      if (context.node.id !== "work") return okOutput(context.node.id);
      workRuns += 1;
      // Two retry traversals hit the max_traversals bound exactly; then exit.
      return okOutput("work", workRuns <= 2 ? "retry" : "success");
    });

    // Act: full live run to a terminal state.
    const result = await runGraph(sealed, runOptions(runsRoot, executor));

    // Assert live shape: start -> retry -> retry -> success -> term.
    expect(result.terminal).toBe("succeeded");
    expect(result.exit_code).toBe(EXIT_CODES.OK);
    expect(workRuns).toBe(3);
    const journal = new FileJournal(runsRoot, sealed.run_id);
    const records = await journal.readAll();
    const workTransitions = records.filter(
      (record) => record.transition.node_id === "work",
    );
    expect(workTransitions.map((record) => record.transition)).toMatchObject([
      { route: "retry", selected_edge_ids: ["e-work-retry"] },
      { route: "retry", selected_edge_ids: ["e-work-retry"] },
      { route: "success", selected_edge_ids: ["e-work-term"] },
    ]);

    const store = new FileProjectionStore(runsRoot, sealed.run_id);
    const snapshot = await store.load();
    expect(snapshot).not.toBeNull();
    const liveProjection = snapshot?.projection as GraphSchedulerProjection;
    // The traversal counter sits at (not past) the bound of 2.
    expect(Object.values(liveProjection.traversal_counts)).toEqual([2]);

    // In-process replay fold through the same scheduler entrypoints.
    const folded = foldJournal(sealed, records);
    expect(canonicalJson(folded)).toBe(canonicalJson(liveProjection));

    // A resume over the completed journal re-folds everything and executes
    // nothing — persisted history replays cleanly (round trip closed).
    const idleExecutor = new ScriptedExecutor(() => {
      throw new Error("resume must not execute any node after success");
    });
    const resumedAgain = await runGraph(
      sealed,
      runOptions(runsRoot, idleExecutor),
    );
    expect(resumedAgain.terminal).toBe("succeeded");
    expect(resumedAgain.exit_code).toBe(EXIT_CODES.OK);
    expect(idleExecutor.calls).toEqual([]);
    const recordsAfterResume = await journal.readAll();
    expect(recordsAfterResume).toHaveLength(records.length);
  });

  it("fails closed with CORRUPT_JOURNAL when a journaled transition is tampered (AC-11b)", async () => {
    // Arrange: complete a linear run, then flip the first transition outcome.
    const sealed = sealGraphDescriptor(loadFixture("simple-linear.json"));
    const runsRoot = makeRunsRoot();
    const firstRunExecutor = new ScriptedExecutor((context) =>
      okOutput(context.node.id),
    );
    await runGraph(sealed, runOptions(runsRoot, firstRunExecutor));

    const journalPath = join(runsRoot, sealed.run_id, "journal.jsonl");
    const lines = readFileSync(journalPath, "utf8").split("\n").filter(Boolean);
    expect(lines.length).toBeGreaterThanOrEqual(2);
    const tampered = JSON.parse(lines[0] as string) as JournalRecord;
    expect(tampered.transition.outcome).toBe("succeeded");
    (tampered.transition as { outcome: string }).outcome = "failed";
    lines[0] = canonicalJson(tampered);
    writeFileSync(journalPath, `${lines.join("\n")}\n`, "utf8");

    // Act: resume must detect the tamper in the startup fold.
    const resumeExecutor = new ScriptedExecutor((context) =>
      okOutput(context.node.id),
    );
    const result = await runGraph(sealed, runOptions(runsRoot, resumeExecutor));

    // Assert: fail-closed corruption mapping; nothing executed.
    expect(result.terminal).toBe("failed");
    expect(result.exit_code).toBe(EXIT_CODES.CORRUPT_JOURNAL);
    expect(resumeExecutor.calls).toEqual([]);
  });

  it("fails closed when a journal record is rebound to a foreign descriptor hash", async () => {
    // Arrange: complete a run, then rebind record 0's descriptor_hash.
    const sealed = sealGraphDescriptor(loadFixture("simple-linear.json"));
    const runsRoot = makeRunsRoot();
    await runGraph(
      sealed,
      runOptions(
        runsRoot,
        new ScriptedExecutor((context) => okOutput(context.node.id)),
      ),
    );

    const journalPath = join(runsRoot, sealed.run_id, "journal.jsonl");
    const lines = readFileSync(journalPath, "utf8").split("\n").filter(Boolean);
    const tampered = JSON.parse(lines[0] as string) as JournalRecord;
    (tampered as { descriptor_hash: string }).descriptor_hash =
      "0".repeat(64);
    lines[0] = canonicalJson(tampered);
    writeFileSync(journalPath, `${lines.join("\n")}\n`, "utf8");

    // Act + Assert: descriptor binding drift maps to DESCRIPTOR_MISMATCH.
    const result = await runGraph(
      sealed,
      runOptions(
        runsRoot,
        new ScriptedExecutor((context) => okOutput(context.node.id)),
      ),
    );
    expect(result.terminal).toBe("failed");
    expect(result.exit_code).toBe(EXIT_CODES.DESCRIPTOR_MISMATCH);
  });

  it.each([
    {
      label: "transition descriptor hash",
      mutate: (transition: Record<string, unknown>) => {
        transition.descriptor_hash = "0".repeat(64);
      },
      exitCode: EXIT_CODES.DESCRIPTOR_MISMATCH,
    },
    {
      label: "fingerprint version",
      mutate: (transition: Record<string, unknown>) => {
        transition.fingerprint_version = 2;
      },
      exitCode: EXIT_CODES.CORRUPT_JOURNAL,
    },
    {
      label: "request fingerprint metadata",
      mutate: (transition: Record<string, unknown>) => {
        transition.request_fingerprint = "not-a-fingerprint";
      },
      exitCode: EXIT_CODES.CORRUPT_JOURNAL,
    },
  ])(
    "fails closed before executing work when replay metadata has a forged $label",
    async ({ mutate, exitCode }) => {
      const sealed = sealGraphDescriptor(loadFixture("simple-linear.json"));
      const runsRoot = makeRunsRoot();
      await runGraph(
        sealed,
        runOptions(
          runsRoot,
          new ScriptedExecutor((context) => okOutput(context.node.id)),
        ),
      );

      const journalPath = join(runsRoot, sealed.run_id, "journal.jsonl");
      const lines = readFileSync(journalPath, "utf8")
        .split("\n")
        .filter(Boolean);
      const tampered = JSON.parse(lines[0] as string) as JournalRecord;
      mutate(tampered.transition as unknown as Record<string, unknown>);
      const { journal_fingerprint: _journalFingerprint, ...unsigned } = tampered;
      lines[0] = canonicalJson({
        ...unsigned,
        journal_fingerprint: computeJournalFingerprint(unsigned),
      });
      writeFileSync(journalPath, `${lines.join("\n")}\n`, "utf8");

      const resumeExecutor = new ScriptedExecutor((context) =>
        okOutput(context.node.id),
      );
      const result = await runGraph(
        sealed,
        runOptions(runsRoot, resumeExecutor),
      );

      expect(result.terminal).toBe("failed");
      expect(result.exit_code).toBe(exitCode);
      expect(resumeExecutor.calls).toEqual([]);
    },
  );

  it("refuses to start while a live owner holds the lock and writes nothing (AC-7)", async () => {
    // Arrange: seed owner.lock with OUR live pid — a healthy holder yields
    // busy regardless of the stale grace, so no backdating is needed.
    const sealed = sealGraphDescriptor(loadFixture("simple-linear.json"));
    const runsRoot = makeRunsRoot();
    const runDir = join(runsRoot, sealed.run_id);
    mkdirSync(runDir, { recursive: true });
    writeFileSync(
      join(runDir, "owner.lock"),
      `${JSON.stringify({
        pid: process.pid,
        epoch: 1,
        timestamp: Date.now(),
      })}\n`,
      "utf8",
    );

    // Act: the fence surfaces busy as a RunResult (not a throw).
    const executor = new ScriptedExecutor((context) =>
      okOutput(context.node.id),
    );
    const result = await runGraph(sealed, runOptions(runsRoot, executor));

    // Assert: fenced out before any node ran; nothing was persisted.
    expect(result.terminal).toBe("failed");
    expect(result.exit_code).toBe(EXIT_CODES.FENCED_OUT);
    expect(result.epoch).toBe(0);
    expect(executor.calls).toEqual([]);
    expect(existsSync(join(runDir, "journal.jsonl"))).toBe(false);
    expect(readdirSync(runDir)).toEqual(["owner.lock"]);
  });
});

// ---------------------------------------------------------------------------
// In-process replay fold (AC-11 helper)
// ---------------------------------------------------------------------------

/** Mirrors the runner's deterministic entry-activation scheme. */
function entryActivationIds(
  descriptor: SealedGraphDescriptor,
): Record<string, string> {
  return Object.fromEntries(
    descriptor.entry_node_ids.map((id) => [id, `${id}-act0`]),
  );
}

/**
 * Folds journal records through the scheduler entrypoints used live,
 * regenerating identities from the committed fields (runner replay scheme).
 */
function foldJournal(
  descriptor: SealedGraphDescriptor,
  records: readonly JournalRecord[],
): GraphSchedulerProjection {
  let projection = initializeGraphProjection(
    descriptor,
    entryActivationIds(descriptor),
  );
  for (const record of records) {
    const transition: GraphCommittedTransition = record.transition;
    if (transition.outcome === "succeeded") {
      const withAttempt = beginActivationAttempt(descriptor, projection, {
        activation_id: transition.activation_id,
        attempt_id: transition.attempt_id,
      });
      const identities =
        transition.selected_edge_ids.length > 0
          ? {
              next_activation_ids: Object.fromEntries(
                transition.selected_edge_ids.map((edgeId, index) => [
                  edgeId,
                  transition.created_activation_ids[index] as string,
                ]),
              ),
            }
          : undefined;
      projection = applyNodeResult(descriptor, withAttempt, {
        activation_id: transition.activation_id,
        transition_id: transition.transition_id,
        result: {
          outcome: "succeeded",
          attempt_id: transition.attempt_id,
          ...(transition.route !== undefined && { route: transition.route }),
          ...(transition.output_summary !== undefined && {
            output_summary: transition.output_summary,
          }),
          evidence_refs: transition.evidence_refs,
        },
        identities,
      }).projection;
      continue;
    }
    throw new Error(
      `fold helper only covers succeeded transitions; got ${transition.outcome} at seq ${record.seq}`,
    );
  }
  return projection;
}
