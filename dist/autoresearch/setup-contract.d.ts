import { type AutoresearchKeepPolicy } from './contracts.js';
export declare const AUTORESEARCH_SETUP_CONFIDENCE_THRESHOLD = 0.8;
export type AutoresearchSetupEvaluatorSource = 'user' | 'inferred';
export interface AutoresearchSetupHandoff {
    missionText: string;
    evaluatorCommand: string;
    evaluatorSource: AutoresearchSetupEvaluatorSource;
    confidence: number;
    keepPolicy?: AutoresearchKeepPolicy;
    slug: string;
    readyToLaunch: boolean;
    clarificationQuestion?: string;
    repoSignals?: string[];
}
export declare function buildSetupSandboxContent(evaluatorCommand: string, keepPolicy?: AutoresearchKeepPolicy): string;
export declare function validateAutoresearchSetupHandoff(raw: unknown): AutoresearchSetupHandoff;
export declare function parseAutoresearchSetupHandoffJson(raw: string): AutoresearchSetupHandoff;
//# sourceMappingURL=setup-contract.d.ts.map