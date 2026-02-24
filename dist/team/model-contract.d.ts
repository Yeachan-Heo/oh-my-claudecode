export type CliAgentType = 'claude' | 'codex' | 'gemini';
export interface CliAgentContract {
    agentType: CliAgentType;
    binary: string;
    installInstructions: string;
    buildLaunchArgs(model?: string, extraFlags?: string[]): string[];
    parseOutput(rawOutput: string): string;
    /** Whether this agent supports a prompt/headless mode that bypasses TUI input */
    supportsPromptMode?: boolean;
    /** CLI flag for prompt mode (e.g., '-p' for gemini) */
    promptModeFlag?: string;
}
export interface WorkerLaunchConfig {
    teamName: string;
    workerName: string;
    model?: string;
    cwd: string;
    extraFlags?: string[];
}
export declare function getContract(agentType: CliAgentType): CliAgentContract;
export declare function isCliAvailable(agentType: CliAgentType): boolean;
export declare function validateCliAvailable(agentType: CliAgentType): void;
export declare function buildLaunchArgs(agentType: CliAgentType, config: WorkerLaunchConfig): string[];
export declare function buildWorkerArgv(agentType: CliAgentType, config: WorkerLaunchConfig): string[];
export declare function buildWorkerCommand(agentType: CliAgentType, config: WorkerLaunchConfig): string;
export declare function getWorkerEnv(teamName: string, workerName: string, agentType: CliAgentType): Record<string, string>;
export declare function parseCliOutput(agentType: CliAgentType, rawOutput: string): string;
/**
 * Check if an agent type supports prompt/headless mode (bypasses TUI).
 */
export declare function isPromptModeAgent(agentType: CliAgentType): boolean;
/**
 * Get the extra CLI args needed to pass an instruction in prompt mode.
 * Returns empty array if the agent does not support prompt mode.
 */
export declare function getPromptModeArgs(agentType: CliAgentType, instruction: string): string[];
//# sourceMappingURL=model-contract.d.ts.map