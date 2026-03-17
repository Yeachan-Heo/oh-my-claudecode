import { type AutoresearchKeepPolicy } from '../autoresearch/contracts.js';
export declare const AUTORESEARCH_HELP = "omc autoresearch - Launch OMC autoresearch with thin-supervisor parity semantics\n\nUsage:\n  omc autoresearch                                                (Claude setup + background launch)\n  omc autoresearch --mission TEXT --sandbox CMD [--keep-policy P] [--slug S]\n  omc autoresearch init [--topic T] [--evaluator CMD] [--keep-policy P] [--slug S]\n  omc autoresearch <mission-dir> [claude-args...]\n  omc autoresearch --resume <run-id> [claude-args...]\n\nArguments:\n  (no args)        Short-lived Claude-backed setup: discusses the mission, validates or infers\n                   an evaluator with confidence gating, then spawns autoresearch in a background tmux session.\n  --mission/       Explicit bypass path. --mission is raw mission text and --sandbox is the raw\n  --sandbox        evaluator/sandbox command. Both flags are required together; --keep-policy and\n                   --slug remain optional. Partial bypass is invalid.\n  init             Non-interactive mission scaffolding via flags (--topic, --evaluator, --slug;\n                   optional --keep-policy).\n  <mission-dir>    Directory inside a git repository containing mission.md and sandbox.md\n  <run-id>         Existing autoresearch run id from .omc/logs/autoresearch/<run-id>/manifest.json\n\nBehavior:\n  - validates mission.md and sandbox.md\n  - requires sandbox.md YAML frontmatter with evaluator.command and evaluator.format=json\n  - fresh launch creates a run-tagged autoresearch/<slug>/<run-tag> lane\n  - supervisor records baseline, candidate, keep/discard/reset, and results artifacts under .omc/logs/autoresearch/\n  - --resume loads the authoritative per-run manifest and continues from the last kept commit\n";
export declare function normalizeAutoresearchClaudeArgs(claudeArgs: readonly string[]): string[];
export interface ParsedAutoresearchArgs {
    missionDir: string | null;
    runId: string | null;
    claudeArgs: string[];
    guided?: boolean;
    initArgs?: string[];
    missionText?: string;
    sandboxCommand?: string;
    keepPolicy?: AutoresearchKeepPolicy;
    slug?: string;
}
export declare function parseAutoresearchArgs(args: readonly string[]): ParsedAutoresearchArgs;
export declare function autoresearchCommand(args: string[]): Promise<void>;
//# sourceMappingURL=autoresearch.d.ts.map