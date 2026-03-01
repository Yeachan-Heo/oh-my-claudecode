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
        companionFile?: string;
    } | null;
    legacySkills: {
        name: string;
        path: string;
    }[];
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
 * Check for hook conflicts in both profile-level (~/.claude/settings.json)
 * and project-level (./.claude/settings.json).
 *
 * Claude Code settings precedence: project > profile > defaults.
 * We check both levels so the diagnostic is complete.
 */
export declare function checkHookConflicts(): ConflictReport['hookConflicts'];
/**
 * Check CLAUDE.md for OMC markers and user content.
 * Also checks companion files (CLAUDE-omc.md, etc.) for the file-split pattern
 * where users keep OMC config in a separate file.
 */
export declare function checkClaudeMdStatus(): ConflictReport['claudeMdStatus'];
/**
 * Check environment flags that affect OMC behavior
 */
export declare function checkEnvFlags(): ConflictReport['envFlags'];
/**
 * Check for legacy curl-installed skills that collide with plugin skill names.
 * Only flags skills whose names match actual installed plugin skills, avoiding
 * false positives for user's custom skills.
 */
export declare function checkLegacySkills(): ConflictReport['legacySkills'];
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