/**
 * P1-4 journal epoch provenance regression tests.
 *
 * A committed record's epoch must be semantically bound at resume-fold:
 * - forged future epochs (currentEpoch+N) fail closed CORRUPT_JOURNAL(20)
 *   without executing any node (maintainer probe reproduction);
 * - legitimately increasing epochs across takeovers (1 then 2) fold fine.
 */

import { afterEach, describe, expect, it } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync, realpathSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "fs";
import { spawnSync } from "child_process";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

import { canonicalJson, sealGraphDescriptor } from "../../descriptor.js";
import { computeJournalFingerprint } from "../../runtime/journal.js";
import { runGraph } from "../../runtime/runner.js";
import { EXIT_CODES } from "../../runtime/types.js";
import type {
  JournalRecord,
  NodeExecutionContext,
  NodeExecutionOutput,
  NodeExecutor,
} from "../../runtime/types.js";
import type { GraphDescriptorInput } from "../../types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = join(__dirname, "fixtures");

function loadFixture(name: string): GraphDescriptorInput {
  return JSON.parse(
    readFileSync(join(FIXTURES_DIR, name), "utf8"),
  ) as GraphDescriptorInput;
}

const tempDirs: string[] = [];

function makeRunsRoot(): string {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), "omc-journal-epoch-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop() as string, { recursive: true, force: true });
  }
});

class OkExecutor implements NodeExecutor {
  readonly kinds = ["agent", "command"] as const;
  readonly calls: string[] = [];

  async execute(context: NodeExecutionContext): Promise<NodeExecutionOutput> {
    this.calls.push(context.node.id);
    return {
      outcome: "succeeded",
      output_summary: `ok:${context.node.id}`,
      evidence_refs: [{ kind: "command", ref: `cmd:${context.node.id}` }],
    };
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

/** Completes a linear run and rewrites journal epochs per line index. */
async function completeRunWithEpochs(
  runsRoot: string,
  epochForLine: (index: number) => number,
): Promise<{ sealed: ReturnType<typeof sealGraphDescriptor>; lines: string[] }> {
  const sealed = sealGraphDescriptor(loadFixture("simple-linear.json"));
  const firstRun = await runGraph(sealed, runOptions(runsRoot, new OkExecutor()));
  if (firstRun.exit_code !== EXIT_CODES.OK) {
    throw new Error(`fixture run failed with exit ${firstRun.exit_code}`);
  }
  const journalPath = join(runsRoot, sealed.run_id, "journal.jsonl");
  const lines = readFileSync(journalPath, "utf8").split("\n").filter(Boolean);
  const rewritten = lines.map((line, index) => {
    const record = JSON.parse(line) as JournalRecord;
    const { journal_fingerprint: _journalFingerprint, ...withoutFingerprint } =
      record;
    const unsigned = { ...withoutFingerprint, epoch: epochForLine(index) };
    return canonicalJson({
      ...unsigned,
      journal_fingerprint: computeJournalFingerprint(unsigned),
    });
  });
  writeFileSync(journalPath, `${rewritten.join("\n")}\n`, "utf8");
  return { sealed, lines };
}

describe("journal epoch provenance (P1-4)", () => {
  it.each(["missing", "empty"])(
    "fails closed before executing work when an existing descriptor has a %s journal",
    async (journalState) => {
      const runsRoot = makeRunsRoot();
      const sealed = sealGraphDescriptor(loadFixture("simple-linear.json"));
      const runDir = join(runsRoot, sealed.run_id);
      mkdirSync(runDir, { recursive: true });
      writeFileSync(join(runDir, "descriptor.json"), canonicalJson(sealed));
      if (journalState === "empty") {
        writeFileSync(join(runDir, "journal.jsonl"), "");
      }

      const executor = new OkExecutor();
      const result = await runGraph(sealed, runOptions(runsRoot, executor));

      expect(result.terminal).toBe("failed");
      expect(result.exit_code).toBe(EXIT_CODES.CORRUPT_JOURNAL);
      expect(executor.calls).toEqual([]);
      expect(existsSync(join(runDir, "projection.json"))).toBe(false);
    },
  );

  it("fails closed CORRUPT_JOURNAL when a record carries a forged future epoch", async () => {
    // Arrange: complete a clean epoch-1 run, then bump one record's epoch to
    // currentEpoch + 998 (envelope-valid, semantically forged).
    const runsRoot = makeRunsRoot();
    const { sealed } = await completeRunWithEpochs(runsRoot, () => 1);
    const journalPath = join(runsRoot, sealed.run_id, "journal.jsonl");
    const lines = readFileSync(journalPath, "utf8").split("\n").filter(Boolean);
    expect(lines.length).toBeGreaterThanOrEqual(2);
    const forged = JSON.parse(lines[0] as string) as JournalRecord;
    const { journal_fingerprint: _journalFingerprint, ...withoutFingerprint } =
      forged;
    const unsigned = { ...withoutFingerprint, epoch: 1 + 998 };
    lines[0] = canonicalJson({
      ...unsigned,
      journal_fingerprint: computeJournalFingerprint(unsigned),
    });
    writeFileSync(journalPath, `${lines.join("\n")}\n`, "utf8");

    // Act: resume over the forged history.
    const resumeExecutor = new OkExecutor();
    const result = await runGraph(sealed, runOptions(runsRoot, resumeExecutor));

    // Assert: fold rejects the forged provenance before executing anything.
    expect(result.terminal).toBe("failed");
    expect(result.exit_code).toBe(EXIT_CODES.CORRUPT_JOURNAL);
    expect(resumeExecutor.calls).toEqual([]);
  });

  it("fails closed when all records are rebound to the acquired epoch without rebinding their envelopes", async () => {
    const runsRoot = makeRunsRoot();
    const { sealed } = await completeRunWithEpochs(runsRoot, () => 1);
    const journalPath = join(runsRoot, sealed.run_id, "journal.jsonl");
    const lines = readFileSync(journalPath, "utf8").split("\n").filter(Boolean);
    const rewritten = lines.map((line) => {
      const record = JSON.parse(line) as JournalRecord;
      // Epoch 2 is valid for the resuming owner, but the old envelope
      // fingerprint still authenticates epoch 1.
      return canonicalJson({ ...record, epoch: 2 });
    });
    writeFileSync(journalPath, `${rewritten.join("\n")}\n`, "utf8");

    const resumeExecutor = new OkExecutor();
    const result = await runGraph(sealed, runOptions(runsRoot, resumeExecutor));

    expect(result.terminal).toBe("failed");
    expect(result.exit_code).toBe(EXIT_CODES.CORRUPT_JOURNAL);
    expect(resumeExecutor.calls).toEqual([]);
  });

  it("folds legitimately increasing epochs across two takeovers (1 then 2)", async () => {
    // Arrange: rewrite completed history into two generations (epoch 1 then
    // 2), then force the resuming process to take over at epoch 2 via a
    // stale dead-pid lock (backdated past the grace period).
    const runsRoot = makeRunsRoot();
    const { sealed } = await completeRunWithEpochs(
      runsRoot,
      (index) => (index < 2 ? 1 : 2),
    );
    const exitedChild = spawnSync(process.execPath, ["-e", ""]);
    const deadPid = exitedChild.pid as number;
    const lockPath = join(runsRoot, sealed.run_id, "owner.lock");
    writeFileSync(
      lockPath,
      `${JSON.stringify({
        pid: deadPid,
        epoch: 1,
        timestamp: Date.now() - 120_000,
      })}\n`,
      "utf8",
    );
    const backdated = new Date(Date.now() - 120_000);
    utimesSync(lockPath, backdated, backdated);

    // Act: resume must take over at epoch 2 and fold the mixed history.
    const resumeExecutor = new OkExecutor();
    const result = await runGraph(sealed, runOptions(runsRoot, resumeExecutor));

    // Assert: legitimate epoch progression replays cleanly, no work rerun.
    expect(result.terminal).toBe("succeeded");
    expect(result.epoch).toBe(2);
    expect(result.exit_code).toBe(EXIT_CODES.OK);
    expect(resumeExecutor.calls).toEqual([]);
  });
});
