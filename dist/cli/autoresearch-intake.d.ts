import { type AutoresearchKeepPolicy } from '../autoresearch/contracts.js';
export interface AutoresearchSeedInputs {
    topic?: string;
    evaluatorCommand?: string;
    keepPolicy?: AutoresearchKeepPolicy;
    slug?: string;
}
export interface AutoresearchDraftCompileTarget {
    topic: string;
    evaluatorCommand: string;
    keepPolicy: AutoresearchKeepPolicy;
    slug: string;
    repoRoot: string;
}
export interface AutoresearchDraftArtifact {
    compileTarget: AutoresearchDraftCompileTarget;
    path: string;
    content: string;
    launchReady: boolean;
    blockedReasons: string[];
}
export interface AutoresearchDeepInterviewResult {
    compileTarget: AutoresearchDraftCompileTarget;
    draftArtifactPath: string;
    missionArtifactPath: string;
    sandboxArtifactPath: string;
    resultPath: string;
    missionContent: string;
    sandboxContent: string;
    launchReady: boolean;
    blockedReasons: string[];
}
export declare function buildMissionContent(topic: string): string;
export declare function buildSandboxContent(evaluatorCommand: string, keepPolicy?: AutoresearchKeepPolicy): string;
export declare function isLaunchReadyEvaluatorCommand(command: string): boolean;
export declare function writeAutoresearchDraftArtifact(input: {
    repoRoot: string;
    topic: string;
    evaluatorCommand?: string;
    keepPolicy: AutoresearchKeepPolicy;
    slug?: string;
    seedInputs?: AutoresearchSeedInputs;
}): Promise<AutoresearchDraftArtifact>;
export declare function writeAutoresearchDeepInterviewArtifacts(input: {
    repoRoot: string;
    topic: string;
    evaluatorCommand?: string;
    keepPolicy: AutoresearchKeepPolicy;
    slug?: string;
    seedInputs?: AutoresearchSeedInputs;
}): Promise<AutoresearchDeepInterviewResult>;
//# sourceMappingURL=autoresearch-intake.d.ts.map