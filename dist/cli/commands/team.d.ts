/**
 * omc team CLI subcommand
 *
 * Full team lifecycle for `omc team`:
 *   omc team [N:agent-type] "task"          Start team (spawns tmux worker panes)
 *   omc team status <team-name>             Monitor team status
 *   omc team shutdown <team-name> [--force] Shutdown team
 *   omc team api <operation> --input '...'  Worker CLI API
 */
export type DecompositionStrategy = 'numbered' | 'bulleted' | 'conjunction' | 'atomic';
export interface DecompositionPlan {
    strategy: DecompositionStrategy;
    subtasks: Array<{
        subject: string;
        description: string;
    }>;
}
/**
 * Count atomic parallelization signals in a task string.
 * Returns true when the task should NOT be decomposed (it's already atomic or tightly coupled).
 */
export declare function hasAtomicParallelizationSignals(task: string, _size: string): boolean;
/**
 * Resolve the effective worker count fanout limit for decomposed tasks.
 * Caps worker count to the number of discovered subtasks when decomposition produces fewer items.
 */
export declare function resolveTeamFanoutLimit(requestedWorkerCount: number, _explicitAgentType: string | undefined, _explicitWorkerCount: number | undefined, plan: DecompositionPlan): number;
/**
 * Decompose a task string into a structured plan.
 *
 * Detects:
 * - Numbered list: "1. fix auth\n2. fix login"
 * - Bulleted list: "- fix auth\n- fix login"
 * - Conjunction: "fix auth and fix login and fix logout"
 * - Atomic: single task, no decomposition
 */
export declare function splitTaskString(task: string): DecompositionPlan;
export interface ParsedWorkerSpec {
    agentType: string;
    role?: string;
}
export interface ParsedTeamArgs {
    workerCount: number;
    agentTypes: string[];
    workerSpecs: ParsedWorkerSpec[];
    role?: string;
    task: string;
    teamName: string;
    json: boolean;
    newWindow: boolean;
}
export declare function assertTeamSpawnAllowed(cwd: string, env?: NodeJS.ProcessEnv): Promise<void>;
/** @internal Exported for testing */
export declare function parseTeamArgs(tokens: string[], defaultAgentType?: string): ParsedTeamArgs;
export declare function buildStartupTasks(parsed: ParsedTeamArgs): Array<{
    subject: string;
    description: string;
    owner?: string;
}>;
/**
 * Main team subcommand handler.
 * Routes:
 *   omc team [N:agent-type] "task"          -> Start team
 *   omc team status <team-name>             -> Monitor
 *   omc team shutdown <team-name> [--force] -> Shutdown
 *   omc team api <operation> [--input] ...  -> Worker CLI API
 */
export declare function teamCommand(args: string[]): Promise<void>;
//# sourceMappingURL=team.d.ts.map