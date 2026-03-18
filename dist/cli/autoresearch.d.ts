import { type AutoresearchKeepPolicy } from '../autoresearch/contracts.js';
import { type AutoresearchSeedInputs } from './autoresearch-intake.js';
export declare const AUTORESEARCH_HELP = "omc autoresearch - Launch OMC autoresearch with thin-supervisor parity semantics\n\nUsage:\n  omc autoresearch                                                (launch interactive intake, then background launch)\n  omc autoresearch [--topic T] [--evaluator CMD] [--keep-policy P] [--slug S]\n  omc autoresearch init [--topic T] [--evaluator CMD] [--keep-policy P] [--slug S]\n  omc autoresearch --mission TEXT --sandbox CMD [--keep-policy P] [--slug S]\n  omc autoresearch <mission-dir> [claude-args...]\n  omc autoresearch --resume <run-id> [claude-args...]\n\nArguments:\n  (no args)        Launch interactive intake that refines the mission/evaluator, writes .omc/specs\n                   artifacts, and launches only after explicit confirmation.\n  --topic/...      Seed the intake with draft values; still requires refinement/confirmation before launch.\n  init             Bare init is an interactive alias on TTYs; init with flags is the expert scaffold path.\n  --mission/       Expert bypass path. --mission is raw mission text and --sandbox is the raw\n  --sandbox        evaluator/sandbox command. Both flags are required together; --keep-policy and\n                   --slug remain optional only when both are present.\n  <mission-dir>    Directory inside a git repository containing mission.md and sandbox.md\n  <run-id>         Existing autoresearch run id from .omc/logs/autoresearch/<run-id>/manifest.json\n\nBehavior:\n  - intake writes canonical artifacts under .omc/specs before launch\n  - validates mission.md and sandbox.md\n  - requires sandbox.md YAML frontmatter with evaluator.command and evaluator.format=json\n  - fresh launch creates a run-tagged autoresearch/<slug>/<run-tag> lane\n  - supervisor records baseline, candidate, keep/discard/reset, and results artifacts under .omc/logs/autoresearch/\n  - --resume loads the authoritative per-run manifest and continues from the last kept commit\n";
export declare function normalizeAutoresearchClaudeArgs(claudeArgs: readonly string[]): string[];
export interface ParsedAutoresearchArgs {
    missionDir: string | null;
    runId: string | null;
    claudeArgs: string[];
    guided?: boolean;
    initArgs?: string[];
    seedArgs?: AutoresearchSeedInputs;
    missionText?: string;
    sandboxCommand?: string;
    keepPolicy?: AutoresearchKeepPolicy;
    slug?: string;
}
export declare function parseAutoresearchArgs(args: readonly string[]): ParsedAutoresearchArgs;
export declare function autoresearchCommand(args: string[]): Promise<void>;
//# sourceMappingURL=autoresearch.d.ts.map