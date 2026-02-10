/**
 * Generate a markdown summary report for a team session.
 */
export declare function generateTeamReport(workingDirectory: string, teamName: string): string;
/**
 * Write the report to disk.
 * Path: .omc/reports/team-{teamName}-{timestamp}.md
 * Returns the file path.
 */
export declare function saveTeamReport(workingDirectory: string, teamName: string): string;
//# sourceMappingURL=summary-report.d.ts.map