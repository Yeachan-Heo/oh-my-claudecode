export declare const AUTORESEARCH_HELP = "omc autoresearch - HARD DEPRECATED\n\nThis command is no longer the authoritative autoresearch workflow.\n\nUse this flow instead:\n  1. /deep-interview --autoresearch \"<mission idea>\"\n     - use deep-interview to generate/setup the mission and evaluator\n  2. /oh-my-claudecode:autoresearch\n     - run the stateful single-mission autoresearch skill\n\nKey behavior:\n  - v1 is single-mission only\n  - runtime requires an explicit evaluator script/command\n  - non-passing iterations do not stop the run\n  - the run stops at an explicit max-runtime ceiling\n\nLegacy CLI examples such as:\n  omc autoresearch --mission \"...\" --eval \"...\"\n  omc autoresearch init ...\n  omc autoresearch --resume ...\nare hard-deprecated shims and no longer launch the old runtime.\n";
export declare function normalizeAutoresearchClaudeArgs(claudeArgs: readonly string[]): string[];
export interface ParsedAutoresearchArgs {
    args: string[];
    deprecated: true;
}
export declare function parseAutoresearchArgs(args: readonly string[]): ParsedAutoresearchArgs;
export declare function autoresearchCommand(args: string[]): Promise<void>;
//# sourceMappingURL=autoresearch.d.ts.map