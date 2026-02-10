/**
 * Boulder State Storage
 *
 * Handles reading/writing boulder.json for active plan tracking.
 *
 * Ported from oh-my-opencode's boulder-state.
 */
import { existsSync, readFileSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'fs';
import { dirname, join, basename } from 'path';
import { BOULDER_DIR, BOULDER_FILE, PLANNER_PLANS_DIR, PLAN_EXTENSION } from './constants.js';
import { atomicWriteSync } from '../../lib/atomic-write.js';
/**
 * Get the full path to the boulder state file
 */
export function getBoulderFilePath(directory) {
    return join(directory, BOULDER_DIR, BOULDER_FILE);
}
/**
 * Read boulder state from disk
 */
export function readBoulderState(directory) {
    const filePath = getBoulderFilePath(directory);
    if (!existsSync(filePath)) {
        return null;
    }
    try {
        const content = readFileSync(filePath, 'utf-8');
        return JSON.parse(content);
    }
    catch {
        return null;
    }
}
/**
 * Write boulder state to disk
 */
export function writeBoulderState(directory, state) {
    const filePath = getBoulderFilePath(directory);
    try {
        const dir = dirname(filePath);
        if (!existsSync(dir)) {
            mkdirSync(dir, { recursive: true });
        }
        atomicWriteSync(filePath, JSON.stringify(state, null, 2));
        return true;
    }
    catch {
        return false;
    }
}
/**
 * Append a session ID to the boulder state
 */
export function appendSessionId(directory, sessionId) {
    const state = readBoulderState(directory);
    if (!state)
        return null;
    if (!state.session_ids.includes(sessionId)) {
        state.session_ids.push(sessionId);
        if (writeBoulderState(directory, state)) {
            return state;
        }
    }
    return state;
}
/**
 * Clear boulder state (delete the file)
 */
export function clearBoulderState(directory) {
    const filePath = getBoulderFilePath(directory);
    try {
        if (existsSync(filePath)) {
            unlinkSync(filePath);
        }
        return true;
    }
    catch {
        return false;
    }
}
/**
 * Find Planner plan files for this project.
 * Planner stores plans at: {project}/.omc/plans/{name}.md
 */
export function findPlannerPlans(directory) {
    const plansDir = join(directory, PLANNER_PLANS_DIR);
    if (!existsSync(plansDir)) {
        return [];
    }
    try {
        const files = readdirSync(plansDir);
        return files
            .filter((f) => f.endsWith(PLAN_EXTENSION))
            .map((f) => join(plansDir, f))
            .sort((a, b) => {
            // Sort by modification time, newest first
            const aStat = statSync(a);
            const bStat = statSync(b);
            return bStat.mtimeMs - aStat.mtimeMs;
        });
    }
    catch {
        return [];
    }
}
/**
 * Parse a plan file and count checkbox progress.
 */
export function getPlanProgress(planPath) {
    if (!existsSync(planPath)) {
        return { total: 0, completed: 0, isComplete: true };
    }
    try {
        const content = readFileSync(planPath, 'utf-8');
        // Match markdown checkboxes: - [ ] or - [x] or - [X]
        const uncheckedMatches = content.match(/^[-*]\s*\[\s*\]/gm) || [];
        const checkedMatches = content.match(/^[-*]\s*\[[xX]\]/gm) || [];
        const total = uncheckedMatches.length + checkedMatches.length;
        const completed = checkedMatches.length;
        return {
            total,
            completed,
            isComplete: total === 0 || completed === total,
        };
    }
    catch {
        return { total: 0, completed: 0, isComplete: true };
    }
}
/**
 * Extract plan name from file path.
 */
export function getPlanName(planPath) {
    return basename(planPath, PLAN_EXTENSION);
}
/**
 * Create a new boulder state for a plan.
 */
export function createBoulderState(planPath, sessionId) {
    return {
        active_plan: planPath,
        started_at: new Date().toISOString(),
        session_ids: [sessionId],
        plan_name: getPlanName(planPath),
    };
}
/**
 * Get summaries of all available plans
 */
export function getPlanSummaries(directory) {
    const plans = findPlannerPlans(directory);
    return plans.map((planPath) => {
        const stat = statSync(planPath);
        return {
            path: planPath,
            name: getPlanName(planPath),
            progress: getPlanProgress(planPath),
            lastModified: new Date(stat.mtimeMs),
        };
    });
}
/**
 * Check if a boulder is currently active
 */
export function hasBoulder(directory) {
    return readBoulderState(directory) !== null;
}
/**
 * Get the active plan path from boulder state
 */
export function getActivePlanPath(directory) {
    const state = readBoulderState(directory);
    return state?.active_plan ?? null;
}
//# sourceMappingURL=storage.js.map