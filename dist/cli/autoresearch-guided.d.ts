import { createInterface } from 'readline/promises';
import { type AutoresearchKeepPolicy } from '../autoresearch/contracts.js';
import { type AutoresearchSetupHandoff } from '../autoresearch/setup-contract.js';
import { type AutoresearchDeepInterviewResult, type AutoresearchSeedInputs } from './autoresearch-intake.js';
import { type AutoresearchSetupSessionInput } from './autoresearch-setup-session.js';
export interface InitAutoresearchOptions {
    topic: string;
    evaluatorCommand: string;
    keepPolicy?: AutoresearchKeepPolicy;
    slug: string;
    repoRoot: string;
}
export interface InitAutoresearchResult {
    missionDir: string;
    slug: string;
}
export interface AutoresearchQuestionIO {
    question(prompt: string): Promise<string>;
    close(): void;
}
export interface GuidedAutoresearchSetupDeps {
    createPromptInterface?: typeof createInterface;
    runSetupSession?: (input: AutoresearchSetupSessionInput) => AutoresearchSetupHandoff;
}
export declare function materializeAutoresearchDeepInterviewResult(result: AutoresearchDeepInterviewResult): Promise<InitAutoresearchResult>;
export declare function initAutoresearchMission(opts: InitAutoresearchOptions): Promise<InitAutoresearchResult>;
export declare function parseInitArgs(args: readonly string[]): Partial<InitAutoresearchOptions>;
export declare function runAutoresearchNoviceBridge(repoRoot: string, seedInputs?: AutoresearchSeedInputs, io?: AutoresearchQuestionIO): Promise<InitAutoresearchResult>;
export declare function guidedAutoresearchSetup(repoRoot: string, seedInputs?: AutoresearchSeedInputs, io?: AutoresearchQuestionIO): Promise<InitAutoresearchResult>;
export declare function guidedAutoresearchSetupInference(repoRoot: string, deps?: GuidedAutoresearchSetupDeps): Promise<InitAutoresearchResult>;
export declare function checkTmuxAvailable(): boolean;
export declare function spawnAutoresearchTmux(missionDir: string, slug: string): void;
export declare function prepareAutoresearchSetupCodexHome(repoRoot: string, sessionName: string): string;
export declare function buildAutoresearchSetupSlashCommand(): string;
export declare function spawnAutoresearchSetupTmux(repoRoot: string): void;
export { buildAutoresearchSetupPrompt } from './autoresearch-setup-session.js';
//# sourceMappingURL=autoresearch-guided.d.ts.map