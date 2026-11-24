import { type AutoresearchSetupHandoff } from '../autoresearch/setup-contract.js';
export interface AutoresearchRepoSignalSummary {
    lines: string[];
}
export interface AutoresearchSetupSessionInput {
    repoRoot: string;
    missionText: string;
    explicitEvaluatorCommand?: string;
    clarificationAnswers?: string[];
    repoSignals?: AutoresearchRepoSignalSummary;
}
export declare function collectAutoresearchRepoSignals(repoRoot: string): AutoresearchRepoSignalSummary;
export declare function buildAutoresearchSetupPrompt(input: AutoresearchSetupSessionInput): string;
export declare function runAutoresearchSetupSession(input: AutoresearchSetupSessionInput): AutoresearchSetupHandoff;
//# sourceMappingURL=autoresearch-setup-session.d.ts.map