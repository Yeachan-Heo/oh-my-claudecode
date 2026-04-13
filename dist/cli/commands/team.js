/**
 * omc team CLI subcommand
 *
 * Full team lifecycle for `omc team`:
 *   omc team [N:agent-type] "task"          Start team (spawns tmux worker panes)
 *   omc team status <team-name>             Monitor team status
 *   omc team shutdown <team-name> [--force] Shutdown team
 *   omc team api <operation> --input '...'  Worker CLI API
 */
import { TEAM_API_OPERATIONS, resolveTeamApiOperation, executeTeamApiOperation, } from '../../team/api-interop.js';
import { loadConfig } from '../../config/loader.js';
const HELP_TOKENS = new Set(['--help', '-h', 'help']);
const MIN_WORKER_COUNT = 1;
const MAX_WORKER_COUNT = 20;
const VALID_TEAM_CLI_AGENT_TYPES = new Set(['claude', 'codex', 'gemini']);
const DEFAULT_TEAM_CLI_AGENT_TYPE = 'claude';
const TEAM_HELP = `
Usage: omc team [N:agent-type[:role]] [--new-window] "<task description>"
       omc team status <team-name>
       omc team shutdown <team-name> [--force]
       omc team api <operation> [--input <json>] [--json]
       omc team api --help

Examples:
  omc team 3:claude "fix failing tests"
  omc team 2:codex:architect "design auth system"
  omc team 1:gemini:executor "implement feature"
  omc team 1:codex,1:gemini "compare approaches"
  omc team 2:codex "review auth flow" --new-window
  omc team status fix-failing-tests
  omc team shutdown fix-failing-tests
  omc team api send-message --input '{"team_name":"my-team","from_worker":"worker-1","to_worker":"leader-fixed","body":"ACK"}' --json

Roles (optional): architect, executor, planner, analyst, critic, debugger, verifier,
  code-reviewer, security-reviewer, test-engineer, debugger, designer, writer, scientist
`;
const TEAM_API_HELP = `
Usage: omc team api <operation> [--input <json>] [--json]
       omc team api <operation> --help

Supported operations:
  ${TEAM_API_OPERATIONS.join('\n  ')}

Examples:
  omc team api list-tasks --input '{"team_name":"my-team"}' --json
  omc team api claim-task --input '{"team_name":"my-team","task_id":"1","worker":"worker-1","expected_version":1}' --json
`;
const TEAM_API_OPERATION_REQUIRED_FIELDS = {
    'send-message': ['team_name', 'from_worker', 'to_worker', 'body'],
    'broadcast': ['team_name', 'from_worker', 'body'],
    'mailbox-list': ['team_name', 'worker'],
    'mailbox-mark-delivered': ['team_name', 'worker', 'message_id'],
    'mailbox-mark-notified': ['team_name', 'worker', 'message_id'],
    'create-task': ['team_name', 'subject', 'description'],
    'read-task': ['team_name', 'task_id'],
    'list-tasks': ['team_name'],
    'update-task': ['team_name', 'task_id'],
    'claim-task': ['team_name', 'task_id', 'worker'],
    'transition-task-status': ['team_name', 'task_id', 'from', 'to', 'claim_token'],
    'release-task-claim': ['team_name', 'task_id', 'claim_token', 'worker'],
    'read-config': ['team_name'],
    'read-manifest': ['team_name'],
    'read-worker-status': ['team_name', 'worker'],
    'read-worker-heartbeat': ['team_name', 'worker'],
    'update-worker-heartbeat': ['team_name', 'worker', 'pid', 'turn_count', 'alive'],
    'write-worker-inbox': ['team_name', 'worker', 'content'],
    'write-worker-identity': ['team_name', 'worker', 'index', 'role'],
    'append-event': ['team_name', 'type', 'worker'],
    'get-summary': ['team_name'],
    'cleanup': ['team_name'],
    'orphan-cleanup': ['team_name'],
    'write-shutdown-request': ['team_name', 'worker', 'requested_by'],
    'read-shutdown-ack': ['team_name', 'worker'],
    'read-monitor-snapshot': ['team_name'],
    'write-monitor-snapshot': ['team_name', 'snapshot'],
    'read-task-approval': ['team_name', 'task_id'],
    'write-task-approval': ['team_name', 'task_id', 'status', 'reviewer', 'decision_reason'],
};
const TEAM_API_OPERATION_OPTIONAL_FIELDS = {
    'create-task': ['owner', 'blocked_by', 'requires_code_change'],
    'update-task': ['subject', 'description', 'blocked_by', 'requires_code_change'],
    'claim-task': ['expected_version'],
    'read-shutdown-ack': ['min_updated_at'],
    'write-worker-identity': [
        'assigned_tasks', 'pid', 'pane_id', 'working_dir',
        'worktree_path', 'worktree_branch', 'worktree_detached', 'team_state_root',
    ],
    'append-event': ['task_id', 'message_id', 'reason'],
    'write-task-approval': ['required'],
};
const TEAM_API_OPERATION_NOTES = {
    'update-task': 'Only non-lifecycle task metadata can be updated.',
    'release-task-claim': 'Use this only for rollback/requeue to pending (not for completion).',
    'transition-task-status': 'Lifecycle flow is claim-safe and typically transitions in_progress -> completed|failed.',
};
const NUMBERED_LINE_RE = /^\s*\d+[.)]\s+(.+)$/;
const BULLETED_LINE_RE = /^\s*[-*•]\s+(.+)$/;
// Conjunction split: "fix auth AND fix login AND fix logout" or "fix auth, fix login, and fix logout"
const CONJUNCTION_SPLIT_RE = /\s+(?:and|,\s*and|,)\s+/i;
/** Signals that a task is atomic (contains file refs, code symbols, or parallel keywords) */
const PARALLELIZATION_KEYWORDS_RE = /\b(?:parallel|concurrently|simultaneously|at the same time|independently)\b/i;
const FILE_REF_RE = /\b\S+\.\w{1,6}\b/g;
const CODE_SYMBOL_RE = /`[^`]+`/g;
/**
 * Count atomic parallelization signals in a task string.
 * Returns true when the task should NOT be decomposed (it's already atomic or tightly coupled).
 */
export function hasAtomicParallelizationSignals(task, _size) {
    const fileRefs = (task.match(FILE_REF_RE) || []).length;
    const codeSymbols = (task.match(CODE_SYMBOL_RE) || []).length;
    const parallelKw = PARALLELIZATION_KEYWORDS_RE.test(task);
    // Treat as atomic when many specific file/symbol refs present (tightly coupled)
    return fileRefs >= 3 || codeSymbols >= 3 || parallelKw;
}
/**
 * Resolve the effective worker count fanout limit for decomposed tasks.
 * Caps worker count to the number of discovered subtasks when decomposition produces fewer items.
 */
export function resolveTeamFanoutLimit(requestedWorkerCount, _explicitAgentType, _explicitWorkerCount, plan) {
    if (plan.strategy === 'atomic')
        return requestedWorkerCount;
    const subtaskCount = plan.subtasks.length;
    if (subtaskCount > 0 && subtaskCount < requestedWorkerCount) {
        return subtaskCount;
    }
    return requestedWorkerCount;
}
/**
 * Decompose a task string into a structured plan.
 *
 * Detects:
 * - Numbered list: "1. fix auth\n2. fix login"
 * - Bulleted list: "- fix auth\n- fix login"
 * - Conjunction: "fix auth and fix login and fix logout"
 * - Atomic: single task, no decomposition
 */
export function splitTaskString(task) {
    const lines = task.split('\n').map(l => l.trim()).filter(Boolean);
    // Check numbered list
    if (lines.length >= 2 && lines.every(l => NUMBERED_LINE_RE.test(l))) {
        return {
            strategy: 'numbered',
            subtasks: lines.map(l => {
                const m = l.match(NUMBERED_LINE_RE);
                const subject = m[1].trim();
                return { subject: subject.slice(0, 80), description: subject };
            }),
        };
    }
    // Check bulleted list
    if (lines.length >= 2 && lines.every(l => BULLETED_LINE_RE.test(l))) {
        return {
            strategy: 'bulleted',
            subtasks: lines.map(l => {
                const m = l.match(BULLETED_LINE_RE);
                const subject = m[1].trim();
                return { subject: subject.slice(0, 80), description: subject };
            }),
        };
    }
    // Check conjunction split (single line with "and" or commas)
    if (lines.length === 1) {
        const parts = lines[0].split(CONJUNCTION_SPLIT_RE).map(s => s.trim()).filter(Boolean);
        if (parts.length >= 2) {
            return {
                strategy: 'conjunction',
                subtasks: parts.map(p => ({ subject: p.slice(0, 80), description: p })),
            };
        }
    }
    // Atomic: no decomposition
    return {
        strategy: 'atomic',
        subtasks: [{ subject: task.slice(0, 80), description: task }],
    };
}
// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function slugifyTask(task) {
    return task
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '')
        .slice(0, 30) || 'team-task';
}
function getTeamWorkerIdentityFromEnv(env = process.env) {
    const omc = typeof env.OMC_TEAM_WORKER === 'string' ? env.OMC_TEAM_WORKER.trim() : '';
    if (omc)
        return omc;
    const omx = typeof env.OMX_TEAM_WORKER === 'string' ? env.OMX_TEAM_WORKER.trim() : '';
    return omx || null;
}
export async function assertTeamSpawnAllowed(cwd, env = process.env) {
    const workerIdentity = getTeamWorkerIdentityFromEnv(env);
    const { teamReadManifest } = await import('../../team/team-ops.js');
    const { findActiveTeamsV2 } = await import('../../team/runtime-v2.js');
    const { DEFAULT_TEAM_GOVERNANCE, normalizeTeamGovernance } = await import('../../team/governance.js');
    if (workerIdentity) {
        const [parentTeamName] = workerIdentity.split('/');
        const parentManifest = parentTeamName ? await teamReadManifest(parentTeamName, cwd) : null;
        const governance = normalizeTeamGovernance(parentManifest?.governance, parentManifest?.policy);
        if (!governance.nested_teams_allowed) {
            throw new Error(`Worker context (${workerIdentity}) cannot start nested teams because nested_teams_allowed is false.`);
        }
        if (!governance.delegation_only) {
            throw new Error(`Worker context (${workerIdentity}) cannot start nested teams because delegation_only is false.`);
        }
        return;
    }
    const activeTeams = await findActiveTeamsV2(cwd);
    for (const activeTeam of activeTeams) {
        const manifest = await teamReadManifest(activeTeam, cwd);
        const governance = normalizeTeamGovernance(manifest?.governance, manifest?.policy);
        if (governance.one_team_per_leader_session ?? DEFAULT_TEAM_GOVERNANCE.one_team_per_leader_session) {
            throw new Error(`Leader session already owns active team "${activeTeam}" and one_team_per_leader_session is enabled.`);
        }
    }
}
/** Regex for a single worker spec segment: N[:type[:role]] */
const SINGLE_SPEC_RE = /^(\d+)(?::([a-z][a-z0-9-]*)(?::([a-z][a-z0-9-]*))?)?$/i;
function normalizeWorkerSpecSegment(match) {
    const count = Number.parseInt(match[1], 10);
    if (!Number.isFinite(count) || count < MIN_WORKER_COUNT || count > MAX_WORKER_COUNT) {
        throw new Error(`Invalid worker count "${match[1]}". Expected ${MIN_WORKER_COUNT}-${MAX_WORKER_COUNT}.`);
    }
    const token = match[2]?.toLowerCase();
    const explicitRole = match[3]?.toLowerCase();
    if (!token) {
        return { count, agentType: 'claude' };
    }
    if (explicitRole) {
        return { count, agentType: token, role: explicitRole };
    }
    if (VALID_TEAM_CLI_AGENT_TYPES.has(token)) {
        return { count, agentType: token };
    }
    return { count, agentType: 'claude', role: token };
}
/** @internal Exported for testing */
export function parseTeamArgs(tokens, defaultAgentType = 'claude') {
    const args = [...tokens];
    let workerCount = 3;
    let agentTypes = [];
    let workerSpecs = [];
    let json = false;
    let newWindow = false;
    const normalizedDefaultAgentType = VALID_TEAM_CLI_AGENT_TYPES.has(defaultAgentType)
        ? defaultAgentType
        : DEFAULT_TEAM_CLI_AGENT_TYPE;
    // Extract supported flags before parsing positional args
    const filteredArgs = [];
    for (const arg of args) {
        if (arg === '--json') {
            json = true;
        }
        else if (arg === '--new-window') {
            newWindow = true;
        }
        else {
            filteredArgs.push(arg);
        }
    }
    const first = filteredArgs[0] || '';
    // Try comma-separated multi-type spec first (e.g. "1:codex,1:gemini" or "2:claude,1:codex:architect")
    let role;
    let specMatched = false;
    if (first.includes(',')) {
        const segments = first.split(',');
        const parsedSegments = [];
        let allValid = true;
        for (const seg of segments) {
            const m = seg.match(SINGLE_SPEC_RE);
            if (!m) {
                allValid = false;
                break;
            }
            parsedSegments.push(normalizeWorkerSpecSegment(m));
        }
        if (allValid && parsedSegments.length > 0) {
            workerCount = 0;
            for (const seg of parsedSegments) {
                workerCount += seg.count;
                for (let i = 0; i < seg.count; i++) {
                    agentTypes.push(seg.agentType);
                    workerSpecs.push({ agentType: seg.agentType, ...(seg.role ? { role: seg.role } : {}) });
                }
            }
            if (workerCount > MAX_WORKER_COUNT) {
                throw new Error(`Total worker count ${workerCount} exceeds maximum ${MAX_WORKER_COUNT}.`);
            }
            // If every segment specifies the same role, use it; otherwise leave undefined
            const roles = parsedSegments.map(s => s.role);
            const uniqueRoles = [...new Set(roles)];
            if (uniqueRoles.length === 1 && uniqueRoles[0])
                role = uniqueRoles[0];
            specMatched = true;
            filteredArgs.shift();
        }
    }
    // Fall back to single spec (e.g. "3:codex" or "2:codex:architect")
    if (!specMatched) {
        const match = first.match(SINGLE_SPEC_RE);
        if (match) {
            const normalized = normalizeWorkerSpecSegment(match);
            workerCount = normalized.count;
            role = normalized.role;
            agentTypes = Array.from({ length: workerCount }, () => normalized.agentType);
            workerSpecs = Array.from({ length: workerCount }, () => ({
                agentType: normalized.agentType,
                ...(role ? { role } : {}),
            }));
            filteredArgs.shift();
        }
    }
    // Default: 3 workers with configured default agent type (falls back to claude)
    if (agentTypes.length === 0) {
        agentTypes = Array.from({ length: workerCount }, () => normalizedDefaultAgentType);
        workerSpecs = Array.from({ length: workerCount }, () => ({ agentType: normalizedDefaultAgentType }));
    }
    const task = filteredArgs.join(' ').trim();
    if (!task) {
        throw new Error('Usage: omc team [N:agent-type] "<task description>"');
    }
    const teamName = slugifyTask(task);
    return { workerCount, agentTypes, workerSpecs, role, task, teamName, json, newWindow };
}
export function buildStartupTasks(parsed) {
    return Array.from({ length: parsed.workerCount }, (_, index) => {
        const workerSpec = parsed.workerSpecs[index];
        const roleLabel = workerSpec?.role ? ` (${workerSpec.role})` : '';
        return {
            subject: parsed.workerCount === 1
                ? parsed.task.slice(0, 80)
                : `Worker ${index + 1}${roleLabel}: ${parsed.task}`.slice(0, 80),
            description: parsed.task,
            ...(workerSpec?.role ? { owner: `worker-${index + 1}` } : {}),
        };
    });
}
function sampleValueForField(field) {
    switch (field) {
        case 'team_name': return 'my-team';
        case 'from_worker': return 'worker-1';
        case 'to_worker': return 'leader-fixed';
        case 'worker': return 'worker-1';
        case 'body': return 'ACK';
        case 'subject': return 'Demo task';
        case 'description': return 'Created through CLI interop';
        case 'task_id': return '1';
        case 'message_id': return 'msg-123';
        case 'from': return 'in_progress';
        case 'to': return 'completed';
        case 'claim_token': return 'claim-token';
        case 'expected_version': return 1;
        case 'pid': return 12345;
        case 'turn_count': return 12;
        case 'alive': return true;
        case 'content': return '# Inbox update\nProceed with task 2.';
        case 'index': return 1;
        case 'role': return 'executor';
        case 'assigned_tasks': return ['1', '2'];
        case 'type': return 'task_completed';
        case 'requested_by': return 'leader-fixed';
        case 'min_updated_at': return '2026-03-04T00:00:00.000Z';
        case 'snapshot':
            return {
                taskStatusById: { '1': 'completed' },
                workerAliveByName: { 'worker-1': true },
                workerStateByName: { 'worker-1': 'idle' },
                workerTurnCountByName: { 'worker-1': 12 },
                workerTaskIdByName: { 'worker-1': '1' },
                mailboxNotifiedByMessageId: {},
                completedEventTaskIds: { '1': true },
            };
        case 'status': return 'approved';
        case 'reviewer': return 'leader-fixed';
        case 'decision_reason': return 'approved in demo';
        case 'required': return true;
        default: return `<${field}>`;
    }
}
function buildOperationHelp(operation) {
    const requiredFields = TEAM_API_OPERATION_REQUIRED_FIELDS[operation] ?? [];
    const optionalFields = TEAM_API_OPERATION_OPTIONAL_FIELDS[operation] ?? [];
    const sampleInput = {};
    for (const field of requiredFields) {
        sampleInput[field] = sampleValueForField(field);
    }
    const sampleInputJson = JSON.stringify(sampleInput);
    const required = requiredFields.length > 0
        ? requiredFields.map((field) => `  - ${field}`).join('\n')
        : '  (none)';
    const optional = optionalFields.length > 0
        ? `\nOptional input fields:\n${optionalFields.map((field) => `  - ${field}`).join('\n')}\n`
        : '\n';
    const note = TEAM_API_OPERATION_NOTES[operation]
        ? `\nNote:\n  ${TEAM_API_OPERATION_NOTES[operation]}\n`
        : '';
    return `
Usage: omc team api ${operation} --input <json> [--json]

Required input fields:
${required}${optional}${note}Example:
  omc team api ${operation} --input '${sampleInputJson}' --json
`.trim();
}
function parseTeamApiArgs(args) {
    const operation = resolveTeamApiOperation(args[0] || '');
    if (!operation) {
        throw new Error(`Usage: omc team api <operation> [--input <json>] [--json]\nSupported operations: ${TEAM_API_OPERATIONS.join(', ')}`);
    }
    let input = {};
    let json = false;
    for (let i = 1; i < args.length; i += 1) {
        const token = args[i];
        if (token === '--json') {
            json = true;
            continue;
        }
        if (token === '--input') {
            const next = args[i + 1];
            if (!next)
                throw new Error('Missing value after --input');
            try {
                const parsed = JSON.parse(next);
                if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
                    throw new Error('input must be a JSON object');
                }
                input = parsed;
            }
            catch (error) {
                throw new Error(`Invalid --input JSON: ${error instanceof Error ? error.message : String(error)}`);
            }
            i += 1;
            continue;
        }
        if (token.startsWith('--input=')) {
            const raw = token.slice('--input='.length);
            try {
                const parsed = JSON.parse(raw);
                if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
                    throw new Error('input must be a JSON object');
                }
                input = parsed;
            }
            catch (error) {
                throw new Error(`Invalid --input JSON: ${error instanceof Error ? error.message : String(error)}`);
            }
            continue;
        }
        throw new Error(`Unknown argument for "omc team api": ${token}`);
    }
    return { operation, input, json };
}
// ---------------------------------------------------------------------------
// Team start (spawns tmux workers)
// ---------------------------------------------------------------------------
async function handleTeamStart(parsed, cwd) {
    await assertTeamSpawnAllowed(cwd);
    // Decompose the task string into subtasks when possible
    const decomposition = splitTaskString(parsed.task);
    const effectiveWorkerCount = resolveTeamFanoutLimit(parsed.workerCount, parsed.agentTypes[0], parsed.workerCount, decomposition);
    // Build the task list from decomposition subtasks or fall back to atomic replication
    const tasks = [];
    if (decomposition.strategy !== 'atomic' && decomposition.subtasks.length > 1) {
        // Use decomposed subtasks — one per subtask (up to effectiveWorkerCount)
        const subtasks = decomposition.subtasks.slice(0, effectiveWorkerCount);
        for (let i = 0; i < subtasks.length; i++) {
            tasks.push({
                subject: subtasks[i].subject,
                description: subtasks[i].description,
                owner: `worker-${i + 1}`,
            });
        }
    }
    else {
        // Atomic task: replicate across all workers (backward compatible)
        for (let i = 0; i < effectiveWorkerCount; i++) {
            tasks.push({
                subject: effectiveWorkerCount === 1
                    ? parsed.task.slice(0, 80)
                    : `Worker ${i + 1}: ${parsed.task}`.slice(0, 80),
                description: parsed.task,
                owner: `worker-${i + 1}`,
            });
        }
    }
    // Load role prompt if a role was specified (e.g., 3:codex:architect)
    let rolePrompt;
    if (parsed.role) {
        const { loadAgentPrompt } = await import('../../agents/utils.js');
        rolePrompt = loadAgentPrompt(parsed.role);
    }
    // Use v2 runtime by default (OMC_RUNTIME_V2 opt-out), otherwise fall back to v1
    const { isRuntimeV2Enabled } = await import('../../team/runtime-v2.js');
    if (isRuntimeV2Enabled()) {
        const { startTeamV2, monitorTeamV2 } = await import('../../team/runtime-v2.js');
        const runtime = await startTeamV2({
            teamName: parsed.teamName,
            workerCount: effectiveWorkerCount,
            agentTypes: parsed.agentTypes.slice(0, effectiveWorkerCount),
            tasks,
            cwd,
            newWindow: parsed.newWindow,
            workerRoles: parsed.workerSpecs.map((spec) => spec.role ?? spec.agentType),
            ...(rolePrompt ? { roleName: parsed.role, rolePrompt } : {}),
        });
        const uniqueTypes = [...new Set(parsed.agentTypes)].join(',');
        if (parsed.json) {
            const snapshot = await monitorTeamV2(runtime.teamName, cwd);
            console.log(JSON.stringify({
                teamName: runtime.teamName,
                sessionName: runtime.sessionName,
                workerCount: runtime.config.worker_count,
                agentType: uniqueTypes,
                tasks: snapshot ? snapshot.tasks : null,
            }));
            return;
        }
        console.log(`Team started: ${runtime.teamName}`);
        console.log(`tmux session: ${runtime.sessionName}`);
        console.log(`workers: ${runtime.config.worker_count}`);
        console.log(`agent_type: ${uniqueTypes}`);
        const snapshot = await monitorTeamV2(runtime.teamName, cwd);
        if (snapshot) {
            console.log(`tasks: total=${snapshot.tasks.total} pending=${snapshot.tasks.pending} in_progress=${snapshot.tasks.in_progress} completed=${snapshot.tasks.completed} failed=${snapshot.tasks.failed}`);
        }
        return;
    }
    // v1 fallback
    const { startTeam, monitorTeam } = await import('../../team/runtime.js');
    const runtime = await startTeam({
        teamName: parsed.teamName,
        workerCount: effectiveWorkerCount,
        agentTypes: parsed.agentTypes.slice(0, effectiveWorkerCount),
        tasks,
        cwd,
        newWindow: parsed.newWindow,
    });
    const uniqueTypesV1 = [...new Set(parsed.agentTypes)].join(',');
    if (parsed.json) {
        const snapshot = await monitorTeam(runtime.teamName, cwd, runtime.workerPaneIds);
        console.log(JSON.stringify({
            teamName: runtime.teamName,
            sessionName: runtime.sessionName,
            workerCount: runtime.workerNames.length,
            agentType: uniqueTypesV1,
            tasks: snapshot ? {
                total: snapshot.taskCounts.pending + snapshot.taskCounts.inProgress + snapshot.taskCounts.completed + snapshot.taskCounts.failed,
                pending: snapshot.taskCounts.pending,
                in_progress: snapshot.taskCounts.inProgress,
                completed: snapshot.taskCounts.completed,
                failed: snapshot.taskCounts.failed,
            } : null,
        }));
        return;
    }
    console.log(`Team started: ${runtime.teamName}`);
    console.log(`tmux session: ${runtime.sessionName}`);
    console.log(`workers: ${runtime.workerNames.length}`);
    console.log(`agent_type: ${uniqueTypesV1}`);
    const snapshot = await monitorTeam(runtime.teamName, cwd, runtime.workerPaneIds);
    if (snapshot) {
        console.log(`tasks: total=${snapshot.taskCounts.pending + snapshot.taskCounts.inProgress + snapshot.taskCounts.completed + snapshot.taskCounts.failed} pending=${snapshot.taskCounts.pending} in_progress=${snapshot.taskCounts.inProgress} completed=${snapshot.taskCounts.completed} failed=${snapshot.taskCounts.failed}`);
    }
}
// ---------------------------------------------------------------------------
// Team status
// ---------------------------------------------------------------------------
async function handleTeamStatus(teamName, cwd) {
    const { isRuntimeV2Enabled } = await import('../../team/runtime-v2.js');
    if (isRuntimeV2Enabled()) {
        const { monitorTeamV2 } = await import('../../team/runtime-v2.js');
        const { deriveTeamLeaderGuidance } = await import('../../team/leader-nudge-guidance.js');
        const { readTeamEventsByType } = await import('../../team/events.js');
        const snapshot = await monitorTeamV2(teamName, cwd);
        if (!snapshot) {
            console.log(`No team state found for ${teamName}`);
            return;
        }
        const leaderGuidance = deriveTeamLeaderGuidance({
            tasks: {
                pending: snapshot.tasks.pending,
                blocked: snapshot.tasks.blocked,
                inProgress: snapshot.tasks.in_progress,
                completed: snapshot.tasks.completed,
                failed: snapshot.tasks.failed,
            },
            workers: {
                total: snapshot.workers.length,
                alive: snapshot.workers.filter((worker) => worker.alive).length,
                idle: snapshot.workers.filter((worker) => worker.alive && (worker.status.state === 'idle' || worker.status.state === 'done')).length,
                nonReporting: snapshot.nonReportingWorkers.length,
            },
        });
        const latestLeaderNudge = (await readTeamEventsByType(teamName, 'team_leader_nudge', cwd)).at(-1);
        console.log(`team=${snapshot.teamName} phase=${snapshot.phase}`);
        console.log(`workers: total=${snapshot.workers.length}`);
        console.log(`tasks: total=${snapshot.tasks.total} pending=${snapshot.tasks.pending} blocked=${snapshot.tasks.blocked} in_progress=${snapshot.tasks.in_progress} completed=${snapshot.tasks.completed} failed=${snapshot.tasks.failed}`);
        console.log(`leader_next_action=${leaderGuidance.nextAction}`);
        console.log(`leader_guidance=${leaderGuidance.message}`);
        if (latestLeaderNudge) {
            console.log(`latest_leader_nudge action=${latestLeaderNudge.next_action ?? 'unknown'} at=${latestLeaderNudge.created_at} reason=${latestLeaderNudge.reason ?? 'n/a'}`);
        }
        return;
    }
    // v1 fallback
    const { monitorTeam } = await import('../../team/runtime.js');
    const snapshot = await monitorTeam(teamName, cwd, []);
    if (!snapshot) {
        console.log(`No team state found for ${teamName}`);
        return;
    }
    console.log(`team=${snapshot.teamName} phase=${snapshot.phase}`);
    console.log(`tasks: pending=${snapshot.taskCounts.pending} in_progress=${snapshot.taskCounts.inProgress} completed=${snapshot.taskCounts.completed} failed=${snapshot.taskCounts.failed}`);
}
// ---------------------------------------------------------------------------
// Team shutdown
// ---------------------------------------------------------------------------
async function handleTeamShutdown(teamName, cwd, force) {
    const { isRuntimeV2Enabled } = await import('../../team/runtime-v2.js');
    if (isRuntimeV2Enabled()) {
        const { shutdownTeamV2 } = await import('../../team/runtime-v2.js');
        await shutdownTeamV2(teamName, cwd, { force });
        console.log(`Team shutdown complete: ${teamName}`);
        return;
    }
    // v1 fallback
    const { shutdownTeam } = await import('../../team/runtime.js');
    await shutdownTeam(teamName, `omc-team-${teamName}`, cwd);
    console.log(`Team shutdown complete: ${teamName}`);
}
// ---------------------------------------------------------------------------
// API subcommand handler
// ---------------------------------------------------------------------------
async function handleTeamApi(args, cwd) {
    const apiSubcommand = (args[0] || '').toLowerCase();
    // omc team api --help
    if (HELP_TOKENS.has(apiSubcommand)) {
        const operationFromHelpAlias = resolveTeamApiOperation((args[1] || '').toLowerCase());
        if (operationFromHelpAlias) {
            console.log(buildOperationHelp(operationFromHelpAlias));
            return;
        }
        console.log(TEAM_API_HELP.trim());
        return;
    }
    // omc team api <operation> --help
    const operation = resolveTeamApiOperation(apiSubcommand);
    if (operation) {
        const trailing = args.slice(1).map((token) => token.toLowerCase());
        if (trailing.some((token) => HELP_TOKENS.has(token))) {
            console.log(buildOperationHelp(operation));
            return;
        }
    }
    const wantsJson = args.includes('--json');
    const jsonBase = {
        schema_version: '1.0',
        timestamp: new Date().toISOString(),
    };
    let parsedApi;
    try {
        parsedApi = parseTeamApiArgs(args);
    }
    catch (error) {
        if (wantsJson) {
            console.log(JSON.stringify({
                ...jsonBase,
                ok: false,
                command: 'omc team api',
                operation: 'unknown',
                error: {
                    code: 'invalid_input',
                    message: error instanceof Error ? error.message : String(error),
                },
            }));
            process.exitCode = 1;
            return;
        }
        throw error;
    }
    const envelope = await executeTeamApiOperation(parsedApi.operation, parsedApi.input, cwd);
    if (parsedApi.json) {
        console.log(JSON.stringify({
            ...jsonBase,
            command: `omc team api ${parsedApi.operation}`,
            ...envelope,
        }));
        if (!envelope.ok)
            process.exitCode = 1;
        return;
    }
    if (envelope.ok) {
        console.log(`ok operation=${envelope.operation}`);
        console.log(JSON.stringify(envelope.data, null, 2));
        return;
    }
    console.error(`error operation=${envelope.operation} code=${envelope.error.code}: ${envelope.error.message}`);
    process.exitCode = 1;
}
// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------
/**
 * Main team subcommand handler.
 * Routes:
 *   omc team [N:agent-type] "task"          -> Start team
 *   omc team status <team-name>             -> Monitor
 *   omc team shutdown <team-name> [--force] -> Shutdown
 *   omc team api <operation> [--input] ...  -> Worker CLI API
 */
export async function teamCommand(args) {
    const cwd = process.cwd();
    const [subcommandRaw] = args;
    const subcommand = (subcommandRaw || '').toLowerCase();
    if (HELP_TOKENS.has(subcommand) || !subcommand) {
        console.log(TEAM_HELP.trim());
        return;
    }
    // omc team api <operation> ...
    if (subcommand === 'api') {
        await handleTeamApi(args.slice(1), cwd);
        return;
    }
    // omc team status <team-name>
    if (subcommand === 'status') {
        const name = args[1];
        if (!name)
            throw new Error('Usage: omc team status <team-name>');
        await handleTeamStatus(name, cwd);
        return;
    }
    // omc team shutdown <team-name> [--force]
    if (subcommand === 'shutdown') {
        const nameOrFlag = args.filter(a => !a.startsWith('--'));
        const name = nameOrFlag[1]; // skip 'shutdown' itself
        if (!name)
            throw new Error('Usage: omc team shutdown <team-name> [--force]');
        const force = args.includes('--force');
        await handleTeamShutdown(name, cwd, force);
        return;
    }
    // Default: omc team [N:agent-type] "task" -> Start team
    try {
        // Honor team.ops.defaultAgentType when user hasn't supplied N:agent-type.
        const cfg = loadConfig();
        const defaultAgentType = cfg.team?.ops?.defaultAgentType ?? DEFAULT_TEAM_CLI_AGENT_TYPE;
        const parsed = parseTeamArgs(args, defaultAgentType);
        await handleTeamStart(parsed, cwd);
    }
    catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        console.log(TEAM_HELP.trim());
        process.exitCode = 1;
    }
}
//# sourceMappingURL=team.js.map