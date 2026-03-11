import { existsSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { cleanupTeamWorktrees } from '../team/git-worktree.js';
import { validateTeamName } from '../team/team-name.js';
function readResultArtifact(omcJobsDir, jobId) {
    const artifactPath = join(omcJobsDir, `${jobId}-result.json`);
    if (!existsSync(artifactPath))
        return { kind: 'none' };
    let raw;
    try {
        raw = readFileSync(artifactPath, 'utf-8');
    }
    catch {
        return { kind: 'none' };
    }
    try {
        const parsed = JSON.parse(raw);
        if (parsed?.status === 'completed' || parsed?.status === 'failed') {
            return { kind: 'terminal', status: parsed.status, raw };
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
export function isJobTerminal(job) {
    return job.status === 'completed' || job.status === 'failed' || job.status === 'timeout';
}
export function isPidAlive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    }
    catch {
        return false;
    }
}
export function clearScopedTeamState(job) {
    if (!job.cwd || !job.teamName) {
        return 'team state cleanup skipped (missing job cwd/teamName).';
    }
    try {
        validateTeamName(job.teamName);
    }
    catch (error) {
        return `team state cleanup skipped (invalid teamName): ${error instanceof Error ? error.message : String(error)}`;
    }
    const stateDir = join(job.cwd, '.omc', 'state', 'team', job.teamName);
    let worktreeMessage = 'worktree cleanup skipped.';
    try {
        cleanupTeamWorktrees(job.teamName, job.cwd);
        worktreeMessage = `worktree cleanup attempted for ${job.teamName}.`;
    }
    catch (error) {
        worktreeMessage = `worktree cleanup skipped: ${error instanceof Error ? error.message : String(error)}`;
    }
    try {
        if (!existsSync(stateDir)) {
            return `${worktreeMessage} team state dir not found at ${stateDir}.`;
        }
        rmSync(stateDir, { recursive: true, force: true });
        return `${worktreeMessage} team state dir removed at ${stateDir}.`;
    }
    catch (error) {
        return `${worktreeMessage} team state cleanup failed at ${stateDir}: ${error instanceof Error ? error.message : String(error)}`;
    }
}
//# sourceMappingURL=team-job-convergence.js.map