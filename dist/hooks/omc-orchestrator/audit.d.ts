/**
 * Audit logging for delegation enforcement
 * Logs all Edit/Write operations for analysis
 */
export interface AuditEntry {
    timestamp: string;
    tool: string;
    filePath: string;
    decision: 'allowed' | 'warned' | 'blocked';
    reason: 'allowed_path' | 'source_file' | 'other';
    enforcementLevel?: 'off' | 'warn' | 'strict';
    sessionId?: string;
}
/**
 * Log an audit entry for delegation enforcement
 */
export declare function logAuditEntry(entry: Omit<AuditEntry, 'timestamp'>): void;
/**
 * Read audit log entries (for analysis)
 */
export declare function readAuditLog(directory?: string): AuditEntry[];
/**
 * Get audit summary statistics
 */
export declare function getAuditSummary(directory?: string): {
    total: number;
    allowed: number;
    warned: number;
    byExtension: Record<string, number>;
};
//# sourceMappingURL=audit.d.ts.map