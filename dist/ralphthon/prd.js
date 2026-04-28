/**
 * Ralphthon PRD Module
 *
 * Extended PRD schema with hardening support for the ralphthon lifecycle.
 * Handles read/write/status operations for ralphthon-prd.json.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { getOmcRoot } from "../lib/worktree-paths.js";
import { PRD_FILENAME, RALPHTHON_DEFAULTS, } from "./types.js";
// ============================================================================
// File Operations
// ============================================================================
export const DEFAULT_PLANNING_CONTEXT = {
    brownfield: false,
    assumptionsMode: "implicit",
    codebaseMapSummary: "",
    knownConstraints: [],
};
export function normalizePlanningContext(context) {
    return {
        brownfield: context?.brownfield ?? DEFAULT_PLANNING_CONTEXT.brownfield,
        assumptionsMode: context?.assumptionsMode ?? DEFAULT_PLANNING_CONTEXT.assumptionsMode,
        codebaseMapSummary: context?.codebaseMapSummary ??
            DEFAULT_PLANNING_CONTEXT.codebaseMapSummary,
        knownConstraints: Array.isArray(context?.knownConstraints)
            ? [...context.knownConstraints]
            : [...DEFAULT_PLANNING_CONTEXT.knownConstraints],
    };
}
/**
 * Get the path to the ralphthon PRD file in .omc
 */
export function getRalphthonPrdPath(directory) {
    return join(getOmcRoot(directory), PRD_FILENAME);
}
/**
 * Find ralphthon-prd.json (checks both root and .omc)
 */
export function findRalphthonPrdPath(directory) {
    const rootPath = join(directory, PRD_FILENAME);
    if (existsSync(rootPath))
        return rootPath;
    const omcPath = getRalphthonPrdPath(directory);
    if (existsSync(omcPath))
        return omcPath;
    return null;
}
/**
 * Read ralphthon PRD from disk
 */
export function readRalphthonPrd(directory) {
    const prdPath = findRalphthonPrdPath(directory);
    if (!prdPath)
        return null;
    try {
        const content = readFileSync(prdPath, "utf-8");
        const prd = JSON.parse(content);
        if (!prd.stories || !Array.isArray(prd.stories))
            return null;
        if (!prd.config)
            return null;
        prd.planningContext = normalizePlanningContext(prd.planningContext);
        return prd;
    }
    catch {
        return null;
    }
}
/**
 * Write ralphthon PRD to disk
 */
export function writeRalphthonPrd(directory, prd) {
    let prdPath = findRalphthonPrdPath(directory);
    if (!prdPath) {
        const omcDir = getOmcRoot(directory);
        if (!existsSync(omcDir)) {
            try {
                mkdirSync(omcDir, { recursive: true });
            }
            catch {
                return false;
            }
        }
        prdPath = getRalphthonPrdPath(directory);
    }
    try {
        const normalizedPrd = {
            ...prd,
            planningContext: normalizePlanningContext(prd.planningContext),
        };
        writeFileSync(prdPath, JSON.stringify(normalizedPrd, null, 2));
        return true;
    }
    catch {
        return false;
    }
}
/**
 * Compute full status of a ralphthon PRD
 */
export function getRalphthonPrdStatus(prd) {
    const allTasks = [];
    let completedStories = 0;
    for (const story of prd.stories) {
        const storyTasks = story.tasks;
        for (const task of storyTasks) {
            allTasks.push({ storyId: story.id, task });
        }
        const allDone = storyTasks.length > 0 &&
            storyTasks.every((t) => t.status === "done" || t.status === "skipped");
        if (allDone)
            completedStories++;
    }
    const completedTasks = allTasks.filter((t) => t.task.status === "done").length;
    const pendingTasks = allTasks.filter((t) => t.task.status === "pending" || t.task.status === "in_progress").length;
    const failedOrSkippedTasks = allTasks.filter((t) => t.task.status === "failed" || t.task.status === "skipped").length;
    // Find next pending task (by story priority order)
    const priorityOrder = {
        critical: 0,
        high: 1,
        medium: 2,
        low: 3,
    };
    const sortedStories = [...prd.stories].sort((a, b) => (priorityOrder[a.priority] ?? 3) - (priorityOrder[b.priority] ?? 3));
    let nextTask = null;
    for (const story of sortedStories) {
        const pending = story.tasks.find((t) => t.status === "pending");
        if (pending) {
            nextTask = { storyId: story.id, task: pending };
            break;
        }
    }
    // Hardening status
    const hardeningTasks = prd.hardening || [];
    const completedHardening = hardeningTasks.filter((t) => t.status === "done").length;
    const pendingHardening = hardeningTasks.filter((t) => t.status === "pending" || t.status === "in_progress").length;
    const nextHardeningTask = hardeningTasks.find((t) => t.status === "pending") || null;
    return {
        totalStories: prd.stories.length,
        completedStories,
        totalTasks: allTasks.length,
        completedTasks,
        pendingTasks,
        failedOrSkippedTasks,
        allStoriesDone: completedStories === prd.stories.length && prd.stories.length > 0,
        nextTask,
        totalHardeningTasks: hardeningTasks.length,
        completedHardeningTasks: completedHardening,
        pendingHardeningTasks: pendingHardening,
        allHardeningDone: hardeningTasks.length > 0 && pendingHardening === 0,
        nextHardeningTask,
    };
}
function incrementRetry(task, maxRetries) {
    task.retries += 1;
    const skipped = task.retries >= maxRetries;
    if (skipped) {
        task.status = "skipped";
        task.notes = `Skipped after ${task.retries} failed attempts`;
    }
    return { retries: task.retries, skipped };
}
/**
 * Update a story task's status
 */
export function updateTaskStatus(directory, storyId, taskId, status, notes) {
    const prd = readRalphthonPrd(directory);
    if (!prd)
        return false;
    const story = prd.stories.find((s) => s.id === storyId);
    if (!story)
        return false;
    const task = story.tasks.find((t) => t.id === taskId);
    if (!task)
        return false;
    task.status = status;
    if (notes)
        task.notes = notes;
    return writeRalphthonPrd(directory, prd);
}
/**
 * Increment retry count for a task and optionally mark as failed/skipped
 */
export function incrementTaskRetry(directory, storyId, taskId, maxRetries) {
    const prd = readRalphthonPrd(directory);
    if (!prd)
        return { retries: 0, skipped: false };
    const story = prd.stories.find((s) => s.id === storyId);
    if (!story)
        return { retries: 0, skipped: false };
    const task = story.tasks.find((t) => t.id === taskId);
    if (!task)
        return { retries: 0, skipped: false };
    const result = incrementRetry(task, maxRetries);
    writeRalphthonPrd(directory, prd);
    return result;
}
/**
 * Update a hardening task's status
 */
export function updateHardeningTaskStatus(directory, taskId, status, notes) {
    const prd = readRalphthonPrd(directory);
    if (!prd)
        return false;
    const task = prd.hardening.find((t) => t.id === taskId);
    if (!task)
        return false;
    task.status = status;
    if (notes)
        task.notes = notes;
    return writeRalphthonPrd(directory, prd);
}
/**
 * Increment retry count for a hardening task
 */
export function incrementHardeningTaskRetry(directory, taskId, maxRetries) {
    const prd = readRalphthonPrd(directory);
    if (!prd)
        return { retries: 0, skipped: false };
    const task = prd.hardening.find((t) => t.id === taskId);
    if (!task)
        return { retries: 0, skipped: false };
    const result = incrementRetry(task, maxRetries);
    writeRalphthonPrd(directory, prd);
    return result;
}
/**
 * Add hardening tasks to the PRD for a new wave
 */
export function addHardeningTasks(directory, tasks) {
    const prd = readRalphthonPrd(directory);
    if (!prd)
        return false;
    const newTasks = tasks.map((t) => ({
        ...t,
        status: "pending",
        retries: 0,
    }));
    prd.hardening = [...(prd.hardening || []), ...newTasks];
    return writeRalphthonPrd(directory, prd);
}
// ============================================================================
// PRD Creation
// ============================================================================
/**
 * Create a new RalphthonPRD from stories
 */
export function createRalphthonPrd(project, branchName, description, stories, config, planningContext) {
    return {
        project,
        branchName,
        description,
        stories,
        hardening: [],
        config: { ...RALPHTHON_DEFAULTS, ...config },
        planningContext: normalizePlanningContext(planningContext),
    };
}
/**
 * Initialize a ralphthon PRD on disk
 */
export function initRalphthonPrd(directory, project, branchName, description, stories, config, planningContext) {
    const prd = createRalphthonPrd(project, branchName, description, stories, config, planningContext);
    return writeRalphthonPrd(directory, prd);
}
// ============================================================================
// Formatting
// ============================================================================
/**
 * Format a task prompt for injection into the leader pane
 */
export function formatTaskPrompt(storyId, task) {
    return `Implement task ${task.id} from story ${storyId}: ${task.title}

${task.description}

When done, update the task status to "done" in the ralphthon PRD (ralphthon-prd.json).
If you encounter issues, note them. Do NOT stop — continue to the next task.`;
}
/**
 * Format a hardening task prompt for injection
 */
export function formatHardeningTaskPrompt(task) {
    return `[HARDENING] ${task.category.toUpperCase()} task ${task.id}: ${task.title}

${task.description}

When done, update the hardening task status to "done" in the ralphthon PRD.
If you find additional issues during this hardening pass, note them — they'll be picked up in the next wave.`;
}
/**
 * Format the hardening wave generation prompt
 */
export function formatHardeningGenerationPrompt(wave, prd) {
    const completedTasks = prd.stories
        .flatMap((s) => s.tasks)
        .filter((t) => t.status === "done");
    const completedHardening = prd.hardening.filter((t) => t.status === "done");
    return `You are in HARDENING WAVE ${wave} of a ralphthon session.

Review ALL completed work and generate new hardening tasks. Focus on:
1. Edge cases not covered by existing tests
2. Missing test coverage for implemented features
3. Code quality improvements (error handling, validation, types)
4. Security considerations
5. Performance concerns

Completed story tasks: ${completedTasks.length}
Completed hardening tasks: ${completedHardening.length}

Write new hardening tasks to the ralphthon PRD (ralphthon-prd.json) in the hardening array.
Each task needs: id (H-${String(wave).padStart(2, "0")}-NNN), title, description, category, wave: ${wave}.
Set status to "pending" and retries to 0.

If you find NO new issues, write an empty set of new tasks. This signals the code is solid.`;
}
/**
 * Format PRD status summary for display
 */
export function formatRalphthonStatus(prd) {
    const status = getRalphthonPrdStatus(prd);
    const lines = [];
    lines.push(`[Ralphthon: ${prd.project}]`);
    lines.push(`Stories: ${status.completedStories}/${status.totalStories} complete`);
    lines.push(`Tasks: ${status.completedTasks}/${status.totalTasks} done, ${status.failedOrSkippedTasks} skipped`);
    if (status.totalHardeningTasks > 0) {
        lines.push(`Hardening: ${status.completedHardeningTasks}/${status.totalHardeningTasks} done`);
    }
    if (status.nextTask) {
        lines.push(`Next: [${status.nextTask.storyId}] ${status.nextTask.task.id} - ${status.nextTask.task.title}`);
    }
    else if (status.nextHardeningTask) {
        lines.push(`Next hardening: ${status.nextHardeningTask.id} - ${status.nextHardeningTask.title}`);
    }
    else if (status.allStoriesDone) {
        lines.push("All stories complete — ready for hardening");
    }
    return lines.join("\n");
}
//# sourceMappingURL=prd.js.map