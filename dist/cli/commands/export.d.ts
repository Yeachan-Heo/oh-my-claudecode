import { ExportFormat } from '../../analytics/export.js';
export declare function exportCommand(type: 'cost' | 'sessions' | 'patterns', format: ExportFormat, outputPath: string, options: {
    period?: 'daily' | 'weekly' | 'monthly';
}): Promise<void>;
//# sourceMappingURL=export.d.ts.map