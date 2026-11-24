export type AutoresearchKeepPolicy = 'score_improvement' | 'pass_only';
export interface AutoresearchEvaluatorContract {
    command: string;
    format: 'json';
    keep_policy?: AutoresearchKeepPolicy;
}
export interface ParsedSandboxContract {
    frontmatter: Record<string, unknown>;
    evaluator: AutoresearchEvaluatorContract;
    body: string;
}
export interface AutoresearchEvaluatorResult {
    pass: boolean;
    score?: number;
}
export interface AutoresearchMissionContract {
    missionDir: string;
    repoRoot: string;
    missionFile: string;
    sandboxFile: string;
    missionRelativeDir: string;
    missionContent: string;
    sandboxContent: string;
    sandbox: ParsedSandboxContract;
    missionSlug: string;
}
export declare function slugifyMissionName(value: string): string;
export declare function parseSandboxContract(content: string): ParsedSandboxContract;
export declare function parseEvaluatorResult(raw: string): AutoresearchEvaluatorResult;
export declare function loadAutoresearchMissionContract(missionDirArg: string): Promise<AutoresearchMissionContract>;
//# sourceMappingURL=contracts.d.ts.map