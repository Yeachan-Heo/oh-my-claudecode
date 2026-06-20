import { encodeProjectPath } from '../../utils/encode-project-path.js';
import type { SessionHistorySearchOptions, SessionHistorySearchReport } from './types.js';
declare function parseSinceSpec(since?: string): number | undefined;
export declare function searchSessionHistory(rawOptions: SessionHistorySearchOptions): Promise<SessionHistorySearchReport>;
export { encodeProjectPath, parseSinceSpec };
export type { SessionHistoryMatch, SessionHistorySearchOptions, SessionHistorySearchReport, } from './types.js';
//# sourceMappingURL=index.d.ts.map