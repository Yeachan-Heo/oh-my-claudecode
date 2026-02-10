import { CostReport, UsagePattern } from './query-engine.js';
import { SessionHistory } from './session-types.js';
export type ExportFormat = 'json' | 'csv';
export declare function exportCostReport(report: CostReport, format: ExportFormat, outputPath: string): Promise<void>;
export declare function exportSessionHistory(history: SessionHistory, format: ExportFormat, outputPath: string): Promise<void>;
export declare function exportUsagePatterns(patterns: UsagePattern, format: ExportFormat, outputPath: string): Promise<void>;
//# sourceMappingURL=export.d.ts.map