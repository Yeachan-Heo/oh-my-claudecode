#!/usr/bin/env node
/**
 * Team MCP Server - tmux CLI worker runtime tools
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema, } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { spawn } from 'child_process';
import { join, resolve } from 'path';
import { fileURLToPath } from 'url';
const __ownDir = (() => {
    // CJS bundle: __dirname is reliable and takes precedence
    if (typeof __dirname !== 'undefined' && __dirname)
        return __dirname;
    // ESM: derive from import.meta.url
    try {
        return fileURLToPath(new URL('.', import.meta.url));
    }
    catch {
        return process.cwd();
    }
})();
import { writeFileSync, readFileSync, mkdirSync, existsSync, renameSync, unlinkSync, } from 'fs';
import { readFile } from 'fs/promises';
import { validateTeamName } from '../team/team-name.js';
import { isRuntimeV2Enabled, shutdownTeamV2 } from '../team/runtime-v2.js';
import { withProcessIdentityFileLockSync } from '../team/process-identity-lock.js';
import { NudgeTracker } from '../team/idle-nudge.js';
import { convergeJobWithResultArtifact, isValidOmcTeamJob, isValidTeamPaneArtifact, isJobTerminal, readMatchingTerminalArtifact, resultArtifactIdentityError, } from './team-job-convergence.js';
import { isProcessAlive } from '../platform/index.js';
import { isValidTeamInstanceId, isValidTmuxServerIdentity } from '../team/types.js';
import { sendToWorker } from '../team/tmux-session.js';
import { readTeamConfig } from '../team/monitor.js';
import { assertTeamInstanceUnderLock, createTeamInstanceBinding, withTeamInstanceLifecycleLock, } from '../team/team-instance.js';
import { canonicalTeamCwd } from '../team/state-paths.js';
import { getGlobalOmcStatePath } from '../utils/paths.js';
const OMC_JOBS_DIR = process.env.OMC_JOBS_DIR || getGlobalOmcStatePath('team-jobs');
const DEPRECATION_CODE = 'deprecated_cli_only';
const TEAM_CLI_REPLACEMENT_HINTS = {
    omc_run_team_start: 'omc team start',
    omc_run_team_status: 'omc team status <job_id>',
    omc_run_team_wait: 'omc team wait <job_id>',
    omc_run_team_cleanup: 'omc team cleanup <job_id>',
};
function isDeprecatedTeamToolName(name) {
    return Object.prototype.hasOwnProperty.call(TEAM_CLI_REPLACEMENT_HINTS, name);
}
export function createDeprecatedCliOnlyEnvelope(toolName) {
    return createDeprecatedCliOnlyEnvelopeWithArgs(toolName);
}
function quoteCliValue(value) {
    return JSON.stringify(value);
}
function buildCliReplacement(toolName, args) {
    const hasArgsObject = typeof args === 'object' && args !== null;
    if (!hasArgsObject) {
        return TEAM_CLI_REPLACEMENT_HINTS[toolName];
    }
    const parsed = (typeof args === 'object' && args !== null) ? args : {};
    if (toolName === 'omc_run_team_start') {
        const teamName = typeof parsed.teamName === 'string' ? parsed.teamName.trim() : '';
        const cwd = typeof parsed.cwd === 'string' ? parsed.cwd.trim() : '';
        const newWindow = parsed.newWindow === true;
        const agentTypes = Array.isArray(parsed.agentTypes)
            ? parsed.agentTypes.filter((item) => typeof item === 'string' && item.trim().length > 0)
            : [];
        const tasks = Array.isArray(parsed.tasks)
            ? parsed.tasks
                .map((task) => (typeof task === 'object' && task !== null && typeof task.description === 'string')
                ? task.description.trim()
                : '')
                .filter(Boolean)
            : [];
        const flags = ['omc', 'team', 'start'];
        if (teamName)
            flags.push('--name', quoteCliValue(teamName));
        if (cwd)
            flags.push('--cwd', quoteCliValue(cwd));
        if (newWindow)
            flags.push('--new-window');
        if (agentTypes.length > 0) {
            const uniqueAgentTypes = new Set(agentTypes);
            if (uniqueAgentTypes.size === 1) {
                flags.push('--agent', quoteCliValue(agentTypes[0]), '--count', String(agentTypes.length));
            }
            else {
                flags.push('--agent', quoteCliValue(agentTypes.join(',')));
            }
        }
        else {
            flags.push('--agent', '"claude"');
        }
        if (tasks.length > 0) {
            for (const task of tasks) {
                flags.push('--task', quoteCliValue(task));
            }
        }
        else {
            flags.push('--task', '"<task>"');
        }
        return flags.join(' ');
    }
    const jobId = typeof parsed.job_id === 'string' ? parsed.job_id.trim() : '<job_id>';
    if (toolName === 'omc_run_team_status') {
        return `omc team status --job-id ${quoteCliValue(jobId)}`;
    }
    if (toolName === 'omc_run_team_wait') {
        const timeoutMs = typeof parsed.timeout_ms === 'number' && Number.isFinite(parsed.timeout_ms)
            ? ` --timeout-ms ${Math.floor(parsed.timeout_ms)}`
            : '';
        return `omc team wait --job-id ${quoteCliValue(jobId)}${timeoutMs}`;
    }
    if (toolName === 'omc_run_team_cleanup') {
        const graceMs = typeof parsed.grace_ms === 'number' && Number.isFinite(parsed.grace_ms)
            ? ` --grace-ms ${Math.floor(parsed.grace_ms)}`
            : '';
        return `omc team cleanup --job-id ${quoteCliValue(jobId)}${graceMs}`;
    }
    return TEAM_CLI_REPLACEMENT_HINTS[toolName];
}
export function createDeprecatedCliOnlyEnvelopeWithArgs(toolName, args) {
    const cliReplacement = buildCliReplacement(toolName, args);
    return {
        content: [{
                type: 'text',
                text: JSON.stringify({
                    code: DEPRECATION_CODE,
                    tool: toolName,
                    message: 'Legacy team MCP runtime tools are deprecated. Use the omc team CLI instead.',
                    cli_replacement: cliReplacement,
                }),
            }],
        isError: true,
    };
}
function persistJob(jobId, job) {
    try {
        withProcessIdentityFileLockSync(jobLockPath(jobId), () => persistJobUnlocked(jobId, job));
    }
    catch (error) {
        throw new Error(`team_job_persist_failed:${error instanceof Error ? error.message : String(error)}`);
    }
}
function loadJobFromDisk(jobId) {
    const path = join(OMC_JOBS_DIR, `${jobId}.json`);
    let content;
    try {
        content = readFileSync(path, 'utf-8');
    }
    catch (error) {
        if (error.code === 'ENOENT')
            return undefined;
        throw new Error(`Unreadable job file: ${jobId} (${error instanceof Error ? error.message : String(error)})`);
    }
    let parsed;
    try {
        parsed = JSON.parse(content);
    }
    catch {
        throw new Error(`Corrupt job file: ${jobId} (invalid JSON)`);
    }
    if (!isValidOmcTeamJob(parsed)) {
        throw new Error(`Corrupt job file: ${jobId} (invalid schema)`);
    }
    return parsed;
}
function getJob(jobId) {
    return loadJobFromDisk(jobId);
}
async function loadPaneIds(jobId, instanceId) {
    const p = join(OMC_JOBS_DIR, `${jobId}-panes.json`);
    try {
        const parsed = JSON.parse(await readFile(p, 'utf-8'));
        if (!isValidTeamPaneArtifact(parsed, instanceId))
            return null;
        return parsed;
    }
    catch {
        return null;
    }
}
function sameNudgeJobIdentity(job, expected) {
    if (!job.cwd)
        return false;
    return job.instanceId === expected.instanceId
        && job.teamName === expected.teamName
        && canonicalTeamCwd(job.cwd) === canonicalTeamCwd(expected.cwd)
        && job.status === 'running'
        && job.cleanedUpAt === undefined;
}
function readLockedNudgeJob(jobId, expected) {
    try {
        return withProcessIdentityFileLockSync(jobLockPath(jobId), () => {
            const current = loadJobFromDisk(jobId);
            return current && sameNudgeJobIdentity(current, expected) ? current : null;
        });
    }
    catch {
        return null;
    }
}
function stablePaneArtifact(artifact) {
    return JSON.stringify({
        instanceId: artifact.instanceId,
        paneIds: [...artifact.paneIds].sort(),
        leaderPaneId: artifact.leaderPaneId,
        sessionName: artifact.sessionName,
        ownsWindow: artifact.ownsWindow,
        workers: [...artifact.workers]
            .sort((left, right) => left.workerName.localeCompare(right.workerName))
            .map(worker => ({
            workerName: worker.workerName,
            paneId: worker.paneId,
            launchAttemptId: worker.launchAttemptId,
        })),
    });
}
function samePaneArtifact(left, right) {
    return stablePaneArtifact(left) === stablePaneArtifact(right);
}
function sameNudgeAuthority(left, right) {
    if (left.instanceId !== right.instanceId
        || left.sessionName !== right.sessionName
        || left.provider !== right.provider)
        return false;
    const leftIdentity = left.tmuxServerIdentity;
    const rightIdentity = right.tmuxServerIdentity;
    if (leftIdentity === undefined || rightIdentity === undefined) {
        return leftIdentity === rightIdentity;
    }
    return leftIdentity.socket_path === rightIdentity.socket_path
        && leftIdentity.server_pid === rightIdentity.server_pid
        && leftIdentity.process_started_at === rightIdentity.process_started_at;
}
function sameTmuxIdentity(left, right) {
    if (left === undefined || right === undefined)
        return left === right;
    return left.socket_path === right.socket_path
        && left.server_pid === right.server_pid
        && left.process_started_at === right.process_started_at;
}
/**
 * Resolve nudge authority only from the original locked job, its matching
 * config/reservation, and the validated pane artifact. This deliberately
 * avoids discovering a replacement same-name team after an async boundary.
 */
async function resolveNudgeAuthorityUnderLock(jobId, expected, panes) {
    if (!isValidTeamInstanceId(expected.instanceId))
        return null;
    if (!readLockedNudgeJob(jobId, expected))
        return null;
    const currentPanes = await loadPaneIds(jobId, expected.instanceId);
    if (!currentPanes || !samePaneArtifact(currentPanes, panes))
        return null;
    const binding = createTeamInstanceBinding({
        teamName: expected.teamName,
        cwd: expected.cwd,
        instanceId: expected.instanceId,
    });
    const assertion = await assertTeamInstanceUnderLock(binding);
    if (assertion.reservation.phase !== 'active' || assertion.observed_state !== 'bound')
        return null;
    const config = await readTeamConfig(expected.teamName, expected.cwd);
    if (!config || config.name !== expected.teamName || config.instance_id !== expected.instanceId)
        return null;
    if (config.leader_cwd !== undefined && canonicalTeamCwd(config.leader_cwd) !== canonicalTeamCwd(expected.cwd))
        return null;
    const leaderPaneId = config.leader_pane_id;
    if (typeof leaderPaneId !== 'string' || leaderPaneId !== panes.leaderPaneId)
        return null;
    if (!Array.isArray(config.workers))
        return null;
    if (panes.sessionName !== undefined && panes.sessionName !== config.tmux_session)
        return null;
    if (typeof config.tmux_session !== 'string' || config.tmux_session.trim() !== config.tmux_session
        || config.tmux_session.length === 0)
        return null;
    const provider = config.tmux_session.startsWith('cmux:') ? 'cmux' : 'tmux';
    let tmuxServerIdentity;
    if (provider === 'tmux') {
        if (!isValidTmuxServerIdentity(config.tmux_server_identity))
            return null;
        tmuxServerIdentity = config.tmux_server_identity;
    }
    else if (config.tmux_server_identity !== undefined) {
        return null;
    }
    const ownershipByPane = new Map();
    const artifactWorkerNames = new Set();
    for (const pane of panes.workers) {
        const worker = config.workers.find(candidate => candidate.name === pane.workerName);
        if (!worker || worker.pane_id !== pane.paneId || worker.launch_attempt_id !== pane.launchAttemptId)
            return null;
        if (artifactWorkerNames.has(pane.workerName))
            return null;
        artifactWorkerNames.add(pane.workerName);
        ownershipByPane.set(pane.paneId, {
            provider,
            providerTarget: config.tmux_session,
            paneId: pane.paneId,
            splitTarget: leaderPaneId,
            leaderPaneId,
            reservedPaneIds: panes.paneIds.filter(candidate => candidate !== pane.paneId),
            source: 'adopted',
            ...(tmuxServerIdentity ? { tmuxServerIdentity } : {}),
        });
    }
    const configuredWorkers = config.workers.filter(worker => worker.pane_id !== undefined);
    if (configuredWorkers.length !== panes.workers.length
        || configuredWorkers.some(worker => !artifactWorkerNames.has(worker.name))) {
        return null;
    }
    return {
        instanceId: expected.instanceId,
        sessionName: config.tmux_session,
        provider,
        ...(tmuxServerIdentity ? { tmuxServerIdentity } : {}),
        getPaneOwnership: (paneId) => ownershipByPane.get(paneId),
        // The live caller replaces this placeholder with the lifecycle-locked
        // final validation + transport operation.
        executeNudge: async () => false,
    };
}
async function loadNudgeAuthority(jobId, expected, panes) {
    try {
        const binding = createTeamInstanceBinding({
            teamName: expected.teamName,
            cwd: expected.cwd,
            instanceId: expected.instanceId,
        });
        return await withTeamInstanceLifecycleLock(binding.cwd, binding.team_name, () => resolveNudgeAuthorityUnderLock(jobId, expected, panes));
    }
    catch {
        return null;
    }
}
async function executeLockedNudge(jobId, expected, expectedPanes, authority, paneId, message) {
    try {
        const binding = createTeamInstanceBinding({
            teamName: expected.teamName,
            cwd: expected.cwd,
            instanceId: expected.instanceId,
        });
        return await withTeamInstanceLifecycleLock(binding.cwd, binding.team_name, async () => {
            const current = await resolveNudgeAuthorityUnderLock(jobId, expected, expectedPanes);
            if (!current || !sameNudgeAuthority(current, authority))
                return false;
            const ownership = current.getPaneOwnership(paneId);
            if (!ownership)
                return false;
            // Config, reservation, and pane evidence above all cross async
            // boundaries. Re-read the original durable job synchronously under its
            // own lock immediately before input so terminalization, removal, or a
            // same-job replacement cannot turn stale authority into delivery.
            if (!readLockedNudgeJob(jobId, expected))
                return false;
            const sent = current.provider === 'tmux'
                ? await sendToWorker(current.sessionName, paneId, message, current.tmuxServerIdentity)
                : await sendToWorker(current.sessionName, paneId, message);
            if (!sent)
                return false;
            // The lifecycle lock remains held while confirming that the original
            // job/config/artifact still own this exact target after transport.
            const after = await resolveNudgeAuthorityUnderLock(jobId, expected, expectedPanes);
            if (!after || !sameNudgeAuthority(after, authority))
                return false;
            const afterOwnership = after.getPaneOwnership(paneId);
            return afterOwnership !== undefined
                && afterOwnership.providerTarget === ownership.providerTarget
                && sameTmuxIdentity(afterOwnership.tmuxServerIdentity, ownership.tmuxServerIdentity);
        });
    }
    catch {
        return false;
    }
}
function validateJobId(job_id) {
    if (!/^omc-[a-z0-9]{1,16}$/.test(job_id)) {
        throw new Error(`Invalid job_id: "${job_id}". Must match /^omc-[a-z0-9]{1,16}$/`);
    }
}
function jobLockPath(jobId) {
    return join(OMC_JOBS_DIR, `.${jobId}.lock`);
}
function persistJobUnlocked(jobId, job) {
    if (!existsSync(OMC_JOBS_DIR))
        mkdirSync(OMC_JOBS_DIR, { recursive: true });
    const targetPath = join(OMC_JOBS_DIR, `${jobId}.json`);
    const tempPath = `${targetPath}.tmp.${process.pid}.${randomUUID()}`;
    try {
        writeFileSync(tempPath, JSON.stringify(job), { encoding: 'utf-8', mode: 0o600 });
        renameSync(tempPath, targetPath);
    }
    finally {
        try {
            unlinkSync(tempPath);
        }
        catch { /* renamed or never created */ }
    }
}
function updateJobFailureIfRunning(jobId, expectedInstanceId, reason, result) {
    withProcessIdentityFileLockSync(jobLockPath(jobId), () => {
        const current = loadJobFromDisk(jobId);
        if (!current
            || current.instanceId !== expectedInstanceId
            || current.cleanedUpAt
            || current.status !== 'running')
            return;
        persistJobUnlocked(jobId, {
            ...current,
            status: 'failed',
            stderr: current.stderr ?? reason,
            ...(result !== undefined ? { result: current.result ?? result } : {}),
        });
    });
}
function readConvergedJob(jobId) {
    return withProcessIdentityFileLockSync(jobLockPath(jobId), () => {
        const current = loadJobFromDisk(jobId);
        if (!current)
            return undefined;
        const convergence = convergeJobWithResultArtifact(current, jobId, OMC_JOBS_DIR);
        let job = convergence.job;
        if (!job.cleanedUpAt && job.status === 'running' && job.pid != null && !isProcessAlive(job.pid)) {
            const reason = 'Process no longer alive (MCP restart?)';
            job = {
                ...job,
                status: 'failed',
                stderr: job.stderr ?? reason,
                result: job.result ?? JSON.stringify({ error: reason }),
            };
        }
        if (convergence.changed || job !== convergence.job) {
            // Status/wait convergence recomputes from the current identity-validated
            // record under the lock. Terminal freezing is reserved for child close.
            persistJobUnlocked(jobId, job);
        }
        return job;
    });
}
function mergeCleanupFields(jobId, expectedInstanceId, initial, fields) {
    try {
        return withProcessIdentityFileLockSync(jobLockPath(jobId), () => {
            const current = loadJobFromDisk(jobId);
            if (!current)
                return { kind: 'blocked', reason: 'cleanup_job_missing' };
            if (current.instanceId !== expectedInstanceId) {
                return {
                    kind: 'blocked',
                    reason: `cleanup_instance_mismatch:expected=${expectedInstanceId}:actual=${current.instanceId}`,
                };
            }
            if (current.cleanedUpAt)
                return { kind: 'already_cleaned', job: current };
            if (current.cleanupBlockedAt !== initial.cleanupBlockedAt
                || current.cleanupBlockedReason !== initial.cleanupBlockedReason
                || current.cleanedUpAt !== initial.cleanedUpAt) {
                return {
                    kind: 'superseded',
                    reason: current.cleanupBlockedReason ?? 'cleanup_state_changed',
                };
            }
            const next = { ...current };
            if (fields.cleanedUpAt !== undefined)
                next.cleanedUpAt = fields.cleanedUpAt;
            if (fields.cleanupBlockedAt !== undefined)
                next.cleanupBlockedAt = fields.cleanupBlockedAt;
            if (fields.cleanupBlockedReason !== undefined)
                next.cleanupBlockedReason = fields.cleanupBlockedReason;
            if (fields.clearBlocked) {
                delete next.cleanupBlockedAt;
                delete next.cleanupBlockedReason;
            }
            persistJobUnlocked(jobId, next);
            return { kind: 'updated', job: next };
        });
    }
    catch (error) {
        return {
            kind: 'blocked',
            reason: `cleanup_job_lock_failed:${error instanceof Error ? error.message : String(error)}`,
        };
    }
}
function makeJobResponse(jobId, job, nudges) {
    const elapsed = ((Date.now() - job.startedAt) / 1000).toFixed(1);
    const out = {
        jobId,
        instanceId: job.instanceId,
        status: job.status,
        elapsedSeconds: elapsed,
    };
    if (job.result) {
        try {
            out.result = JSON.parse(job.result);
        }
        catch {
            out.result = job.result;
        }
    }
    if (job.stderr)
        out.stderr = job.stderr;
    if (nudges)
        out.nudges = nudges;
    return { content: [{ type: 'text', text: JSON.stringify(out) }] };
}
const startSchema = z.object({
    teamName: z.string().describe('Slug name for the team (e.g. "auth-review")'),
    agentTypes: z.array(z.string()).describe('Agent type per worker: "claude", "codex", "gemini", or "antigravity"'),
    tasks: z.array(z.object({
        subject: z.string().describe('Brief task title'),
        description: z.string().describe('Full task description'),
    })).describe('Tasks to distribute to workers'),
    cwd: z.string().min(1).describe('Working directory (absolute path)'),
    newWindow: z.boolean().optional().describe('Spawn workers in a dedicated tmux window instead of splitting the current window'),
});
const statusSchema = z.object({
    job_id: z.string().describe('Job ID returned by omc_run_team_start'),
});
const waitSchema = z.object({
    job_id: z.string().describe('Job ID returned by omc_run_team_start'),
    timeout_ms: z.number().optional().describe('Maximum wait time in ms (default: 300000, max: 3600000)'),
    nudge_delay_ms: z.number().optional().describe('Milliseconds a pane must be idle before nudging (default: 30000)'),
    nudge_max_count: z.number().optional().describe('Maximum nudges per pane (default: 3)'),
    nudge_message: z.string().optional().describe('Message sent as nudge (default: "Continue working on your assigned task and report concrete progress (not ACK-only).")'),
});
const cleanupSchema = z.object({
    job_id: z.string().describe('Job ID returned by omc_run_team_start'),
    grace_ms: z.number().optional().describe('Grace period in ms before force-killing panes (default: 10000)'),
});
async function handleStart(args) {
    if (typeof args === 'object'
        && args !== null
        && Object.prototype.hasOwnProperty.call(args, 'timeoutSeconds')) {
        throw new Error('omc_run_team_start no longer accepts timeoutSeconds. Remove timeoutSeconds and use omc_run_team_wait timeout_ms to limit the wait call only (workers keep running until completion or explicit omc_run_team_cleanup).');
    }
    const input = startSchema.parse(args);
    validateTeamName(input.teamName);
    if (!isRuntimeV2Enabled()) {
        throw new Error('team_start_unsafe_runtime_v1: instance-bound provider cleanup requires runtime v2; set OMC_RUNTIME_V2=1');
    }
    const cwd = resolve(input.cwd);
    const jobId = `omc-${Date.now().toString(36)}${randomUUID().slice(0, 8)}`;
    const instanceId = randomUUID();
    const runtimeCliPath = join(__ownDir, 'runtime-cli.cjs');
    const job = {
        status: 'running',
        startedAt: Date.now(),
        teamName: input.teamName,
        cwd,
        instanceId,
    };
    // Persist identity before spawning a child that may create state. A cleanup
    // request must never reconstruct authority from a same-name team.
    persistJob(jobId, job);
    let child;
    try {
        child = spawn(process.execPath, [runtimeCliPath], {
            env: { ...process.env, OMC_JOB_ID: jobId, OMC_JOBS_DIR },
            stdio: ['pipe', 'pipe', 'pipe'],
        });
    }
    catch (error) {
        try {
            updateJobFailureIfRunning(jobId, instanceId, `spawn error: ${error instanceof Error ? error.message : String(error)}`);
        }
        catch {
            // Preserve the initially published identity record when its failure
            // updater cannot acquire the lock; never overwrite a concurrent update.
        }
        throw error;
    }
    const persistBoundFailure = (reason) => {
        try {
            updateJobFailureIfRunning(jobId, instanceId, reason);
        }
        catch {
            // Never replace a job with an unbound diagnostic after a publication
            // failure; the original identity remains the only cleanup authority.
        }
    };
    if (typeof child.on === 'function') {
        child.on('error', (error) => {
            persistBoundFailure(`spawn error: ${error.message}`);
        });
    }
    if (!child.stdin || typeof child.stdin.write !== 'function' || typeof child.stdin.end !== 'function') {
        persistBoundFailure('runtime_cli_stdin_unavailable');
        if (typeof child.kill === 'function')
            child.kill();
        throw new Error('runtime_cli_stdin_unavailable');
    }
    if (typeof child.stdin.on === 'function') {
        child.stdin.on('error', (error) => {
            persistBoundFailure(`runtime_cli_stdin_error:${error.message}`);
            try {
                child.kill();
            }
            catch { /* child may have exited already */ }
        });
    }
    try {
        child.stdin.write(JSON.stringify({ ...input, cwd, instanceId }));
        child.stdin.end();
    }
    catch (error) {
        persistBoundFailure(`runtime_cli_stdin_error:${error instanceof Error ? error.message : String(error)}`);
        if (typeof child.kill === 'function')
            child.kill();
        throw error;
    }
    withProcessIdentityFileLockSync(jobLockPath(jobId), () => {
        const currentJob = loadJobFromDisk(jobId);
        if (!currentJob
            || currentJob.instanceId !== instanceId
            || currentJob.cleanedUpAt
            || isJobTerminal(currentJob))
            return;
        const withPid = { ...currentJob, ...(child.pid != null ? { pid: child.pid } : {}) };
        persistJobUnlocked(jobId, withPid);
        job.pid = withPid.pid;
        job.status = withPid.status;
        job.stderr = withPid.stderr;
    });
    const outChunks = [];
    const errChunks = [];
    child.stdout.on('data', (c) => outChunks.push(c));
    child.stderr.on('data', (c) => errChunks.push(c));
    child.on('close', (code) => {
        try {
            withProcessIdentityFileLockSync(jobLockPath(jobId), () => {
                let current;
                try {
                    current = loadJobFromDisk(jobId);
                }
                catch {
                    return;
                }
                // A terminal or cleaned record may have been published by artifact
                // convergence/cleanup while the child was exiting. Preserve it in its
                // entirety; late child output is not authoritative.
                if (!current || current.instanceId !== instanceId || current.cleanedUpAt || isJobTerminal(current))
                    return;
                const stdout = Buffer.concat(outChunks).toString('utf-8').trim();
                const stderr = Buffer.concat(errChunks).toString('utf-8').trim();
                const terminalArtifact = readMatchingTerminalArtifact(current, jobId, OMC_JOBS_DIR);
                if (terminalArtifact) {
                    current.status = terminalArtifact.status;
                    current.result = terminalArtifact.raw;
                }
                else if (stdout) {
                    let parsed = null;
                    try {
                        parsed = JSON.parse(stdout);
                    }
                    catch { /* invalid envelope */ }
                    if (parsed
                        && (parsed.status === 'completed' || parsed.status === 'failed')
                        && parsed.instanceId === current.instanceId
                        && isValidTeamInstanceId(parsed.instanceId)) {
                        current.status = parsed.status;
                        current.result = stdout;
                    }
                    else {
                        current.status = 'failed';
                        current.stderr = current.stderr ?? 'terminal_result_evidence_invalid';
                        current.result = JSON.stringify({ error: 'terminal_result_evidence_invalid' });
                    }
                }
                else if (code === 0) {
                    const artifact = readMatchingTerminalArtifact(current, jobId, OMC_JOBS_DIR);
                    if (artifact) {
                        current.status = artifact.status;
                        current.result = artifact.raw;
                    }
                    else {
                        current.status = 'failed';
                        current.stderr = current.stderr ?? 'terminal_result_evidence_missing';
                        current.result = JSON.stringify({ error: 'terminal_result_evidence_missing' });
                    }
                }
                else {
                    current.status = 'failed';
                    current.result = current.result ?? JSON.stringify({ error: `Process exited with code ${code ?? 'unknown'}` });
                }
                if (stderr)
                    current.stderr = current.stderr ?? stderr;
                persistJobUnlocked(jobId, current);
            });
        }
        catch {
            // Keep the already-persisted identity and cleanup status authoritative.
        }
    });
    return {
        content: [{
                type: 'text',
                text: JSON.stringify({ jobId, instanceId, pid: job.pid, message: 'Team started. Poll with omc_run_team_status.' }),
            }],
    };
}
export async function handleStatus(args) {
    const { job_id } = statusSchema.parse(args);
    validateJobId(job_id);
    const job = readConvergedJob(job_id);
    if (!job) {
        return { content: [{ type: 'text', text: JSON.stringify({ error: `No job found: ${job_id}` }) }] };
    }
    return makeJobResponse(job_id, job);
}
export async function handleWait(args) {
    const { job_id, timeout_ms = 300_000, nudge_delay_ms, nudge_max_count, nudge_message } = waitSchema.parse(args);
    validateJobId(job_id);
    const deadline = Date.now() + Math.min(timeout_ms, 3_600_000);
    let pollDelay = 500;
    const initialJob = readConvergedJob(job_id);
    if (!initialJob) {
        return { content: [{ type: 'text', text: JSON.stringify({ error: `No job found: ${job_id}` }) }] };
    }
    if (!initialJob.teamName || !initialJob.cwd) {
        return { content: [{ type: 'text', text: JSON.stringify({ error: 'team_job_authority_missing' }) }] };
    }
    const originalNudgeJob = {
        instanceId: initialJob.instanceId,
        teamName: initialJob.teamName,
        cwd: initialJob.cwd,
    };
    const nudgeTracker = new NudgeTracker({
        ...(nudge_delay_ms != null ? { delayMs: nudge_delay_ms } : {}),
        ...(nudge_max_count != null ? { maxCount: nudge_max_count } : {}),
        ...(nudge_message != null ? { message: nudge_message } : {}),
    });
    while (Date.now() < deadline) {
        const job = readConvergedJob(job_id);
        if (!job) {
            return { content: [{ type: 'text', text: JSON.stringify({ error: `No job found: ${job_id}` }) }] };
        }
        if (isJobTerminal(job)) {
            return makeJobResponse(job_id, job, nudgeTracker.totalNudges > 0 ? nudgeTracker.getSummary() : undefined);
        }
        await new Promise(r => setTimeout(r, pollDelay));
        pollDelay = Math.min(Math.floor(pollDelay * 1.5), 2000);
        try {
            const panes = await loadPaneIds(job_id, originalNudgeJob.instanceId);
            const authority = panes
                ? await loadNudgeAuthority(job_id, originalNudgeJob, panes)
                : null;
            if (panes?.paneIds?.length && authority) {
                await nudgeTracker.checkAndNudge(panes.paneIds, panes.leaderPaneId, {
                    ...authority,
                    executeNudge: (paneId, message) => executeLockedNudge(job_id, originalNudgeJob, panes, authority, paneId, message),
                });
            }
        }
        catch { /* best-effort */ }
    }
    const timeoutJob = readConvergedJob(job_id);
    if (!timeoutJob) {
        return { content: [{ type: 'text', text: JSON.stringify({ error: `No job found: ${job_id}` }) }] };
    }
    if (isJobTerminal(timeoutJob)) {
        return makeJobResponse(job_id, timeoutJob, nudgeTracker.totalNudges > 0 ? nudgeTracker.getSummary() : undefined);
    }
    const elapsed = ((Date.now() - timeoutJob.startedAt) / 1000).toFixed(1);
    const timeoutOut = {
        error: `Timed out waiting for job ${job_id} after ${(timeout_ms / 1000).toFixed(0)}s — workers are still running; call omc_run_team_wait again to keep waiting or omc_run_team_cleanup to stop them`,
        jobId: job_id,
        instanceId: timeoutJob.instanceId,
        status: 'running',
        elapsedSeconds: elapsed,
    };
    if (nudgeTracker.totalNudges > 0)
        timeoutOut.nudges = nudgeTracker.getSummary();
    return { content: [{ type: 'text', text: JSON.stringify(timeoutOut) }] };
}
export async function handleCleanup(args) {
    const { job_id, grace_ms } = cleanupSchema.parse(args);
    validateJobId(job_id);
    const job = getJob(job_id);
    if (!job) {
        return {
            content: [{ type: 'text', text: `Job ${job_id} not found` }],
            isError: true,
        };
    }
    if (job.cleanedUpAt) {
        return {
            content: [{
                    type: 'text',
                    text: `Already cleaned up job ${job_id}; preserved any current team state`,
                }],
        };
    }
    const initialCleanupFields = {
        cleanedUpAt: job.cleanedUpAt,
        cleanupBlockedAt: job.cleanupBlockedAt,
        cleanupBlockedReason: job.cleanupBlockedReason,
    };
    const blockCleanup = (reason) => {
        const publication = mergeCleanupFields(job_id, job.instanceId, initialCleanupFields, {
            cleanupBlockedAt: new Date().toISOString(),
            cleanupBlockedReason: reason,
        });
        if (publication.kind === 'already_cleaned') {
            return {
                content: [{
                        type: 'text',
                        text: `Already cleaned up job ${job_id}; preserved any current team state`,
                    }],
            };
        }
        if (publication.kind === 'blocked') {
            return {
                content: [{
                        type: 'text',
                        text: `Team state/worktree cleanup preserved because cleanup publication was blocked (${publication.reason}).`,
                    }],
                isError: true,
            };
        }
        if (publication.kind === 'superseded') {
            return {
                content: [{
                        type: 'text',
                        text: `Team state/worktree cleanup preserved because newer cleanup state superseded this attempt (${publication.reason}; attempted ${reason}).`,
                    }],
                isError: true,
            };
        }
        return {
            content: [{
                    type: 'text',
                    text: `Team state/worktree cleanup preserved because ${reason}.`,
                }],
            isError: true,
        };
    };
    const resultEvidenceError = resultArtifactIdentityError(job, job_id, OMC_JOBS_DIR);
    if (resultEvidenceError)
        return blockCleanup(resultEvidenceError);
    const panes = await loadPaneIds(job_id, job.instanceId);
    if (!panes) {
        const reason = existsSync(join(OMC_JOBS_DIR, `${job_id}-panes.json`))
            ? 'cleanup_panes_evidence_corrupt'
            : 'cleanup_panes_evidence_missing';
        return blockCleanup(reason);
    }
    try {
        const shutdown = await shutdownTeamV2(job.teamName, job.cwd, {
            instanceId: job.instanceId,
            force: true,
            timeoutMs: Math.max(0, grace_ms ?? 10_000),
        });
        if (shutdown.outcome !== 'cleaned') {
            const reason = shutdown.outcome === 'preserved'
                ? `${shutdown.reason}:${shutdown.workers.join(',')}`
                : `${shutdown.reason}:${shutdown.detail}`;
            return blockCleanup(`team_shutdown_${reason}`);
        }
    }
    catch (error) {
        return blockCleanup(`team_shutdown_failed:${error instanceof Error ? error.message : String(error)}`);
    }
    const publication = mergeCleanupFields(job_id, job.instanceId, initialCleanupFields, {
        cleanedUpAt: new Date().toISOString(),
        clearBlocked: true,
    });
    if (publication.kind === 'already_cleaned') {
        return {
            content: [{
                    type: 'text',
                    text: `Already cleaned up job ${job_id}; preserved any current team state`,
                }],
        };
    }
    if (publication.kind === 'blocked') {
        return {
            content: [{
                    type: 'text',
                    text: `Team state/worktree cleanup preserved because cleanup publication was blocked (${publication.reason}).`,
                }],
            isError: true,
        };
    }
    if (publication.kind === 'superseded') {
        return {
            content: [{
                    type: 'text',
                    text: `Team state/worktree cleanup preserved because newer cleanup state superseded this attempt (${publication.reason}).`,
                }],
            isError: true,
        };
    }
    return { content: [{ type: 'text', text: `Cleaned up team instance ${job.instanceId}.` }] };
}
const TOOLS = [
    {
        name: 'omc_run_team_start',
        description: '[DEPRECATED] CLI-only migration required. This tool no longer executes; use `omc team start`.',
        inputSchema: {
            type: 'object',
            properties: {
                teamName: { type: 'string', description: 'Slug name for the team' },
                agentTypes: { type: 'array', items: { type: 'string' }, description: '"claude", "codex", "gemini", or "antigravity" per worker' },
                tasks: {
                    type: 'array',
                    items: {
                        type: 'object',
                        properties: {
                            subject: { type: 'string' },
                            description: { type: 'string' },
                        },
                        required: ['subject', 'description'],
                    },
                    description: 'Tasks to distribute to workers',
                },
                cwd: { type: 'string', description: 'Working directory (absolute path)' },
                newWindow: { type: 'boolean', description: 'Spawn workers in a dedicated tmux window instead of splitting the current window' },
            },
            required: ['teamName', 'agentTypes', 'tasks', 'cwd'],
        },
    },
    {
        name: 'omc_run_team_status',
        description: '[DEPRECATED] CLI-only migration required. This tool no longer executes; use `omc team status <job_id>`.',
        inputSchema: {
            type: 'object',
            properties: {
                job_id: { type: 'string', description: 'Job ID returned by omc_run_team_start' },
            },
            required: ['job_id'],
        },
    },
    {
        name: 'omc_run_team_wait',
        description: '[DEPRECATED] CLI-only migration required. This tool no longer executes; use `omc team wait <job_id>`.',
        inputSchema: {
            type: 'object',
            properties: {
                job_id: { type: 'string', description: 'Job ID returned by omc_run_team_start' },
                timeout_ms: { type: 'number', description: 'Maximum wait time in ms (default: 300000, max: 3600000)' },
                nudge_delay_ms: { type: 'number', description: 'Milliseconds a pane must be idle before nudging (default: 30000)' },
                nudge_max_count: { type: 'number', description: 'Maximum nudges per pane (default: 3)' },
                nudge_message: { type: 'string', description: 'Message sent as nudge (default: "Continue working on your assigned task and report concrete progress (not ACK-only).")' },
            },
            required: ['job_id'],
        },
    },
    {
        name: 'omc_run_team_cleanup',
        description: '[DEPRECATED COMPAT] Prefer `omc team cleanup <job_id>`; this compatibility cleanup surface preserves team state when worker liveness or worktree cleanup is not proven safe.',
        inputSchema: {
            type: 'object',
            properties: {
                job_id: { type: 'string', description: 'Job ID returned by omc_run_team_start' },
                grace_ms: { type: 'number', description: 'Grace period in ms before force-killing panes (default: 10000)' },
            },
            required: ['job_id'],
        },
    },
];
const server = new Server({ name: 'team', version: '1.0.0' }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    // Dispatch live handlers first. The deprecation guard below currently overlaps
    // with these same tool names but is kept as a safety net for future tool
    // renames — if a tool name is removed from this dispatch block, the
    // deprecation guard will catch stale callers and return a migration hint.
    try {
        if (name === 'omc_run_team_start')
            return await handleStart(args ?? {});
        if (name === 'omc_run_team_status')
            return await handleStatus(args ?? {});
        if (name === 'omc_run_team_wait')
            return await handleWait(args ?? {});
        if (name === 'omc_run_team_cleanup')
            return await handleCleanup(args ?? {});
    }
    catch (error) {
        return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
    }
    if (isDeprecatedTeamToolName(name)) {
        return createDeprecatedCliOnlyEnvelopeWithArgs(name, args);
    }
    return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
});
async function main() {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error('OMC Team MCP Server running on stdio');
}
if (process.env.OMC_TEAM_SERVER_DISABLE_AUTOSTART !== '1' && process.env.NODE_ENV !== 'test') {
    main().catch((error) => {
        console.error('Failed to start server:', error);
        process.exit(1);
    });
}
//# sourceMappingURL=team-server.js.map