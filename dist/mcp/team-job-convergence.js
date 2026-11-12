import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { isValidTeamInstanceId } from '../team/types.js';
import { validateTeamName } from '../team/team-name.js';
function readResultArtifact(omcJobsDir, jobId) {
    const artifactPath = join(omcJobsDir, `${jobId}-result.json`);
    if (!existsSync(artifactPath))
        return { kind: 'none' };
    let raw;
    try {
        raw = readFileSync(artifactPath, 'utf-8');
    }
    catch (error) {
        if (error.code === 'ENOENT')
            return { kind: 'none' };
        const message = `Failed to read result artifact at ${artifactPath}: ${error instanceof Error ? error.message : String(error)}`;
        return {
            kind: 'parse-failed',
            message,
            payload: JSON.stringify({
                status: 'failed',
                error: {
                    code: 'RESULT_ARTIFACT_READ_FAILED',
                    message,
                },
            }),
        };
    }
    try {
        const parsed = JSON.parse(raw);
        if ((parsed?.status === 'completed' || parsed?.status === 'failed')
            && typeof parsed.instanceId === 'string') {
            return { kind: 'terminal', status: parsed.status, raw };
        }
        if (parsed?.status === 'completed' || parsed?.status === 'failed') {
            return {
                kind: 'parse-failed',
                message: `Result artifact at ${artifactPath} is missing instanceId`,
                payload: JSON.stringify({
                    status: 'failed',
                    error: {
                        code: 'RESULT_ARTIFACT_IDENTITY_MISSING',
                        message: `Result artifact at ${artifactPath} is missing instanceId`,
                    },
                }),
            };
        }
        return { kind: 'none' };
    }
    catch (error) {
        const message = `Failed to parse result artifact at ${artifactPath}: ${error instanceof Error ? error.message : String(error)}`;
        return {
            kind: 'parse-failed',
            message,
            payload: JSON.stringify({
                status: 'failed',
                error: {
                    code: 'RESULT_ARTIFACT_PARSE_FAILED',
                    message,
                },
            }),
        };
    }
}
export function convergeJobWithResultArtifact(job, jobId, omcJobsDir) {
    const artifact = readResultArtifact(omcJobsDir, jobId);
    if (artifact.kind === 'none')
        return { job, changed: false };
    if (artifact.kind === 'terminal') {
        let parsed;
        try {
            parsed = JSON.parse(artifact.raw);
        }
        catch {
            return {
                job: {
                    ...job,
                    status: 'failed',
                    stderr: `Corrupt result artifact for ${jobId}: invalid JSON`,
                    result: job.result ?? JSON.stringify({ error: 'result_artifact_parse_failed' }),
                },
                changed: true,
            };
        }
        if (parsed.instanceId !== job.instanceId) {
            const message = `Result artifact identity mismatch for ${jobId}`;
            return {
                job: {
                    ...job,
                    status: 'failed',
                    stderr: message,
                    result: job.result ?? JSON.stringify({ error: 'result_artifact_identity_mismatch' }),
                },
                changed: true,
            };
        }
        const changed = job.status !== artifact.status || job.result !== artifact.raw;
        return {
            job: changed
                ? {
                    ...job,
                    status: artifact.status,
                    result: artifact.raw,
                }
                : job,
            changed,
        };
    }
    const changed = job.status !== 'failed' || job.result !== artifact.payload || job.stderr !== artifact.message;
    return {
        job: changed
            ? {
                ...job,
                status: 'failed',
                result: artifact.payload,
                stderr: artifact.message,
            }
            : job,
        changed,
    };
}
export function resultArtifactIdentityError(job, jobId, omcJobsDir) {
    const artifactPath = join(omcJobsDir, `${jobId}-result.json`);
    let raw;
    try {
        raw = readFileSync(artifactPath, 'utf-8');
    }
    catch (error) {
        if (error.code === 'ENOENT')
            return null;
        return `cleanup_result_evidence_unreadable:${error instanceof Error ? error.message : String(error)}`;
    }
    try {
        const parsed = JSON.parse(raw);
        if ((parsed.status !== 'completed' && parsed.status !== 'failed')
            || parsed.instanceId !== job.instanceId)
            return 'cleanup_result_evidence_corrupt';
    }
    catch {
        return 'cleanup_result_evidence_corrupt';
    }
    return null;
}
/** Return a terminal artifact only when its immutable identity matches the job. */
export function readMatchingTerminalArtifact(job, jobId, omcJobsDir) {
    try {
        const raw = readFileSync(join(omcJobsDir, `${jobId}-result.json`), 'utf-8');
        const parsed = JSON.parse(raw);
        if ((parsed.status !== 'completed' && parsed.status !== 'failed')
            || parsed.instanceId !== job.instanceId
            || !isValidTeamInstanceId(parsed.instanceId))
            return null;
        return { status: parsed.status, raw };
    }
    catch {
        return null;
    }
}
export function isJobTerminal(job) {
    return job.status === 'completed' || job.status === 'failed' || job.status === 'timeout';
}
export function isValidOmcTeamJob(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        return false;
    const record = value;
    if ((record.status !== 'running' && record.status !== 'completed' && record.status !== 'failed' && record.status !== 'timeout')
        || typeof record.startedAt !== 'number'
        || !Number.isFinite(record.startedAt)
        || typeof record.teamName !== 'string'
        || record.teamName.trim().length === 0
        || typeof record.cwd !== 'string'
        || record.cwd.trim().length === 0
        || !isValidTeamInstanceId(record.instanceId))
        return false;
    try {
        validateTeamName(record.teamName);
    }
    catch {
        return false;
    }
    return (record.pid === undefined || (typeof record.pid === 'number' && Number.isSafeInteger(record.pid) && record.pid > 0))
        && (record.result === undefined || typeof record.result === 'string')
        && (record.stderr === undefined || typeof record.stderr === 'string')
        && (record.cleanedUpAt === undefined || typeof record.cleanedUpAt === 'string')
        && (record.cleanupBlockedAt === undefined || typeof record.cleanupBlockedAt === 'string')
        && (record.cleanupBlockedReason === undefined || typeof record.cleanupBlockedReason === 'string');
}
export function isValidTeamPaneArtifact(value, instanceId) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        return false;
    const record = value;
    if (record.instanceId !== instanceId
        || !isValidTeamInstanceId(record.instanceId)
        || !Array.isArray(record.paneIds)
        || !record.paneIds.every((paneId) => typeof paneId === 'string' && paneId.trim().length > 0)
        || new Set(record.paneIds).size !== record.paneIds.length
        || typeof record.leaderPaneId !== 'string'
        || record.leaderPaneId.trim().length === 0
        || (record.sessionName !== undefined && (typeof record.sessionName !== 'string' || record.sessionName.trim().length === 0))
        || (record.ownsWindow !== undefined && typeof record.ownsWindow !== 'boolean')
        || !Array.isArray(record.workers))
        return false;
    const paneIds = new Set(record.paneIds);
    const workerNames = new Set();
    const workerPaneIds = new Set();
    for (const worker of record.workers) {
        if (!worker || typeof worker !== 'object' || Array.isArray(worker))
            return false;
        const entry = worker;
        if (typeof entry.workerName !== 'string'
            || entry.workerName.trim().length === 0
            || workerNames.has(entry.workerName)
            || typeof entry.paneId !== 'string'
            || !paneIds.has(entry.paneId)
            || workerPaneIds.has(entry.paneId)
            || typeof entry.launchAttemptId !== 'string'
            || entry.launchAttemptId.trim().length === 0)
            return false;
        workerNames.add(entry.workerName);
        workerPaneIds.add(entry.paneId);
    }
    return workerPaneIds.size === paneIds.size;
}
//# sourceMappingURL=team-job-convergence.js.map