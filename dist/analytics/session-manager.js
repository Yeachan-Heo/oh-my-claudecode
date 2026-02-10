import { readState, writeState, clearState, StateLocation } from '../features/state-manager/index.js';
import { getTokenTracker } from './token-tracker.js';
import { getGitDiffStats } from '../hooks/omc-orchestrator/index.js';
import * as path from 'path';
const SESSION_HISTORY_FILE = 'session-history';
/**
 * Source file extensions to track for filesModified
 */
const SOURCE_FILE_EXTENSIONS = new Set([
    '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
    '.py', '.rb', '.go', '.rs', '.java', '.kt', '.scala',
    '.c', '.cpp', '.cc', '.h', '.hpp',
    '.cs', '.fs', '.vb',
    '.swift', '.m', '.mm',
    '.php', '.lua', '.pl', '.pm',
    '.sh', '.bash', '.zsh', '.fish',
    '.sql', '.graphql', '.gql',
    '.html', '.css', '.scss', '.sass', '.less',
    '.json', '.yaml', '.yml', '.toml', '.xml',
    '.md', '.mdx', '.txt',
    '.vue', '.svelte', '.astro',
]);
/**
 * Internal storage for session activity tracking
 */
const sessionActivity = new Map();
/**
 * Record a completed task for a session
 */
export function recordTaskCompleted(sessionId) {
    const activity = sessionActivity.get(sessionId) || { tasksCompleted: 0, errorCount: 0 };
    activity.tasksCompleted++;
    sessionActivity.set(sessionId, activity);
}
/**
 * Record an error for a session
 */
export function recordError(sessionId) {
    const activity = sessionActivity.get(sessionId) || { tasksCompleted: 0, errorCount: 0 };
    activity.errorCount++;
    sessionActivity.set(sessionId, activity);
}
/**
 * Get session activity metrics
 */
export function getSessionActivity(sessionId) {
    return sessionActivity.get(sessionId) || { tasksCompleted: 0, errorCount: 0 };
}
/**
 * Clear session activity (called when session ends)
 */
export function clearSessionActivity(sessionId) {
    sessionActivity.delete(sessionId);
}
/**
 * Get modified files from git diff, filtered to source files
 */
function getModifiedSourceFiles(projectPath) {
    try {
        const gitStats = getGitDiffStats(projectPath);
        return gitStats
            .map(stat => stat.path)
            .filter(filePath => {
            const ext = path.extname(filePath).toLowerCase();
            return SOURCE_FILE_EXTENSIONS.has(ext);
        });
    }
    catch {
        // Git might not be available or not a git repo
        return [];
    }
}
/**
 * Calculate success rate from tasks and errors
 */
function calculateSuccessRate(tasksCompleted, errorCount) {
    const total = tasksCompleted + errorCount;
    if (total === 0) {
        return 1.0; // Default to 100% when no tasks tracked
    }
    return tasksCompleted / total;
}
export class SessionManager {
    currentSession = null;
    history = null;
    async startSession(goals, tags = ['other'], notes = '') {
        const session = {
            id: this.generateSessionId(),
            projectPath: process.cwd(),
            goals,
            tags,
            startTime: new Date().toISOString(),
            status: 'active',
            outcomes: [],
            notes
        };
        this.currentSession = session;
        await this.saveCurrentSession();
        return session;
    }
    async endSession(outcomes, status = 'completed') {
        if (!this.currentSession) {
            throw new Error('No active session to end');
        }
        const endTime = new Date().toISOString();
        const startTime = new Date(this.currentSession.startTime);
        const duration = new Date(endTime).getTime() - startTime.getTime();
        this.currentSession.endTime = endTime;
        this.currentSession.duration = duration;
        this.currentSession.status = status;
        this.currentSession.outcomes = outcomes;
        // Add to history
        await this.addToHistory(this.currentSession);
        const completedSession = { ...this.currentSession };
        this.currentSession = null;
        return completedSession;
    }
    async getCurrentSession() {
        if (!this.currentSession) {
            // Try to load from state
            const result = readState('current-session', StateLocation.GLOBAL);
            if (result.exists && result.data && result.data.status === 'active') {
                this.currentSession = result.data;
            }
        }
        return this.currentSession;
    }
    async resumeSession(sessionId) {
        const history = await this.loadHistory();
        const session = history.sessions.find(s => s.id === sessionId);
        if (!session) {
            throw new Error(`Session ${sessionId} not found in history`);
        }
        if (session.status !== 'active') {
            // Reactivate session
            session.status = 'active';
            delete session.endTime;
            delete session.duration;
        }
        this.currentSession = session;
        await this.saveCurrentSession();
        return session;
    }
    async getSessionAnalytics(sessionId) {
        const tracker = getTokenTracker();
        const stats = await tracker.loadSessionStats(sessionId);
        // Get session activity metrics
        const activity = getSessionActivity(sessionId);
        // Get session metadata to find project path
        const history = await this.loadHistory();
        const sessionMeta = history.sessions.find(s => s.id === sessionId);
        const projectPath = sessionMeta?.projectPath || this.currentSession?.projectPath || process.cwd();
        // Get modified files from git
        const filesModified = getModifiedSourceFiles(projectPath);
        // Calculate success rate
        const successRate = calculateSuccessRate(activity.tasksCompleted, activity.errorCount);
        if (!stats) {
            // Return analytics with activity tracking but no token stats
            return {
                sessionId,
                totalTokens: 0,
                totalCost: 0,
                agentUsage: {},
                modelUsage: {},
                filesModified,
                tasksCompleted: activity.tasksCompleted,
                errorCount: activity.errorCount,
                successRate
            };
        }
        // Aggregate agent usage
        const agentUsage = {};
        for (const [agent, usages] of Object.entries(stats.byAgent)) {
            agentUsage[agent] = usages.reduce((sum, u) => sum + u.inputTokens + u.outputTokens, 0);
        }
        // Aggregate model usage
        const modelUsage = {};
        for (const [model, usages] of Object.entries(stats.byModel)) {
            modelUsage[model] = usages.reduce((sum, u) => sum + u.inputTokens + u.outputTokens, 0);
        }
        const totalTokens = stats.totalInputTokens + stats.totalOutputTokens;
        return {
            sessionId,
            totalTokens,
            totalCost: stats.totalCost,
            agentUsage,
            modelUsage,
            filesModified,
            tasksCompleted: activity.tasksCompleted,
            errorCount: activity.errorCount,
            successRate
        };
    }
    async getSessionSummary(sessionId) {
        const history = await this.loadHistory();
        const metadata = history.sessions.find(s => s.id === sessionId);
        if (!metadata) {
            throw new Error(`Session ${sessionId} not found`);
        }
        const analytics = await this.getSessionAnalytics(sessionId);
        return { metadata, analytics };
    }
    async getHistory() {
        return this.loadHistory();
    }
    async searchSessions(query) {
        const history = await this.loadHistory();
        return history.sessions.filter(session => {
            if (query.tags && !query.tags.some(tag => session.tags.includes(tag))) {
                return false;
            }
            if (query.status && session.status !== query.status) {
                return false;
            }
            if (query.projectPath && session.projectPath !== query.projectPath) {
                return false;
            }
            if (query.startDate && session.startTime < query.startDate) {
                return false;
            }
            if (query.endDate && session.endTime && session.endTime > query.endDate) {
                return false;
            }
            return true;
        });
    }
    async saveCurrentSession() {
        if (this.currentSession) {
            writeState('current-session', this.currentSession, StateLocation.GLOBAL);
        }
    }
    async loadHistory() {
        if (this.history) {
            return this.history;
        }
        // Migration: check if local session history exists and needs to be moved to global
        await this.migrateLocalToGlobal();
        const result = readState(SESSION_HISTORY_FILE, StateLocation.GLOBAL);
        if (result.exists && result.data) {
            this.history = result.data;
            return result.data;
        }
        // Initialize empty history
        this.history = {
            sessions: [],
            totalSessions: 0,
            totalCost: 0,
            averageDuration: 0,
            successRate: 0,
            lastUpdated: new Date().toISOString()
        };
        return this.history;
    }
    /**
     * Migrate session history from local (.omc/state/) to global (~/.omc/state/).
     * Runs once on first loadHistory() call. Handles three cases:
     * - Local exists, global doesn't: copy local to global
     * - Both exist: merge, dedup by session ID
     * - Only global or neither: no-op
     */
    async migrateLocalToGlobal() {
        const localResult = readState(SESSION_HISTORY_FILE, StateLocation.LOCAL);
        if (!localResult.exists || !localResult.data) {
            return; // Nothing to migrate
        }
        const globalResult = readState(SESSION_HISTORY_FILE, StateLocation.GLOBAL);
        let writeSuccess = false;
        if (!globalResult.exists || !globalResult.data) {
            // Case 1: Local exists, global doesn't - just copy
            const result = writeState(SESSION_HISTORY_FILE, localResult.data, StateLocation.GLOBAL);
            writeSuccess = result.success;
            if (writeSuccess) {
                console.log('[session-manager] Migrated session history from local to global state');
            }
        }
        else {
            // Case 2: Both exist - merge and dedup by session ID
            const existingIds = new Set(globalResult.data.sessions.map(s => s.id));
            const newSessions = localResult.data.sessions.filter(s => !existingIds.has(s.id));
            if (newSessions.length > 0) {
                const merged = {
                    ...globalResult.data,
                    sessions: [...globalResult.data.sessions, ...newSessions],
                    totalSessions: globalResult.data.sessions.length + newSessions.length,
                    lastUpdated: new Date().toISOString()
                };
                const result = writeState(SESSION_HISTORY_FILE, merged, StateLocation.GLOBAL);
                writeSuccess = result.success;
                if (writeSuccess) {
                    console.log(`[session-manager] Merged ${newSessions.length} sessions from local to global state`);
                }
            }
            else {
                // Nothing new to merge, safe to clean up local
                writeSuccess = true;
            }
        }
        // Only clean up local copy after confirmed successful global write
        if (writeSuccess) {
            try {
                clearState(SESSION_HISTORY_FILE, StateLocation.LOCAL);
            }
            catch (error) {
                console.warn('[session-manager] Failed to clean up local session history after migration:', error instanceof Error ? error.message : String(error));
            }
        }
        // Also migrate current-session if it exists locally
        const localCurrentSession = readState('current-session', StateLocation.LOCAL);
        if (localCurrentSession.exists && localCurrentSession.data) {
            const globalCurrentSession = readState('current-session', StateLocation.GLOBAL);
            if (!globalCurrentSession.exists) {
                const result = writeState('current-session', localCurrentSession.data, StateLocation.GLOBAL);
                if (result.success) {
                    try {
                        clearState('current-session', StateLocation.LOCAL);
                    }
                    catch {
                        // Best effort cleanup
                    }
                }
            }
            else {
                // Global already has current-session - validate before cleaning up local
                // Prefer the newer session to avoid discarding active state
                const globalData = globalCurrentSession.data;
                const localData = localCurrentSession.data;
                if (globalData && localData) {
                    const globalTime = globalData.endTime || globalData.startTime || '';
                    const localTime = localData.endTime || localData.startTime || '';
                    if (localTime > globalTime) {
                        // Local is newer — overwrite global with local, then clean up
                        const result = writeState('current-session', localData, StateLocation.GLOBAL);
                        if (result.success) {
                            try {
                                clearState('current-session', StateLocation.LOCAL);
                            }
                            catch {
                                // Best effort cleanup
                            }
                        }
                    }
                    else {
                        // Global is newer or same — safe to clean up local
                        try {
                            clearState('current-session', StateLocation.LOCAL);
                        }
                        catch {
                            // Best effort cleanup
                        }
                    }
                }
                else {
                    // Can't compare — leave local in place (fail safe)
                }
            }
        }
    }
    async addToHistory(session) {
        const history = await this.loadHistory();
        history.sessions.push(session);
        history.totalSessions++;
        history.lastUpdated = new Date().toISOString();
        // Recalculate aggregates
        const completedSessions = history.sessions.filter(s => s.status === 'completed');
        if (completedSessions.length > 0) {
            const totalDuration = completedSessions.reduce((sum, s) => sum + (s.duration || 0), 0);
            history.averageDuration = totalDuration / completedSessions.length;
            history.successRate = completedSessions.length / history.totalSessions;
        }
        // Calculate total cost (requires analytics for each session)
        let totalCost = 0;
        for (const s of history.sessions) {
            const analytics = await this.getSessionAnalytics(s.id);
            totalCost += analytics.totalCost;
        }
        history.totalCost = totalCost;
        writeState(SESSION_HISTORY_FILE, history, StateLocation.GLOBAL);
        this.history = history;
    }
    generateSessionId() {
        return `session-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    }
}
// Singleton instance
let globalManager = null;
export function getSessionManager() {
    if (!globalManager) {
        globalManager = new SessionManager();
    }
    return globalManager;
}
export function resetSessionManager() {
    globalManager = new SessionManager();
    return globalManager;
}
//# sourceMappingURL=session-manager.js.map