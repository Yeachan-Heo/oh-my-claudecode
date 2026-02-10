/**
 * Session Catalog
 *
 * Derives session list from the global token-tracking.jsonl file.
 * This is the primary data source for `omc sessions` - it shows
 * real Claude Code sessions with timestamps, costs, and agent usage.
 */
import * as fs from 'fs/promises';
import * as path from 'path';
import { homedir } from 'os';
import { calculateCost } from './cost-estimator.js';
export function isValidTokenUsage(record) {
    if (typeof record !== 'object' || record === null)
        return false;
    const r = record;
    return (typeof r.sessionId === 'string' &&
        typeof r.timestamp === 'string' &&
        typeof r.modelName === 'string' &&
        typeof r.inputTokens === 'number' &&
        typeof r.outputTokens === 'number' &&
        typeof r.cacheCreationTokens === 'number' &&
        typeof r.cacheReadTokens === 'number');
}
const TOKEN_LOG_FILE = path.join(homedir(), '.omc', 'state', 'token-tracking.jsonl');
export class SessionCatalog {
    /**
     * Get all sessions derived from token tracking data.
     * Returns sessions sorted by startTime descending (newest first).
     */
    async getSessions(limit) {
        const records = await this.readTokenLog();
        if (records.length === 0)
            return [];
        // Group by sessionId
        const sessionMap = new Map();
        for (const record of records) {
            const existing = sessionMap.get(record.sessionId) || [];
            existing.push(record);
            sessionMap.set(record.sessionId, existing);
        }
        // Build CatalogSession for each group
        const sessions = [];
        for (const [sessionId, usages] of sessionMap) {
            sessions.push(this.buildCatalogSession(sessionId, usages));
        }
        // Sort by startTime descending (newest first)
        sessions.sort((a, b) => b.startTime.localeCompare(a.startTime));
        return limit ? sessions.slice(0, limit) : sessions;
    }
    /**
     * Get a single session by ID.
     */
    async getSession(sessionId) {
        const records = await this.readTokenLog();
        const sessionRecords = records.filter(r => r.sessionId === sessionId);
        if (sessionRecords.length === 0)
            return null;
        return this.buildCatalogSession(sessionId, sessionRecords);
    }
    /**
     * Get the total number of unique sessions.
     */
    async getSessionCount() {
        const records = await this.readTokenLog();
        const sessionIds = new Set(records.map(r => r.sessionId));
        return sessionIds.size;
    }
    buildCatalogSession(sessionId, usages) {
        let startTime = usages[0].timestamp;
        let endTime = usages[0].timestamp;
        let totalTokens = 0;
        let totalCost = 0;
        const agentBreakdown = {};
        const modelBreakdown = {};
        for (const usage of usages) {
            // Track time range
            if (usage.timestamp < startTime)
                startTime = usage.timestamp;
            if (usage.timestamp > endTime)
                endTime = usage.timestamp;
            // Sum tokens
            const tokens = usage.inputTokens + usage.outputTokens;
            totalTokens += tokens;
            // Calculate cost
            const cost = calculateCost({
                modelName: usage.modelName,
                inputTokens: usage.inputTokens,
                outputTokens: usage.outputTokens,
                cacheCreationTokens: usage.cacheCreationTokens,
                cacheReadTokens: usage.cacheReadTokens,
            });
            totalCost += cost.totalCost;
            // Agent breakdown
            const agentKey = usage.agentName || '(main session)';
            if (!agentBreakdown[agentKey]) {
                agentBreakdown[agentKey] = { tokens: 0, cost: 0 };
            }
            agentBreakdown[agentKey].tokens += tokens;
            agentBreakdown[agentKey].cost += cost.totalCost;
            // Model breakdown
            if (!modelBreakdown[usage.modelName]) {
                modelBreakdown[usage.modelName] = { tokens: 0, cost: 0 };
            }
            modelBreakdown[usage.modelName].tokens += tokens;
            modelBreakdown[usage.modelName].cost += cost.totalCost;
        }
        return {
            sessionId,
            startTime,
            endTime,
            totalTokens,
            totalCost,
            entryCount: usages.length,
            agentBreakdown,
            modelBreakdown,
            source: 'runtime',
        };
    }
    async readTokenLog() {
        try {
            const content = await fs.readFile(TOKEN_LOG_FILE, 'utf-8');
            const lines = content.trim().split('\n').filter(line => line.trim());
            const records = [];
            for (const line of lines) {
                try {
                    const parsed = JSON.parse(line);
                    if (isValidTokenUsage(parsed)) {
                        records.push(parsed);
                    }
                }
                catch {
                    continue; // Skip malformed lines
                }
            }
            return records;
        }
        catch (error) {
            if (error instanceof Error && 'code' in error && error.code !== 'ENOENT') {
                console.warn('[session-catalog] Failed to read token log:', error.message);
            }
            return [];
        }
    }
}
// Singleton
let catalogInstance = null;
export function getSessionCatalog() {
    if (!catalogInstance) {
        catalogInstance = new SessionCatalog();
    }
    return catalogInstance;
}
//# sourceMappingURL=session-catalog.js.map