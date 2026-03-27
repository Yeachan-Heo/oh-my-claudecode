import { type AutoresearchKeepPolicy } from "../autoresearch/contracts.js";
import { type AutoresearchSeedInputs } from "./autoresearch-intake.js";
export declare const AUTORESEARCH_HELP = "omc autoresearch - Launch OMC autoresearch with thin-supervisor parity semantics\n\nUsage:\n  omc autoresearch                                                (detached Claude deep-interview setup session)\n  omc autoresearch [--topic T] [--evaluator CMD] [--keep-policy P] [--slug S]\n  omc autoresearch --mission TEXT --eval CMD [--keep-policy P] [--slug S]\n  omc autoresearch init [--topic T] [--eval CMD] [--keep-policy P] [--slug S]\n  omc autoresearch <mission-dir> [claude-args...]\n  omc autoresearch --resume <run-id> [claude-args...]\n\nArguments:\n  (no args)        Launches a detached Claude session and starts /deep-interview --autoresearch.\n                   That interview lane should clarify the mission/evaluator, then launch direct\n                   execution via omc autoresearch --mission ... --eval ... from inside Claude.\n  --topic/...      Seed the legacy guided intake with draft values; still requires\n                   refinement/confirmation before launch.\n  --mission/       Explicit bypass path. --mission is raw mission text and --eval is the raw\n  --eval           evaluator command. --sandbox remains accepted as a backward-compatible alias.\n                   Both flags are required together; --keep-policy and --slug remain optional.\n  init             Non-interactive mission scaffolding via flags (--topic, --eval, --slug;\n                   optional --keep-policy).\n  <mission-dir>    Directory inside a git repository containing mission.md and sandbox.md\n  <run-id>         Existing autoresearch run id from .omc/logs/autoresearch/<run-id>/manifest.json\n\nBehavior:\n  - guided intake writes canonical artifacts under .omc/specs before launch when using --topic/--evaluator flow\n  - validates mission.md and sandbox.md\n  - requires sandbox.md YAML frontmatter with evaluator.command and evaluator.format=json\n  - fresh launch creates a run-tagged autoresearch/<slug>/<run-tag> lane\n  - supervisor records baseline, candidate, keep/discard/reset, and results artifacts under .omc/logs/autoresearch/\n  - --resume loads the authoritative per-run manifest and continues from the last kept commit\n";
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