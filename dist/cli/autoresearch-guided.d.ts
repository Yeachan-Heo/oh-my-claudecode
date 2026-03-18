import { type AutoresearchKeepPolicy } from '../autoresearch/contracts.js';
import { type AutoresearchSeedInputs } from './autoresearch-intake.js';
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
export declare function initAutoresearchMission(opts: InitAutoresearchOptions): Promise<InitAutoresearchResult>;
export declare function parseInitArgs(args: readonly string[]): Partial<InitAutoresearchOptions>;
export declare function runAutoresearchNoviceBridge(repoRoot: string, seedInputs?: AutoresearchSeedInputs, io?: AutoresearchQuestionIO): Promise<InitAutoresearchResult>;
export declare function guidedAutoresearchSetup(repoRoot: string, seedInputs?: AutoresearchSeedInputs, io?: AutoresearchQuestionIO): Promise<InitAutoresearchResult>;
export declare function checkTmuxAvailable(): boolean;
export declare function spawnAutoresearchTmux(missionDir: string, slug: string): void;
//# sourceMappingURL=autoresearch-guided.d.ts.map