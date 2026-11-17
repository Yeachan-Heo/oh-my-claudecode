import { type SessionFrictionReport } from '../../features/session-friction-report/index.js';
export interface SessionFrictionReportCommandOptions {
    limit?: number;
    session?: string;
    since?: string;
    project?: string;
    json?: boolean;
    workingDirectory?: string;
}
interface LoggerLike {
    log: (message?: unknown) => void;
}
export declare function formatSessionFrictionReport(report: SessionFrictionReport): string;
export declare function sessionFrictionReportCommand(options: SessionFrictionReportCommandOptions, logger?: LoggerLike): Promise<SessionFrictionReport>;
export {};
//# sourceMappingURL=session-friction-report.d.ts.map