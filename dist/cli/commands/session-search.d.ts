import { type SessionHistorySearchReport } from '../../features/session-history-search/index.js';
export interface SessionSearchCommandOptions {
    limit?: number;
    session?: string;
    since?: string;
    project?: string;
    json?: boolean;
    caseSensitive?: boolean;
    context?: number;
    workingDirectory?: string;
}
interface LoggerLike {
    log: (message?: unknown) => void;
}
export declare function formatSessionSearchReport(report: SessionHistorySearchReport): string;
export declare function sessionSearchCommand(query: string, options: SessionSearchCommandOptions, logger?: LoggerLike): Promise<SessionHistorySearchReport>;
export {};
//# sourceMappingURL=session-search.d.ts.map