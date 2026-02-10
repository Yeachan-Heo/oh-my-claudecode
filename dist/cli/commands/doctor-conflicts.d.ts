/**
 * Conflict diagnostic command
 * Scans for and reports plugin coexistence issues.
 */
export interface ConflictReport {
    hookConflicts: {
        event: string;
        command: string;
        isOmc: boolean;
    }[];
    claudeMdStatus: {
        hasMarkers: boolean;
        hasUserContent: boolean;
        path: string;
    } | null;
    envFlags: {
        disableOmc: boolean;
        skipHooks: string[];
    };
    configIssues: {
        unknownFields: string[];
    };
    hasConflicts: boolean;
}
/**
 * Check for hook conflicts in ~/.claude/settings.json
 */
export declare function checkHookConflicts(): ConflictReport['hookConflicts'];
/**
 * Check CLAUDE.md for OMC markers and user content
 */
export declare function checkClaudeMdStatus(): ConflictReport['claudeMdStatus'];
/**
 * Check environment flags that affect OMC behavior
 */
export declare function checkEnvFlags(): ConflictReport['envFlags'];
/**
 * Check for unknown fields in config files
 */
export declare function checkConfigIssues(): ConflictReport['configIssues'];
/**
 * Run complete conflict check
 */
export declare function runConflictCheck(): ConflictReport;
/**
 * Format report for display
 */
export declare function formatReport(report: ConflictReport, json: boolean): string;
/**
 * Doctor conflicts command
 */
export declare function doctorConflictsCommand(options: {
    json?: boolean;
}): Promise<number>;
//# sourceMappingURL=doctor-conflicts.d.ts.map