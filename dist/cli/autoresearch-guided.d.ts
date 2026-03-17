import { createInterface } from 'readline/promises';
import { type AutoresearchKeepPolicy } from '../autoresearch/contracts.js';
import { type AutoresearchSetupHandoff } from '../autoresearch/setup-contract.js';
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
export interface GuidedAutoresearchSetupDeps {
    createPromptInterface?: typeof createInterface;
    runSetupSession?: (input: AutoresearchSetupSessionInput) => AutoresearchSetupHandoff;
}
export declare function initAutoresearchMission(opts: InitAutoresearchOptions): Promise<InitAutoresearchResult>;
export declare function parseInitArgs(args: readonly string[]): Partial<InitAutoresearchOptions>;
export declare function guidedAutoresearchSetup(repoRoot: string, deps?: GuidedAutoresearchSetupDeps): Promise<InitAutoresearchResult>;
export declare function checkTmuxAvailable(): boolean;
export declare function spawnAutoresearchTmux(missionDir: string, slug: string): void;
export { buildAutoresearchSetupPrompt } from './autoresearch-setup-session.js';
//# sourceMappingURL=autoresearch-guided.d.ts.map