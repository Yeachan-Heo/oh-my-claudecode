import type { NodeExecutionContext } from "../types.js";
/** Built-in agent execution is read-only and never prompts for extra access. */
export declare const READ_ONLY_AGENT_TOOLS: readonly ["Read", "Glob", "Grep"];
/** Environment for arbitrary command nodes, including graph-owned variables. */
export declare function buildCommandEnv(idempotencyKey?: string): NodeJS.ProcessEnv;
/** Environment for the read-only Agent SDK subprocess. */
export declare function buildAgentEnv(idempotencyKey?: string): NodeJS.ProcessEnv;
/** Resolve an idempotency key before an external effect starts. */
export declare function idempotencyKeyFor(context: NodeExecutionContext): string | undefined;
//# sourceMappingURL=authority.d.ts.map