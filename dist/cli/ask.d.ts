export declare const ASK_USAGE: string;
declare const ASK_PROVIDERS: readonly ["claude", "codex", "gemini"];
export type AskProvider = (typeof ASK_PROVIDERS)[number];
export interface ParsedAskArgs {
    provider: AskProvider;
    prompt: string;
    agentPromptRole?: string;
}
export declare function parseAskArgs(args: readonly string[]): ParsedAskArgs;
export declare function resolveAskAdvisorScriptPath(packageRoot?: string, env?: NodeJS.ProcessEnv): string;
export declare function askCommand(args: string[]): Promise<void>;
export {};
//# sourceMappingURL=ask.d.ts.map