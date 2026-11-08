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
import type { ExecutableKind, NodeExecutionContext, NodeExecutionOutput, NodeExecutor } from "../types.js";
/**
 * Output shape for command attempts. Extends the frozen
 * NodeExecutionOutput with the idempotency key computed for idempotent
 * effect policies (structurally compatible; see team-lead note).
 */
export interface CommandExecutionOutput extends NodeExecutionOutput {
    readonly external_idempotency_key?: string;
}
export declare class CommandNodeExecutor implements NodeExecutor {
    readonly kinds: readonly ExecutableKind[];
    execute(context: NodeExecutionContext): Promise<NodeExecutionOutput>;
}
//# sourceMappingURL=command.d.ts.map