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
import { mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { sealGraphDescriptor } from "../../descriptor.js";
import { CommandNodeExecutor } from "../../runtime/executors/command.js";
import { runGraph } from "../../runtime/runner.js";
import type { NodeExecutor } from "../../runtime/types.js";
import { graphCommand } from "../../../cli/graph.js";

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

function chainDescriptor(runId: string, step1Command: string) {
  return {
    descriptor_version: 1,
    run_id: runId,
    revision_id: `rev-${runId}`,
    goal: "status chain",
    nodes: [commandNode("step-1", step1Command), commandNode("step-2", NODE_OK)],
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
  options: { interruptAfterStepOne?: boolean } = {},
): Promise<void> {
  const sealed = sealGraphDescriptor(chainDescriptor(runId, step1Command));
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
