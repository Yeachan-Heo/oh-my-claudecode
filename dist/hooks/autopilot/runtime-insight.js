import { existsSync, readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { getOmcRoot, resolveSessionStatePath } from '../../lib/worktree-paths.js';
import { readHudState } from '../../hud/state.js';
const RUNTIME_INSIGHT_MAX_FIELD_LENGTH = 160;
const RUNTIME_INSIGHT_MAX_LENGTH = 2_000;
function redactRuntimeInsightText(value) {
    return value
        .replace(/(?:^|\s)(?:\/[^\s]+|[A-Za-z]:\\[^\s]+)/g, ' [redacted-path]')
        .replace(/\b[^\s]*transcript[^\s]*\b/gi, '[redacted-transcript]')
        .slice(0, RUNTIME_INSIGHT_MAX_FIELD_LENGTH);
}
function readJsonSafe(path) {
    try {
        if (!existsSync(path)) {
            return null;
        }
        return JSON.parse(readFileSync(path, 'utf-8'));
    }
    catch {
        return null;
    }
}
function getTaskDependencyIds(task) {
    return task.depends_on ?? task.blocked_by ?? [];
}
function getTeamNamesForRuntimeInsight(directory, sessionId) {
    const teamRoot = join(getOmcRoot(directory), 'state', 'team');
    if (!existsSync(teamRoot)) {
        return [];
    }
    const teamNames = readdirSync(teamRoot, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name);
    if (!sessionId) {
        return teamNames;
    }
    const scopedTeamNames = new Set();
    const teamState = readJsonSafe(resolveSessionStatePath('team', sessionId, directory));
    const activeTeamName = teamState?.team_name ?? teamState?.teamName;
    if (typeof activeTeamName === 'string' && activeTeamName.trim().length > 0) {
        scopedTeamNames.add(activeTeamName.trim());
    }
    for (const teamName of teamNames) {
        const manifest = readJsonSafe(join(teamRoot, teamName, 'manifest.json'));
        if (manifest?.leader?.session_id === sessionId) {
            scopedTeamNames.add(teamName);
        }
    }
    return teamNames.filter((teamName) => scopedTeamNames.has(teamName));
}
function getWorkflowProgress(directory, sessionId) {
    const statePath = sessionId
        ? resolveSessionStatePath('autopilot', sessionId, directory)
        : join(getOmcRoot(directory), 'state', 'autopilot-state.json');
    const state = readJsonSafe(statePath);
    const workflow = state?.workflow;
    const tracking = state?.pipelineTracking;
    const stages = Array.isArray(workflow?.stages) ? workflow.stages : null;
    const index = tracking?.currentStageIndex;
    const allowedStages = new Set(['ralplan', 'execution', 'ralph', 'qa']);
    if (!stages ||
        !stages.every((stage) => typeof stage === 'string' && allowedStages.has(stage)) ||
        typeof index !== 'number' ||
        !Number.isInteger(index) ||
        index < 0 ||
        index > stages.length) {
        return null;
    }
    return `${stages[index] ?? 'complete'} ${Math.min(index + 1, stages.length)}/${stages.length}`;
}
function collectRuntimeInsight(directory, sessionId) {
    const missingDependencyIssues = [];
    const workerIssues = [];
    const teamRoot = join(getOmcRoot(directory), 'state', 'team');
    for (const teamName of getTeamNamesForRuntimeInsight(directory, sessionId)) {
        const teamDir = join(teamRoot, teamName);
        const tasksDir = join(teamDir, 'tasks');
        const workersDir = join(teamDir, 'workers');
        const tasks = existsSync(tasksDir)
            ? readdirSync(tasksDir)
                .filter((entry) => entry.endsWith('.json'))
                .map((entry) => readJsonSafe(join(tasksDir, entry)))
                .filter((task) => Boolean(task))
            : [];
        const taskById = new Map(tasks.map((task) => [task.id, task]));
        for (const task of tasks) {
            const missingDependencyIds = getTaskDependencyIds(task)
                .filter((dependencyId) => !taskById.has(dependencyId));
            if (missingDependencyIds.length > 0) {
                missingDependencyIssues.push({
                    teamName,
                    taskId: task.id,
                    missingDependencyIds,
                });
            }
        }
        if (existsSync(workersDir)) {
            for (const workerName of readdirSync(workersDir)) {
                const status = readJsonSafe(join(workersDir, workerName, 'status.json'));
                if (!status || typeof status.reason !== 'string' || status.reason.trim().length === 0) {
                    continue;
                }
                if (status.state !== 'blocked' && status.state !== 'failed') {
                    continue;
                }
                workerIssues.push({
                    teamName,
                    workerName,
                    state: status.state,
                    reason: status.reason.trim(),
                });
            }
        }
    }
    const hudState = readHudState(directory, sessionId);
    const backgroundTasks = hudState?.backgroundTasks ?? [];
    const failedBackgroundTasks = backgroundTasks
        .filter((task) => task.status === 'failed')
        .sort((left, right) => {
        const leftAt = new Date(left.completedAt ?? left.startedAt).getTime();
        const rightAt = new Date(right.completedAt ?? right.startedAt).getTime();
        return rightAt - leftAt;
    });
    const runningBackgroundTasks = backgroundTasks.filter((task) => task.status === 'running');
    const workflowProgress = getWorkflowProgress(directory, sessionId);
    return {
        missingDependencyIssues,
        workerIssues,
        failedBackgroundTasks,
        runningBackgroundTasks,
        workflowProgress,
    };
}
export function formatAutopilotRuntimeInsight(directory, sessionId) {
    const snapshot = collectRuntimeInsight(directory, sessionId);
    const lines = [];
    if (snapshot.missingDependencyIssues.length > 0) {
        lines.push('Current blockers:');
        for (const issue of snapshot.missingDependencyIssues.slice(0, 3)) {
            lines.push(`- [${issue.teamName}] task-${issue.taskId} depends on missing task ids [${issue.missingDependencyIds.join(', ')}]`);
        }
    }
    if (snapshot.workerIssues.length > 0) {
        if (lines.length === 0) {
            lines.push('Current blockers:');
        }
        for (const issue of snapshot.workerIssues.slice(0, 3)) {
            lines.push(`- [${redactRuntimeInsightText(issue.teamName)}] ${redactRuntimeInsightText(issue.workerName)} is ${issue.state}: ${redactRuntimeInsightText(issue.reason)}`);
        }
    }
    if (snapshot.failedBackgroundTasks.length > 0) {
        lines.push(lines.length === 0 ? 'Recent errors:' : 'Recent errors:');
        for (const task of snapshot.failedBackgroundTasks.slice(0, 3)) {
            const agentLabel = task.agentType ? ` (${task.agentType})` : '';
            lines.push(`- background task failed${agentLabel}: ${redactRuntimeInsightText(task.description)}`);
        }
    }
    if (snapshot.runningBackgroundTasks.length > 0) {
        lines.push('Live progress:');
        for (const task of snapshot.runningBackgroundTasks.slice(0, 3)) {
            const agentLabel = task.agentType ? ` (${task.agentType})` : '';
            lines.push(`- running${agentLabel}: ${redactRuntimeInsightText(task.description)}`);
        }
    }
    if (snapshot.workflowProgress) {
        lines.push(`Workflow progress: ${snapshot.workflowProgress}`);
    }
    return lines.length > 0 ? lines.join('\n').slice(0, RUNTIME_INSIGHT_MAX_LENGTH) : '';
}
//# sourceMappingURL=runtime-insight.js.map