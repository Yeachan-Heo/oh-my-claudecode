import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWriteJsonSync } from '../lib/atomic-write.js';
import { getOmcRoot } from '../lib/worktree-paths.js';
import { truncateToWidth } from '../utils/string-width.js';
import { canonicalizeWorkers } from '../team/worker-canonicalization.js';
const DEFAULT_CONFIG = {
    enabled: false,
    maxMissions: 2,
    maxAgentsPerMission: 3,
    maxTimelineEvents: 3,
    persistCompletedForMinutes: 20,
};
const STATUS_ORDER = {
    running: 0,
    blocked: 1,
    waiting: 2,
    done: 3,
};
export const DEFAULT_MISSION_BOARD_CONFIG = DEFAULT_CONFIG;
function resolveConfig(config) {
    return {
        ...DEFAULT_CONFIG,
        ...config,
        enabled: config?.enabled ?? DEFAULT_CONFIG.enabled,
    };
}
function stateFilePath(directory) {
    return join(getOmcRoot(directory), 'state', 'mission-state.json');
}
function readJsonSafe(path) {
    if (!existsSync(path))
        return null;
    try {
        return JSON.parse(readFileSync(path, 'utf-8'));
    }
    catch {
        return null;
    }
}
function readJsonLinesSafe(path) {
    if (!existsSync(path))
        return [];
    try {
        return readFileSync(path, 'utf-8')
            .split('\n')
            .map((line) => line.trim())
            .filter(Boolean)
            .map((line) => JSON.parse(line));
    }
    catch {
        return [];
    }
}
function writeState(directory, state) {
    const stateDir = join(getOmcRoot(directory), 'state');
    if (!existsSync(stateDir)) {
        mkdirSync(stateDir, { recursive: true });
    }
    atomicWriteJsonSync(stateFilePath(directory), state);
    return state;
}
function parseTime(value) {
    if (!value)
        return 0;
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : 0;
}
function compactText(value, width = 64) {
    const trimmed = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
    if (!trimmed)
        return null;
    return truncateToWidth(trimmed, width);
}
function formatTime(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime()))
        return '--:--';
    return date.toISOString().slice(11, 16);
}
function latest(...values) {
    return values
        .filter((value) => Boolean(value))
        .sort((left, right) => parseTime(right) - parseTime(left))[0];
}
function shortAgentType(agentType) {
    return agentType.replace(/^oh-my-claudecode:/, '').trim() || 'agent';
}
function sessionAgentName(agentType, agentId) {
    return `${shortAgentType(agentType)}:${agentId.slice(0, 7)}`;
}
function summarizeTask(task) {
    if (!task)
        return null;
    return compactText(task.result || task.summary || task.error || task.subject || task.description, 56);
}
function deriveSessionStatus(mission) {
    if (mission.taskCounts.inProgress > 0)
        return 'running';
    if (mission.taskCounts.blocked > 0 || mission.taskCounts.failed > 0)
        return 'blocked';
    if (mission.taskCounts.completed === mission.taskCounts.total && mission.taskCounts.total > 0)
        return 'done';
    return 'waiting';
}
function ensureSessionMission(state, input) {
    const missionId = `session:${input.sessionId}:${input.parentMode || 'session'}`;
    let mission = state.missions.find((entry) => entry.id === missionId && entry.source === 'session');
    if (!mission) {
        mission = {
            id: missionId,
            source: 'session',
            name: input.parentMode || 'session',
            objective: compactText(input.taskDescription, 72) || 'Session mission',
            createdAt: input.at || new Date().toISOString(),
            updatedAt: input.at || new Date().toISOString(),
            status: 'running',
            workerCount: 0,
            taskCounts: { total: 0, pending: 0, blocked: 0, inProgress: 0, completed: 0, failed: 0 },
            agents: [],
            timeline: [],
        };
        state.missions.push(mission);
    }
    return mission;
}
function recalcSessionMission(mission) {
    mission.workerCount = mission.agents.length;
    mission.taskCounts = {
        total: mission.agents.length,
        pending: mission.agents.filter((agent) => agent.status === 'waiting').length,
        blocked: mission.agents.filter((agent) => agent.status === 'blocked').length,
        inProgress: mission.agents.filter((agent) => agent.status === 'running').length,
        completed: mission.agents.filter((agent) => agent.status === 'done').length,
        failed: 0,
    };
    mission.status = deriveSessionStatus(mission);
}
export function readMissionBoardState(directory) {
    return readJsonSafe(stateFilePath(directory));
}
export function recordMissionAgentStart(directory, input) {
    const now = input.at || new Date().toISOString();
    const state = readMissionBoardState(directory) || { updatedAt: now, missions: [] };
    const mission = ensureSessionMission(state, input);
    const agentName = sessionAgentName(input.agentType, input.agentId);
    const agent = mission.agents.find((entry) => entry.ownership === input.agentId) || {
        name: agentName,
        role: shortAgentType(input.agentType),
        ownership: input.agentId,
        status: 'running',
        currentStep: null,
        latestUpdate: null,
        completedSummary: null,
        updatedAt: now,
    };
    agent.status = 'running';
    agent.currentStep = compactText(input.taskDescription, 56);
    agent.latestUpdate = compactText(input.taskDescription, 64);
    agent.completedSummary = null;
    agent.updatedAt = now;
    if (!mission.agents.includes(agent)) {
        mission.agents.push(agent);
    }
    mission.updatedAt = now;
    mission.timeline.push({
        id: `session-start:${input.agentId}:${now}`,
        at: now,
        kind: 'update',
        agent: agent.name,
        detail: compactText(input.taskDescription || `started ${agent.name}`, 72) || `started ${agent.name}`,
        sourceKey: `session-start:${input.agentId}`,
    });
    mission.timeline = mission.timeline.slice(-DEFAULT_CONFIG.maxTimelineEvents);
    recalcSessionMission(mission);
    state.updatedAt = now;
    return writeState(directory, state);
}
export function recordMissionAgentStop(directory, input) {
    const now = input.at || new Date().toISOString();
    const state = readMissionBoardState(directory) || { updatedAt: now, missions: [] };
    const mission = state.missions
        .filter((entry) => entry.source === 'session' && entry.id.startsWith(`session:${input.sessionId}:`))
        .sort((left, right) => parseTime(right.updatedAt) - parseTime(left.updatedAt))[0];
    if (!mission) {
        return state;
    }
    const agent = mission.agents.find((entry) => entry.ownership === input.agentId) || mission.agents[0];
    if (!agent) {
        return state;
    }
    agent.status = input.success ? 'done' : 'blocked';
    agent.currentStep = null;
    agent.latestUpdate = compactText(input.outputSummary, 64) || (input.success ? 'completed' : 'blocked');
    agent.completedSummary = input.success ? compactText(input.outputSummary, 64) : null;
    agent.updatedAt = now;
    mission.updatedAt = now;
    mission.timeline.push({
        id: `session-stop:${input.agentId}:${now}`,
        at: now,
        kind: input.success ? 'completion' : 'failure',
        agent: agent.name,
        detail: compactText(input.outputSummary || (input.success ? 'completed' : 'blocked'), 72) || (input.success ? 'completed' : 'blocked'),
        sourceKey: `session-stop:${input.agentId}`,
    });
    recalcSessionMission(mission);
    state.updatedAt = now;
    return writeState(directory, state);
}
function deriveTeamStatus(taskCounts, agents) {
    if (taskCounts.inProgress > 0 || agents.some((agent) => agent.status === 'running')) {
        return 'running';
    }
    if (taskCounts.blocked > 0 || taskCounts.failed > 0 || agents.some((agent) => agent.status === 'blocked')) {
        return 'blocked';
    }
    if (taskCounts.total > 0 && taskCounts.completed === taskCounts.total) {
        return 'done';
    }
    return 'waiting';
}
function deriveWorkerStatus(workerStatus, task) {
    if (workerStatus?.state === 'blocked' || workerStatus?.state === 'failed' || task?.status === 'blocked' || task?.status === 'failed')
        return 'blocked';
    if (workerStatus?.state === 'working' || task?.status === 'in_progress')
        return 'running';
    if (workerStatus?.state === 'done' || task?.status === 'completed')
        return 'done';
    return 'waiting';
}
function collectTeamMission(teamRoot, teamName, config) {
    const teamConfig = readJsonSafe(join(teamRoot, 'config.json'));
    if (!teamConfig)
        return null;
    const workers = canonicalizeWorkers((Array.isArray(teamConfig.workers) ? teamConfig.workers : []).map((worker, index) => ({
        name: worker.name ?? '',
        index: index + 1,
        role: worker.role ?? 'worker',
        assigned_tasks: Array.isArray(worker.assigned_tasks) ? worker.assigned_tasks : [],
    }))).workers;
    const tasksDir = join(teamRoot, 'tasks');
    const tasks = existsSync(tasksDir)
        ? readdirSync(tasksDir)
            .filter((entry) => /^(?:task-)?\d+\.json$/i.test(entry))
            .map((entry) => readJsonSafe(join(tasksDir, entry)))
            .filter((task) => Boolean(task?.id))
        : [];
    const taskById = new Map(tasks.map((task) => [task.id, task]));
    const taskCounts = {
        total: tasks.length,
        pending: tasks.filter((task) => task.status === 'pending').length,
        blocked: tasks.filter((task) => task.status === 'blocked').length,
        inProgress: tasks.filter((task) => task.status === 'in_progress').length,
        completed: tasks.filter((task) => task.status === 'completed').length,
        failed: tasks.filter((task) => task.status === 'failed').length,
    };
    const timeline = [];
    for (const event of readJsonLinesSafe(join(teamRoot, 'events.jsonl'))) {
        if (!event.created_at || !event.type)
            continue;
        if (event.type === 'task_completed' || event.type === 'task_failed') {
            timeline.push({
                id: `event:${event.event_id || `${event.type}:${event.created_at}`}`,
                at: event.created_at,
                kind: event.type === 'task_completed' ? 'completion' : 'failure',
                agent: event.worker || 'leader-fixed',
                detail: compactText(`${event.type === 'task_completed' ? 'completed' : 'failed'} task ${event.task_id ?? '?'}`, 72) || event.type,
                sourceKey: `event:${event.event_id || event.type}`,
            });
        }
        else if (event.type === 'team_leader_nudge' || event.type === 'worker_idle' || event.type === 'worker_stopped') {
            timeline.push({
                id: `event:${event.event_id || `${event.type}:${event.created_at}`}`,
                at: event.created_at,
                kind: 'update',
                agent: event.worker || 'leader-fixed',
                detail: compactText(event.reason || event.type.replace(/_/g, ' '), 72) || event.type,
                sourceKey: `event:${event.event_id || event.type}`,
            });
        }
    }
    for (const worker of workers) {
        const workerName = worker.name?.trim();
        if (!workerName)
            continue;
        const mailbox = readJsonSafe(join(teamRoot, 'mailbox', `${workerName}.json`));
        for (const message of mailbox?.messages ?? []) {
            if (!message.created_at || !message.body)
                continue;
            timeline.push({
                id: `handoff:${message.message_id || `${workerName}:${message.created_at}`}`,
                at: message.created_at,
                kind: 'handoff',
                agent: workerName,
                detail: compactText(message.body, 72) || 'handoff',
                sourceKey: `handoff:${message.message_id || workerName}`,
            });
        }
    }
    timeline.sort((left, right) => parseTime(left.at) - parseTime(right.at));
    const agents = workers.slice(0, config.maxAgentsPerMission).map((worker) => {
        const workerName = worker.name?.trim() || 'worker';
        const workerStatus = readJsonSafe(join(teamRoot, 'workers', workerName, 'status.json'));
        const heartbeat = readJsonSafe(join(teamRoot, 'workers', workerName, 'heartbeat.json'));
        const ownedTasks = tasks.filter((task) => task.owner === workerName);
        const currentTask = (workerStatus?.current_task_id ? taskById.get(workerStatus.current_task_id) : undefined)
            || ownedTasks.find((task) => task.status === 'in_progress')
            || ownedTasks.find((task) => task.status === 'blocked')
            || (worker.assigned_tasks || []).map((taskId) => taskById.get(taskId)).find(Boolean)
            || undefined;
        const completedTask = [...ownedTasks]
            .filter((task) => task.status === 'completed' || task.status === 'failed')
            .sort((left, right) => parseTime(right.completed_at) - parseTime(left.completed_at))[0];
        const latestTimeline = [...timeline].reverse().find((entry) => entry.agent === workerName);
        const ownership = Array.from(new Set([
            ...(worker.assigned_tasks || []),
            ...ownedTasks.map((task) => task.id || ''),
        ].filter(Boolean)))
            .map((taskId) => `#${taskId}`)
            .join(',');
        return {
            name: workerName,
            role: worker.role,
            ownership: ownership || undefined,
            status: deriveWorkerStatus(workerStatus ?? null, currentTask),
            currentStep: compactText(workerStatus?.reason
                || (currentTask?.id && currentTask.subject ? `#${currentTask.id} ${currentTask.subject}` : currentTask?.subject)
                || currentTask?.description, 56),
            latestUpdate: compactText(workerStatus?.reason || latestTimeline?.detail || summarizeTask(currentTask), 64),
            completedSummary: summarizeTask(completedTask),
            updatedAt: latest(workerStatus?.updated_at, heartbeat?.last_turn_at, latestTimeline?.at, completedTask?.completed_at),
        };
    });
    const createdAt = teamConfig.created_at || latest(...timeline.map((entry) => entry.at)) || new Date().toISOString();
    const updatedAt = latest(createdAt, ...timeline.map((entry) => entry.at), ...agents.map((agent) => agent.updatedAt)) || createdAt;
    return {
        id: `team:${teamName}`,
        source: 'team',
        teamName,
        name: teamName,
        objective: compactText(teamConfig.task, 72) || teamName,
        createdAt,
        updatedAt,
        status: deriveTeamStatus(taskCounts, agents),
        workerCount: workers.length,
        taskCounts,
        agents,
        timeline: timeline.slice(-config.maxTimelineEvents),
    };
}
function mergeMissions(previous, teamMissions, config) {
    const previousMissions = previous?.missions || [];
    const sessionMissions = previousMissions.filter((mission) => mission.source === 'session');
    const currentIds = new Set(teamMissions.map((mission) => mission.id));
    const cutoff = Date.now() - (config.persistCompletedForMinutes * 60_000);
    const preservedTeams = previousMissions.filter((mission) => (mission.source === 'team'
        && !currentIds.has(mission.id)
        && mission.status === 'done'
        && parseTime(mission.updatedAt) >= cutoff));
    return [...teamMissions, ...sessionMissions, ...preservedTeams]
        .sort((left, right) => {
        const statusDelta = STATUS_ORDER[left.status] - STATUS_ORDER[right.status];
        if (statusDelta !== 0)
            return statusDelta;
        return parseTime(right.updatedAt) - parseTime(left.updatedAt);
    })
        .slice(0, config.maxMissions);
}
export function refreshMissionBoardState(directory, rawConfig = DEFAULT_CONFIG) {
    const config = resolveConfig(rawConfig);
    const previous = readMissionBoardState(directory);
    const teamsRoot = join(getOmcRoot(directory), 'state', 'team');
    const teamMissions = existsSync(teamsRoot)
        ? readdirSync(teamsRoot, { withFileTypes: true })
            .filter((entry) => entry.isDirectory())
            .map((entry) => collectTeamMission(join(teamsRoot, entry.name), entry.name, config))
            .filter((mission) => Boolean(mission))
        : [];
    const state = {
        updatedAt: new Date().toISOString(),
        missions: mergeMissions(previous, teamMissions, config),
    };
    return writeState(directory, state);
}
export function renderMissionBoard(state, rawConfig = DEFAULT_CONFIG) {
    if (!state || !Array.isArray(state.missions) || state.missions.length === 0)
        return [];
    const config = resolveConfig(rawConfig);
    const lines = [];
    for (const mission of state.missions.slice(0, config.maxMissions)) {
        const summary = [
            `${mission.taskCounts.completed}/${mission.taskCounts.total} done`,
            ...(mission.taskCounts.inProgress > 0 ? [`${mission.taskCounts.inProgress} active`] : []),
            ...(mission.taskCounts.blocked > 0 ? [`${mission.taskCounts.blocked} blocked`] : []),
            ...(mission.taskCounts.pending > 0 ? [`${mission.taskCounts.pending} waiting`] : []),
            ...(mission.taskCounts.failed > 0 ? [`${mission.taskCounts.failed} failed`] : []),
        ].join(' · ');
        lines.push(`MISSION ${mission.name} [${mission.status}] · ${summary} · ${mission.objective}`);
        for (const agent of mission.agents.slice(0, config.maxAgentsPerMission)) {
            const badge = agent.status === 'running'
                ? 'run'
                : agent.status === 'blocked'
                    ? 'blk'
                    : agent.status === 'done'
                        ? 'done'
                        : 'wait';
            const detail = agent.status === 'done'
                ? agent.completedSummary || agent.latestUpdate || agent.currentStep || 'done'
                : agent.latestUpdate || agent.currentStep || 'no update';
            lines.push(`  [${badge}] ${agent.name}${agent.role ? ` (${agent.role})` : ''}${agent.ownership ? ` · own:${agent.ownership}` : ''} · ${detail}`);
        }
        if (mission.timeline.length > 0) {
            const timeline = mission.timeline.slice(-config.maxTimelineEvents).map((entry) => {
                const label = entry.kind === 'completion'
                    ? 'done'
                    : entry.kind === 'failure'
                        ? 'fail'
                        : entry.kind;
                return `${formatTime(entry.at)} ${label} ${entry.agent}: ${entry.detail}`;
            }).join(' | ');
            lines.push(`  timeline: ${timeline}`);
        }
    }
    return lines;
}
//# sourceMappingURL=mission-board.js.map