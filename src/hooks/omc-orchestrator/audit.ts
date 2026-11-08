/**
 * Audit logging for delegation enforcement
 * Logs all Edit/Write operations for analysis
 */

import * as fs from 'fs';
import * as path from 'path';
import { OmcPaths } from '../../lib/worktree-paths.js';

const LOG_DIR = OmcPaths.LOGS;
const LOG_FILE = 'delegation-audit.jsonl';

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
export function logAuditEntry(entry: Omit<AuditEntry, 'timestamp'>): void {
  try {
    const fullEntry: AuditEntry = {
      ...entry,
      timestamp: new Date().toISOString(),
    };

    const logDir = path.join(process.cwd(), LOG_DIR);
    const logPath = path.join(logDir, LOG_FILE);

    // Create directory if it doesn't exist
    fs.mkdirSync(logDir, { recursive: true });

    // Append entry as JSONL
    fs.appendFileSync(logPath, JSON.stringify(fullEntry) + '\n');
  } catch {
    // Silently fail - audit logging should not break main functionality
  }
}

/**
 * Read audit log entries (for analysis)
 */
export function readAuditLog(directory?: string): AuditEntry[] {
  try {
    const logPath = path.join(directory || process.cwd(), LOG_DIR, LOG_FILE);
    if (!fs.existsSync(logPath)) return [];

    const content = fs.readFileSync(logPath, 'utf-8');
    return content
      .split('\n')
      .filter(line => line.trim())
      .map(line => JSON.parse(line) as AuditEntry);
  } catch {
    return [];
  }
}

/**
 * Get audit summary statistics
 */
export function getAuditSummary(directory?: string): {
  total: number;
  allowed: number;
  warned: number;
  byExtension: Record<string, number>;
} {
  const entries = readAuditLog(directory);
  const byExtension: Record<string, number> = {};

  for (const entry of entries) {
    if (entry.decision === 'warned') {
      const ext = path.extname(entry.filePath) || 'unknown';
      byExtension[ext] = (byExtension[ext] || 0) + 1;
    }
  }

  return {
    total: entries.length,
    allowed: entries.filter(e => e.decision === 'allowed').length,
    warned: entries.filter(e => e.decision === 'warned').length,
    byExtension,
  };
}
