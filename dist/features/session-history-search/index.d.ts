import { encodeProjectPath } from '../../utils/encode-project-path.js';
import type { SessionHistoryMatch, SessionHistorySearchOptions, SessionHistorySearchReport } from './types.js';
declare function parseSinceSpec(since?: string): number | undefined;
declare function isWithinProject(projectPath: string | undefined, projectRoots: string[]): boolean;
interface MatchRetainer {
    add(match: SessionHistoryMatch): void;
    readonly retained: SessionHistoryMatch[];
    readonly totalMatches: number;
}
declare function createMatchRetainer(limit: number): MatchRetainer;
export declare function searchSessionHistory(rawOptions: SessionHistorySearchOptions): Promise<SessionHistorySearchReport>;
export { encodeProjectPath, isWithinProject as __testingIsWithinProject, parseSinceSpec, createMatchRetainer as __testingCreateMatchRetainer, };
export type { SessionHistoryMatch, SessionHistorySearchOptions, SessionHistorySearchReport, } from './types.js';
//# sourceMappingURL=index.d.ts.map