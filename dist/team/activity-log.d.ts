export interface ActivityEntry {
    timestamp: string;
    actor: string;
    action: string;
    target?: string;
    details?: string;
    category: 'task' | 'file' | 'message' | 'lifecycle' | 'error';
}
/**
 * Get structured activity log from audit events.
 * Enriches audit events with human-readable descriptions.
 */
export declare function getActivityLog(workingDirectory: string, teamName: string, options?: {
    since?: string;
    limit?: number;
    category?: ActivityEntry['category'];
    actor?: string;
}): ActivityEntry[];
/**
 * Generate a human-readable activity timeline.
 */
export declare function formatActivityTimeline(activities: ActivityEntry[]): string;
//# sourceMappingURL=activity-log.d.ts.map