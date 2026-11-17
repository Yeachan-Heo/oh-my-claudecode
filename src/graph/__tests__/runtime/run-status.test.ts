/**
 * Tests for `omc graph status <run_id>` (read-only derived state of one graph run).
 *
 * The runs are real: a two-step chain of command nodes is run through runGraph, and
 * the interrupted run is stopped by aborting the runner signal right after step 1
 * commits, so step 2 is left ready. The CLI cases go through the real `graph status`
 * command and read the JSON it prints.
 */

import { afterEach, describe, expect, it } from "vitest";
import { CommanderError } from "commander";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  cpSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  mkdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { sealGraphDescriptor } from "../../descriptor.js";
import { CommandNodeExecutor } from "../../runtime/executors/command.js";
import { runGraph } from "../../runtime/runner.js";
import type { NodeExecutor } from "../../runtime/types.js";
import { graphCommand } from "../../../cli/graph.js";
import { readRunStatus } from "../../runtime/run-status.js";

const tempDirs: string[] = [];

// Portable stand-ins for shell builtins (`true`, `exit 1`), which cmd.exe does not provide.
const NODE_OK = 'node -e "process.exit(0)"';
const NODE_FAIL = 'node -e "process.exit(1)"';
const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const CLI_ENTRY = fileURLToPath(new URL("../../../cli/index.ts", import.meta.url));

function makeFifo(path: string): void {
  const made = spawnSync("mkfifo", [path]);
  if (made.status !== 0) throw new Error(`mkfifo failed: ${made.stderr}`);
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeRunsRoot(): string {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "graph-status-test-")));
  tempDirs.push(base);
  const root = join(base, "runs");
  mkdirSync(root, { recursive: true });
  return root;
}

function commandNode(id: string, command: string) {
  return {
    id,
    kind: "command" as const,
    title: `Step ${id}`,
    timeout_ms: 60_000,
    max_attempts: 1,
    effect_policy: { policy: "side_effect_free" as const },
    command,
  };
}

function chainDescriptor(runId: string, step1Command: string, step2Command: string = NODE_OK) {
  return {
    descriptor_version: 1,
    run_id: runId,
    revision_id: `rev-${runId}`,
    goal: "status chain",
    nodes: [commandNode("step-1", step1Command), commandNode("step-2", step2Command)],
    edges: [{ id: "e-1-2", kind: "fixed" as const, from: "step-1", to: "step-2" }],
    entry_node_ids: ["step-1"],
    concurrency_limit: 1,
    terminal_verification_node_id: "step-2",
  };
}

/** Runs the two-step chain. With `interruptAfterStepOne`, the runner signal is aborted once step 1 has run. */
async function runChain(
  runsRoot: string,
  runId: string,
  step1Command: string,
  options: { interruptAfterStepOne?: boolean; step2Command?: string } = {},
): Promise<void> {
  const sealed = sealGraphDescriptor(chainDescriptor(runId, step1Command, options.step2Command));
  const controller = new AbortController();
  const commands = new CommandNodeExecutor();
  const executor: NodeExecutor = {
    kinds: commands.kinds,
    execute: async (context) => {
      const output = await commands.execute(context);
      if (options.interruptAfterStepOne === true && context.node.id === "step-1") controller.abort();
      return output;
    },
  };
  await runGraph(sealed, {
    runsRoot,
    executors: [executor],
    prompter: { prompt: async () => "approved" },
    signal: controller.signal,
  });
}

/** Entry command, then a human-approval gate, then the terminal command; `decision` answers the gate. */
async function runApprovalChain(runsRoot: string, runId: string, decision: "approved" | "denied"): Promise<void> {
  const sealed = sealGraphDescriptor({
    descriptor_version: 1,
    run_id: runId,
    revision_id: `rev-${runId}`,
    goal: "status approval chain",
    nodes: [
      commandNode("step-1", NODE_OK),
      { id: "gate", kind: "human-approval" as const, title: "Approve", prompt: "Approve?" },
      commandNode("step-2", NODE_OK),
    ],
    edges: [
      { id: "e-1-gate", kind: "fixed" as const, from: "step-1", to: "gate" },
      { id: "e-gate-2", kind: "fixed" as const, from: "gate", to: "step-2" },
    ],
    entry_node_ids: ["step-1"],
    concurrency_limit: 1,
    terminal_verification_node_id: "step-2",
  });
  await runGraph(sealed, {
    runsRoot,
    executors: [new CommandNodeExecutor()],
    prompter: { prompt: async () => decision },
  });
}

/** Rewrites the envelope of projection.json of a run through `edit`, keeping every other field. */
function editEnvelope(runsRoot: string, runId: string, edit: (envelope: Record<string, any>) => void): void {
  const file = join(runsRoot, runId, "projection.json");
  const envelope = JSON.parse(readFileSync(file, "utf8")) as Record<string, any>;
  edit(envelope);
  writeFileSync(file, JSON.stringify(envelope));
}

/** Rewrites the projection inside projection.json of a run through `edit`, keeping every other field. */
function editProjection(runsRoot: string, runId: string, edit: (projection: Record<string, any>) => void): void {
  editEnvelope(runsRoot, runId, (envelope) => edit(envelope.projection));
}

interface StatusNode {
  id: string;
  state: string;
  last_error: string | null;
}

/** Runs `omc graph status` in-process and captures stdout, stderr and the exit code. */
async function statusCli(args: string[]): Promise<{ code: number; json: Record<string, any> | null; err: string }> {
  let out = "";
  let err = "";
  const restoreOut = captureStream(process.stdout, (text) => (out += text));
  const restoreErr = captureStream(process.stderr, (text) => (err += text));
  const previousExitCode = process.exitCode;
  process.exitCode = undefined;
  try {
    await graphCommand().parseAsync(["status", ...args], { from: "user" });
    return { code: Number(process.exitCode ?? 0), json: out.trim() === "" ? null : JSON.parse(out), err };
  } catch (error) {
    if (error instanceof CommanderError) return { code: error.exitCode, json: null, err: err || error.message };
    throw error;
  } finally {
    restoreOut();
    restoreErr();
    process.exitCode = previousExitCode;
  }
}

function captureStream(stream: NodeJS.WriteStream, sink: (text: string) => void): () => void {
  const original = stream.write;
  stream.write = ((chunk: string | Uint8Array) => {
    sink(String(chunk));
    return true;
  }) as typeof stream.write;
  return () => {
    stream.write = original;
  };
}

function nodeOf(report: Record<string, any>, id: string): StatusNode {
  const node = (report.nodes as StatusNode[]).find((entry) => entry.id === id);
  if (node === undefined) throw new Error(`no node ${id} in status`);
  return node;
}

// runGraph refuses platforms without the contained directory-FD primitive (win32, see runner.ts).
describe.runIf(process.platform !== "win32")("omc graph status", () => {
  it("reports succeeded, failed, in_progress and a missing run", async () => {
    const runs = makeRunsRoot();
    await runChain(runs, "st-ok", NODE_OK);
    await runChain(runs, "st-fail", NODE_FAIL);
    await expect(runChain(runs, "st-run", NODE_OK, { interruptAfterStepOne: true })).rejects.toThrow(
      "graph run aborted",
    );

    const ok = await statusCli(["st-ok", "--runs-root", runs]);
    expect(ok.code).toBe(0);
    expect(ok.json?.state).toBe("succeeded");
    const failed = await statusCli(["st-fail", "--runs-root", runs]);
    expect(failed.code).toBe(1);
    expect(failed.json?.state).toBe("failed");
    const running = await statusCli(["st-run", "--runs-root", runs]);
    expect(running.code).toBe(3);
    expect(running.json?.state).toBe("in_progress");
    expect(nodeOf(running.json as Record<string, any>, "step-2").state).toBe("ready");
    const missing = await statusCli(["st-missing", "--runs-root", runs]);
    expect(missing.code).toBe(2);
    expect(missing.json?.state).toBe("missing");
  });

  it("reports unreadable files with exit 4 instead of failing", async () => {
    const runs = makeRunsRoot();
    await runChain(runs, "st-corrupt", NODE_OK);
    const dir = join(runs, "st-corrupt");
    const projection = readFileSync(join(dir, "projection.json"), "utf8");
    const journal = readFileSync(join(dir, "journal.jsonl"), "utf8");
    const damage: Record<string, () => void> = {
      "truncated projection": () => writeFileSync(join(dir, "projection.json"), projection.slice(0, Math.floor(projection.length / 2))),
      "empty projection": () => writeFileSync(join(dir, "projection.json"), ""),
      "projection without the projection key": () => writeFileSync(join(dir, "projection.json"), JSON.stringify({ other: 1 })),
      "truncated last journal line": () => writeFileSync(join(dir, "journal.jsonl"), journal.slice(0, journal.length - 20)),
      "journal missing although transitions are committed": () => rmSync(join(dir, "journal.jsonl")),
      "journal with a gap in its seq numbers": () => writeFileSync(join(dir, "journal.jsonl"), journal.replace('"seq":1', '"seq":7')),
    };
    for (const [label, breakIt] of Object.entries(damage)) {
      writeFileSync(join(dir, "projection.json"), projection);
      writeFileSync(join(dir, "journal.jsonl"), journal);
      breakIt();
      const result = await statusCli(["st-corrupt", "--runs-root", runs]);
      expect(result.code, `${label}: exit code (${JSON.stringify(result.json)})`).toBe(4);
      expect(result.json?.state, label).toBe("unreadable");
      expect(result.json?.error, `${label}: error text`).toBeTruthy();
    }
  });

  it("an emptied journal still shows a failure that is committed in the projection", async () => {
    const runs = makeRunsRoot();
    await runChain(runs, "st-empty", NODE_FAIL);
    writeFileSync(join(runs, "st-empty", "journal.jsonl"), "");

    const result = await statusCli(["st-empty", "--runs-root", runs]);
    expect(result.code, JSON.stringify(result.json)).toBe(1);
    expect(result.json?.state).toBe("failed");
  });

  it("a denied approval that leaves nothing to run ends the run as failed, not in_progress", async () => {
    const runs = makeRunsRoot();
    await runApprovalChain(runs, "st-denied", "denied");
    await runApprovalChain(runs, "st-approved", "approved");

    const denied = await statusCli(["st-denied", "--runs-root", runs]);
    expect(denied.code, JSON.stringify(denied.json)).toBe(1);
    expect(denied.json?.state).toBe("failed");
    expect(nodeOf(denied.json as Record<string, any>, "gate").state).toBe("failed");
    const approved = await statusCli(["st-approved", "--runs-root", runs]);
    expect(approved.code, JSON.stringify(approved.json)).toBe(0);
    expect(approved.json?.state).toBe("succeeded");
  });

  it("an older running activation of a node keeps the run in_progress although the node's newest activation failed", async () => {
    const runs = makeRunsRoot();
    await runChain(runs, "st-overlap", NODE_FAIL);
    editProjection(runs, "st-overlap", (projection) => {
      // Two concurrent activations of step-1: the older one is still running, the newer one failed.
      projection.activations = {
        "step-1-older": { activation_id: "step-1-older", node_id: "step-1", status: "running", attempt_no: 1 },
        ...projection.activations,
      };
    });

    const result = await statusCli(["st-overlap", "--runs-root", runs]);
    expect(result.code, JSON.stringify(result.json)).toBe(3);
    expect(result.json?.state).toBe("in_progress");
  });

  it("a projection that lags the journal is refused as unreadable instead of reported from the older snapshot", async () => {
    const runs = makeRunsRoot();
    // The crash window of the runner: the journal holds both committed transitions, the snapshot of the same run
    // only the first (saved_at_seq 0).
    await runChain(runs, "st-lag", NODE_OK);
    editEnvelope(runs, "st-lag", (envelope) => {
      envelope.saved_at_seq = 0;
    });

    const result = await statusCli(["st-lag", "--runs-root", runs]);
    expect(result.code, JSON.stringify(result.json)).toBe(4);
    expect(result.json?.state).toBe("unreadable");
    expect(String(result.json?.error)).toMatch(/stale/);
  });

  it("an unconsumed cohort keeps a run from being reported as succeeded, as in the scheduler success rule", async () => {
    const runs = makeRunsRoot();
    await runChain(runs, "st-cohort", NODE_OK);
    editProjection(runs, "st-cohort", (projection) => {
      projection.cohorts = { "cohort-1": { consumed: false } };
    });

    const result = await statusCli(["st-cohort", "--runs-root", runs]);
    expect(result.json?.state).not.toBe("succeeded");
    expect(result.code).not.toBe(0);
  });

  it("uses the same run id limit as omc graph gc: 128 characters pass, 129 are a usage error", async () => {
    const runs = makeRunsRoot();

    const accepted = await statusCli(["a".repeat(128), "--runs-root", runs]);
    expect(accepted.json?.state, JSON.stringify(accepted)).toBe("missing");

    const refused = await statusCli(["a".repeat(129), "--runs-root", runs]);
    expect(refused.code).toBe(2);
    expect(refused.json).toBeNull();
    expect(refused.err).toContain("invalid run_id");
  });

  it("without --runs-root it reads the default .omc/graph-runs, the same literal omc graph run uses", async () => {
    const result = await statusCli(["st-no-such-run"]);
    expect(result.code).toBe(2);
    expect(result.json?.state).toBe("missing");
    expect(result.json?.runs_root).toBe(".omc/graph-runs");
  });

  it("refuses a run directory that is a symbolic link with exit 4 and reads nothing through it", async () => {
    const runs = makeRunsRoot();
    await runChain(runs, "st-target", NODE_OK);
    symlinkSync(join(runs, "st-target"), join(runs, "st-link"));

    const result = await statusCli(["st-link", "--runs-root", runs]);
    expect(result.code).toBe(4);
    expect(result.json?.state).toBe("unreadable");
    expect(result.json?.error).toMatch(/symbolic link/);
  });

  for (const name of ["projection.json", "journal.jsonl"]) {
    it(`refuses a ${name} that is a symbolic link to a file outside the run, with exit 4`, async () => {
      const runs = makeRunsRoot();
      const runId = `st-link-${name.split(".")[0]}`;
      await runChain(runs, runId, NODE_OK);
      const dir = join(runs, runId);
      // The outside file holds the projection text, so a read that followed the link would not fail on the path alone.
      const outside = join(dirname(runs), `outside-${name}`);
      writeFileSync(outside, readFileSync(join(dir, "projection.json"), "utf8"));
      rmSync(join(dir, name));
      symlinkSync(outside, join(dir, name));

      const result = await statusCli([runId, "--runs-root", runs]);
      expect(result.code, JSON.stringify(result.json)).toBe(4);
      expect(result.json?.state).toBe("unreadable");
      expect(result.json?.error).toMatch(new RegExp(`${name.replace(".", "\\.")}: not a regular file`));
    });
  }

  // Class: the files of a run must belong to the run that was asked for. Two real runs with the same graph shape and the
  // same number of committed transitions: "st-ok" succeeds, "st-other" fails at its last step, so their states differ.
  async function runPair(runs: string): Promise<void> {
    await runChain(runs, "st-ok", NODE_OK);
    await runChain(runs, "st-other", NODE_OK, { step2Command: NODE_FAIL });
    const lines = (runId: string): number => readFileSync(join(runs, runId, "journal.jsonl"), "utf8").trim().split("\n").length;
    expect(lines("st-other"), "the foreign run must have the same sequence counter as the requested one").toBe(lines("st-ok"));
    expect((await statusCli(["st-other", "--runs-root", runs])).json?.state).toBe("failed");
    expect((await statusCli(["st-ok", "--runs-root", runs])).json?.state).toBe("succeeded");
  }

  const FOREIGN_FILES: Record<string, string[]> = {
    "projection.json": ["projection.json"],
    "journal.jsonl": ["journal.jsonl"],
    "projection.json and journal.jsonl": ["projection.json", "journal.jsonl"],
    "descriptor.json, projection.json and journal.jsonl": ["descriptor.json", "projection.json", "journal.jsonl"],
  };
  for (const [label, names] of Object.entries(FOREIGN_FILES)) {
    it(`${label} copied from another run is unreadable, not the state of the requested run`, async () => {
      const runs = makeRunsRoot();
      await runPair(runs);
      for (const name of names) copyFileSync(join(runs, "st-other", name), join(runs, "st-ok", name));

      const result = await statusCli(["st-ok", "--runs-root", runs]);
      expect(result.code, JSON.stringify(result.json)).toBe(4);
      expect(result.json?.state).toBe("unreadable");
      expect(result.json?.nodes).toBeUndefined();
    });
  }

  const BROKEN_BINDINGS: Record<string, (envelope: Record<string, any>) => void> = {
    "a snapshot of another revision": (envelope) => {
      envelope.revision_id = "rev-other";
    },
    "a snapshot bound to another descriptor hash": (envelope) => {
      envelope.descriptor_hash = "f".repeat(64);
    },
    "a snapshot whose projection names another run": (envelope) => {
      envelope.projection.run_id = "st-other";
    },
    "a snapshot with an unsupported schema": (envelope) => {
      envelope.schema_version = 2;
    },
    "a snapshot without an epoch": (envelope) => {
      delete envelope.epoch;
    },
    "a snapshot with an epoch below every journal record": (envelope) => {
      envelope.epoch = 0;
    },
  };
  for (const [label, damage] of Object.entries(BROKEN_BINDINGS)) {
    it(`${label} is unreadable`, async () => {
      const runs = makeRunsRoot();
      await runChain(runs, "st-bind", NODE_OK);
      editEnvelope(runs, "st-bind", damage);

      const result = await statusCli(["st-bind", "--runs-root", runs]);
      expect(result.code, JSON.stringify(result.json)).toBe(4);
      expect(result.json?.state).toBe("unreadable");
    });
  }

  it("a journal record with a later epoch than the snapshot is unreadable", async () => {
    const runs = makeRunsRoot();
    await runChain(runs, "st-epoch", NODE_OK);
    const file = join(runs, "st-epoch", "journal.jsonl");
    const rows = readFileSync(file, "utf8").trim().split("\n").map((line) => JSON.parse(line) as Record<string, any>);
    rows[rows.length - 1].epoch = (JSON.parse(readFileSync(join(runs, "st-epoch", "projection.json"), "utf8")) as { epoch: number }).epoch + 1;
    writeFileSync(file, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);

    const result = await statusCli(["st-epoch", "--runs-root", runs]);
    expect(result.code, JSON.stringify(result.json)).toBe(4);
    expect(String(result.json?.error)).toMatch(/epoch/);
  });

  it("a run without its descriptor.json is unreadable", async () => {
    const runs = makeRunsRoot();
    await runChain(runs, "st-nodesc", NODE_OK);
    rmSync(join(runs, "st-nodesc", "descriptor.json"));

    const result = await statusCli(["st-nodesc", "--runs-root", runs]);
    expect(result.code, JSON.stringify(result.json)).toBe(4);
    expect(String(result.json?.error)).toMatch(/descriptor\.json/);
  });

  // Class: a check of the run directory is used later than it was made. Each test changes the directory inside the window
  // between the check and the reads. The directory it is changed to is a copy of the run with a forged projection: it
  // belongs to the same run, so only the handling of the window, not the binding to the run, can refuse it.
  describe("a run directory that changes while it is read", () => {
    async function runWithForgedCopy(): Promise<{ runs: string; dir: string; forged: string }> {
      const runs = makeRunsRoot();
      await runChain(runs, "st-ok", NODE_OK);
      const dir = join(runs, "st-ok");
      const forged = join(runs, "st-ok-forged");
      cpSync(dir, forged, { recursive: true });
      const file = join(forged, "projection.json");
      const envelope = JSON.parse(readFileSync(file, "utf8")) as { projection: { activations: Record<string, { status: string }> } };
      for (const activation of Object.values(envelope.projection.activations)) activation.status = "running";
      writeFileSync(file, JSON.stringify(envelope));
      expect(readRunStatus({ runId: "st-ok", runsRoot: runs }).exitCode, "the run itself must read as succeeded").toBe(0);
      return { runs, dir, forged };
    }

    it("a directory swapped for a symbolic link after the check is not read through the link", async () => {
      const { runs, dir, forged } = await runWithForgedCopy();
      const outcome = readRunStatus({
        runId: "st-ok",
        runsRoot: runs,
        interlock: {
          afterDirectoryCheck: () => {
            renameSync(dir, `${dir}.moved`);
            symlinkSync(forged, dir);
          },
        },
      });
      const report = JSON.parse(outcome.stdout) as Record<string, any>;
      expect(outcome.exitCode, outcome.stdout).toBe(4);
      expect(report.state).toBe("unreadable");
      expect(report.nodes, "the report carries the nodes of the directory behind the link").toBeUndefined();
    });

    it("a directory swapped for another real directory after the check is refused", async () => {
      const { runs, dir, forged } = await runWithForgedCopy();
      const outcome = readRunStatus({
        runId: "st-ok",
        runsRoot: runs,
        interlock: {
          afterDirectoryCheck: () => {
            renameSync(dir, `${dir}.moved`);
            cpSync(forged, dir, { recursive: true });
          },
        },
      });
      const report = JSON.parse(outcome.stdout) as Record<string, any>;
      expect(outcome.exitCode, outcome.stdout).toBe(4);
      expect(report.state).toBe("unreadable");
      expect(report.nodes).toBeUndefined();
    });

    it("a directory replaced after the files were read is refused: the name no longer is the directory that was read", async () => {
      const { runs, dir, forged } = await runWithForgedCopy();
      const outcome = readRunStatus({
        runId: "st-ok",
        runsRoot: runs,
        interlock: {
          afterRead: () => {
            renameSync(dir, `${dir}.moved`);
            cpSync(forged, dir, { recursive: true });
          },
        },
      });
      const report = JSON.parse(outcome.stdout) as Record<string, any>;
      expect(outcome.exitCode, outcome.stdout).toBe(4);
      expect(report.state).toBe("unreadable");
      expect(report.error).toMatch(/replaced while it was read/);
    });

    it("without a change the same call reports the run", async () => {
      const { runs } = await runWithForgedCopy();
      const outcome = readRunStatus({ runId: "st-ok", runsRoot: runs, interlock: { afterDirectoryCheck: () => {}, afterRead: () => {} } });
      expect(outcome.exitCode).toBe(0);
      expect((JSON.parse(outcome.stdout) as Record<string, any>).state).toBe("succeeded");
    });
  });

  it("a FIFO in place of projection.json is refused with exit 4 and does not block the command", async () => {
    const runs = makeRunsRoot();
    await runChain(runs, "st-fifo", NODE_OK);
    const projection = join(runs, "st-fifo", "projection.json");
    rmSync(projection);
    makeFifo(projection);

    // Run in a child process: an open() that blocks on a FIFO would hang the test worker itself.
    const cli = spawnSync(
      process.execPath,
      ["--import", "tsx", CLI_ENTRY, "graph", "status", "st-fifo", "--runs-root", runs],
      { cwd: REPO_ROOT, encoding: "utf8", timeout: 60_000, killSignal: "SIGKILL" },
    );
    expect(cli.signal, `the command hung on the FIFO: ${cli.stderr}`).toBeNull();
    expect(cli.status, cli.stderr).toBe(4);
    expect(JSON.parse(cli.stdout).state).toBe("unreadable");
    expect(JSON.parse(cli.stdout).error).toMatch(/projection\.json: not a regular file/);
  }, 90_000);
});
