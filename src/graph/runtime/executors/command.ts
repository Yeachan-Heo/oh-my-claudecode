/**
 * Command node executor for graph runtime v2.
 *
 * Spawns the node's command via a platform shell and reports an outcome
 * object — command failures (non-zero exit, timeout, spawn infra errors)
 * are reported as `failed` outcomes, never thrown. Terminal-success
 * evidence duty stays with the runner/scheduler.
 *
 * Trust model: the descriptor author holds code-execution authority over
 * this host — commands are arbitrary shell lines, so no sandboxing is
 * attempted. What IS bounded here is ambient secret exposure: the child
 * inherits only an allowlisted environment (see CHILD_ENV_ALLOWLIST), not
 * the host's full environment.
 */

import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";

import type {
  ExecutableKind,
  NodeExecutionContext,
  NodeExecutionOutput,
  NodeExecutor,
} from "../types.js";
import type { GraphCommandNode, GraphEvidenceReference } from "../../types.js";
import { buildCommandEnv, idempotencyKeyFor } from "./authority.js";

/** Per-stream captured output cap; the TAIL is kept. */
const STREAM_TAIL_CHARS = 2000;

/** Grace period after the first kill before escalating to a hard kill. */
const KILL_ESCALATION_MS = 5000;

/**
 * Output shape for command attempts. Extends the frozen
 * NodeExecutionOutput with the idempotency key computed for idempotent
 * effect policies (structurally compatible; see team-lead note).
 */
export interface CommandExecutionOutput extends NodeExecutionOutput {
  readonly external_idempotency_key?: string;
}

interface CommandRunResult {
  readonly timed_out: boolean;
  /** null when killed by a signal or the process never spawned. */
  readonly exit_code: number | null;
  readonly infra_error?: string;
}

/** Keeps only the trailing STREAM_TAIL_CHARS of one output stream. */
class StreamTail {
  private content = "";

  append(chunk: string): void {
    const combined = this.content + chunk;
    this.content =
      combined.length > STREAM_TAIL_CHARS
        ? combined.slice(combined.length - STREAM_TAIL_CHARS)
        : combined;
  }

  excerpt(): string {
    return this.content.trim();
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Best-effort termination of the whole process tree.
 *
 * On Windows, `taskkill /F /T` is the tree kill and serves as both soft
 * and hard kill. On POSIX the command runs under `sh -c`, which does NOT
 * exec-replace itself for compound commands: a plain child.kill() reaches
 * only the shell PID while grandchildren survive holding the stdio pipes
 * ("close" never fires). The shell is therefore spawned DETACHED (own
 * process group) and kills address the NEGATIVE pid - the whole group.
 */
function terminateProcessTree(child: ChildProcess, signal: NodeJS.Signals): void {
  if (process.platform === "win32") {
    if (child.pid === undefined) {
      return;
    }
    try {
      // ponytail: taskkill tree-kill covers shell+grandchildren; Job Objects
      // are the upgrade path if detached/detached-process cases appear.
      spawn("taskkill", ["/F", "/T", "/PID", String(child.pid)], { stdio: "ignore" });
    } catch {
      // Nothing further to do; the run result already reports failure.
    }
    return;
  }
  if (child.pid === undefined) {
    return;
  }
  try {
    process.kill(-child.pid, signal);
  } catch {
    // Group kill refused (no such group); fall back to the shell PID.
    try {
      child.kill(signal);
    } catch {
      // Process already gone.
    }
  }
}

/**
 * Not named `runCommand`: that name is a reserved convention in
 * tests/lint/windows-hide-hooks.test.ts for `(command, args)` git-forwarding
 * helpers; this executor runs arbitrary shell lines instead (see trust model).
 */
function runShellCommand(
  command: string,
  timeoutMs: number,
  stdoutTail: StreamTail,
  stderrTail: StreamTail,
  idempotencyKey?: string,
): Promise<CommandRunResult> {
  return new Promise<CommandRunResult>((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn(command, {
        shell: true,
        windowsHide: true,
        cwd: process.cwd(),
        env: buildCommandEnv(idempotencyKey),
        stdio: ["ignore", "pipe", "pipe"],
        // Detached => own process group => the NEGATIVE-pid group kill in
        // terminateProcessTree can reach grandchildren, not just the shell.
        ...(process.platform === "win32" ? {} : { detached: true }),
      });
    } catch (error) {
      resolve({ timed_out: false, exit_code: null, infra_error: describeError(error) });
      return;
    }

    let settled = false;
    let timedOut = false;
    let exitCode: number | null = null;
    let infraError: string | undefined;
    let escalationTimer: ReturnType<typeof setTimeout> | undefined;

    const settle = (): void => {
      if (settled) {
        return;
      }
      settled = true;
      if (timeoutTimer !== undefined) clearTimeout(timeoutTimer);
      if (escalationTimer !== undefined) clearTimeout(escalationTimer);
      resolve({ timed_out: timedOut, exit_code: exitCode, infra_error: infraError });
    };

    if (child.stdout) {
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => stdoutTail.append(chunk));
    }
    if (child.stderr) {
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => stderrTail.append(chunk));
    }

    child.on("error", (error: Error) => {
      infraError = describeError(error);
      settle();
    });

    child.on("close", (code) => {
      exitCode = code;
      settle();
    });

    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      // Soft kill first: SIGTERM to the whole process group (POSIX) or the
      // taskkill tree kill (Windows). Escalation below applies SIGKILL.
      try {
        terminateProcessTree(child, "SIGTERM");
      } catch {
        // Soft kill refused; escalation below applies the hard kill.
      }
      escalationTimer = setTimeout(() => {
        if (!settled) {
          terminateProcessTree(child, "SIGKILL");
        }
      }, KILL_ESCALATION_MS);
    }, timeoutMs);
  });
}

export class CommandNodeExecutor implements NodeExecutor {
  readonly kinds: readonly ExecutableKind[] = ["command"];

  async execute(context: NodeExecutionContext): Promise<NodeExecutionOutput> {
    const dispatched = context.node;
    if (dispatched.kind !== "command") {
      throw new Error(
        `CommandNodeExecutor cannot execute node kind "${dispatched.kind}" (${dispatched.id})`,
      );
    }
    const node: GraphCommandNode = dispatched;

    const startedAtMs = Date.now();
    const stdoutTail = new StreamTail();
    const stderrTail = new StreamTail();
    if (node.effect_policy.policy === "reconcile") {
      return {
        outcome: "failed",
        output_summary: "reconcile policy requires a custom executor",
        evidence_refs: [{ kind: "command", ref: node.command }],
      };
    }
    const externalIdempotencyKey = idempotencyKeyFor(context);
    const result = await runShellCommand(
      node.command,
      node.timeout_ms,
      stdoutTail,
      stderrTail,
      externalIdempotencyKey,
    );
    const durationMs = Date.now() - startedAtMs;

    const succeeded =
      !result.infra_error && !result.timed_out && result.exit_code === 0;
    const outcome: NodeExecutionOutput["outcome"] = succeeded ? "succeeded" : "failed";

    const baseStats = `exit=${result.exit_code ?? "none"} duration_ms=${durationMs}`;

    const summaryParts: string[] = [];
    if (result.timed_out) {
      summaryParts.push(`timeout after ${node.timeout_ms}ms`);
    }
    if (result.infra_error) {
      summaryParts.push(`spawn infra error: ${result.infra_error}`);
    }
    summaryParts.push(baseStats);

    const evidenceRefs: GraphEvidenceReference[] = [
      { kind: "command", ref: node.command, summary: baseStats },
    ];

    const stdoutExcerpt = stdoutTail.excerpt();
    if (stdoutExcerpt) {
      summaryParts.push(`stdout tail: ${stdoutExcerpt}`);
      evidenceRefs.push({
        kind: "command",
        ref: `stdout:${node.command}`,
        summary: stdoutExcerpt,
      });
    }
    const stderrExcerpt = stderrTail.excerpt();
    if (stderrExcerpt) {
      summaryParts.push(`stderr tail: ${stderrExcerpt}`);
      evidenceRefs.push({
        kind: "command",
        ref: `stderr:${node.command}`,
        summary: stderrExcerpt,
      });
    }

    const output: CommandExecutionOutput = {
      outcome,
      output_summary: summaryParts.join("; "),
      evidence_refs: evidenceRefs,
      ...(externalIdempotencyKey === undefined
        ? {}
        : { external_idempotency_key: externalIdempotencyKey }),
    };
    return output;
  }
}
