import { encodeProjectPath } from '../../utils/encode-project-path.js';
import type { SessionHistorySearchOptions, SessionHistorySearchReport } from './types.js';
declare function parseSinceSpec(since?: string): number | undefined;
declare function isWithinProject(projectPath: string | undefined, projectRoots: string[]): boolean;
export declare function searchSessionHistory(rawOptions: SessionHistorySearchOptions): Promise<SessionHistorySearchReport>;
export { encodeProjectPath, isWithinProject as __testingIsWithinProject, parseSinceSpec };
export type { SessionHistoryMatch, SessionHistorySearchOptions, SessionHistorySearchReport, } from './types.js';
//# sourceMappingURL=index.d.ts.map