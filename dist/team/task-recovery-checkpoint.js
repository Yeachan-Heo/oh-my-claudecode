import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { link, mkdir, open, readFile, readdir, rename, unlink } from 'node:fs/promises';
import { basename, dirname } from 'node:path';
import { TeamPaths, absPath } from './state-paths.js';
export const MAX_TASK_RECOVERY_CHECKPOINT_BYTES = 64 * 1024;
function canonicalJson(value) {
    const seen = new Set();
    const normalize = (current) => {
        if (current === null || typeof current === 'string' || typeof current === 'boolean')
            return current;
        if (typeof current === 'number') {
            if (!Number.isFinite(current))
                throw new TypeError('Checkpoint payload must be finite JSON');
            return current;
        }
        if (Array.isArray(current))
            return current.map(normalize);
        if (typeof current === 'object') {
            if (seen.has(current))
                throw new TypeError('Checkpoint payload must not contain cycles');
            seen.add(current);
            const output = {};
            for (const key of Object.keys(current).sort()) {
                const child = current[key];
                if (child === undefined || typeof child === 'function' || typeof child === 'symbol' || typeof child === 'bigint') {
                    throw new TypeError('Checkpoint payload must be JSON');
                }
                output[key] = normalize(child);
            }
            seen.delete(current);
            return output;
        }
        throw new TypeError('Checkpoint payload must be JSON');
    };
    return JSON.stringify(normalize(value));
}
export function hashTaskRecoveryCheckpointPayload(payload) {
    return createHash('sha256').update(canonicalJson(payload)).digest('hex');
}
export function taskRecoveryClaimTokenHash(claimToken) {
    return createHash('sha256').update(claimToken).digest('hex');
}
function checkpointPath(cwd, teamName, taskId, claimToken, sequence) {
    return absPath(cwd, TeamPaths.checkpoint(teamName, taskId, taskRecoveryClaimTokenHash(claimToken), sequence));
}
function latestPath(cwd, teamName, taskId, claimToken) {
    return absPath(cwd, TeamPaths.checkpointLatest(teamName, taskId, taskRecoveryClaimTokenHash(claimToken)));
}
async function syncDirectory(path) {
    if (process.platform === 'win32')
        return;
    const directory = await open(dirname(path), 'r');
    try {
        await directory.sync();
    }
    finally {
        await directory.close();
    }
}
async function writeAtomic(path, content) {
    await mkdir(dirname(path), { recursive: true });
    const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
    const handle = await open(temp, 'wx', 0o600);
    try {
        await handle.writeFile(content, 'utf8');
        await handle.sync();
    }
    finally {
        await handle.close();
    }
    await rename(temp, path);
    await syncDirectory(path);
}
async function publishImmutableCheckpoint(path, content) {
    await mkdir(dirname(path), { recursive: true });
    const temp = `${path}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
    const handle = await open(temp, 'wx', 0o600);
    try {
        await handle.writeFile(content, 'utf8');
        await handle.sync();
    }
    finally {
        await handle.close();
    }
    try {
        await link(temp, path);
        if (await readFile(path, 'utf8') !== content)
            return 'conflict';
        await syncDirectory(path);
        return 'created';
    }
    catch (error) {
        if (error.code !== 'EEXIST')
            throw error;
        return await readFile(path, 'utf8').catch(() => '') === content ? 'replayed' : 'conflict';
    }
    finally {
        await unlink(temp).catch(() => undefined);
    }
}
function parseCheckpoint(value) {
    if (!value || typeof value !== 'object')
        return null;
    const checkpoint = value;
    const sequence = checkpoint.sequence;
    const taskVersion = checkpoint.task_version;
    if (checkpoint.schema_version !== 1 || typeof checkpoint.team_name !== 'string' || typeof checkpoint.task_id !== 'string'
        || typeof checkpoint.worker_name !== 'string' || typeof sequence !== 'number' || !Number.isSafeInteger(sequence) || sequence <= 0
        || typeof taskVersion !== 'number' || !Number.isSafeInteger(taskVersion) || taskVersion <= 0 || typeof checkpoint.claim_token !== 'string'
        || typeof checkpoint.resume_payload_hash !== 'string' || typeof checkpoint.updated_at !== 'string')
        return null;
    try {
        if (hashTaskRecoveryCheckpointPayload(checkpoint.resume_payload) !== checkpoint.resume_payload_hash)
            return null;
    }
    catch {
        return null;
    }
    return checkpoint;
}
function sameCheckpointPublication(existing, candidate) {
    const { updated_at: _existingUpdatedAt, ...existingSemantic } = existing;
    const { updated_at: _candidateUpdatedAt, ...candidateSemantic } = candidate;
    return canonicalJson(existingSemantic) === canonicalJson(candidateSemantic);
}
function checkpointSequenceFromPath(path) {
    const match = /^(\d+)\.json$/.exec(basename(path));
    if (!match)
        return null;
    const sequence = Number(match[1]);
    return Number.isSafeInteger(sequence) && sequence > 0 ? sequence : null;
}
async function readCheckpoint(path) {
    const filenameSequence = checkpointSequenceFromPath(path);
    if (filenameSequence === null)
        return null;
    try {
        const checkpoint = parseCheckpoint(JSON.parse(await readFile(path, 'utf8')));
        return checkpoint?.sequence === filenameSequence ? checkpoint : null;
    }
    catch {
        return null;
    }
}
async function readCheckpointLatest(path) {
    try {
        const value = JSON.parse(await readFile(path, 'utf8'));
        return Number.isSafeInteger(value.sequence) && value.sequence > 0 ? { sequence: value.sequence } : null;
    }
    catch {
        return null;
    }
}
export async function publishTaskRecoveryCheckpoint(input, cwd, access) {
    if (!Number.isSafeInteger(input.sequence) || input.sequence <= 0 || !Number.isSafeInteger(input.taskVersion) || input.taskVersion <= 0) {
        return { ok: false, error: 'invalid_checkpoint' };
    }
    let payloadHash;
    let payloadBytes;
    try {
        const serialized = canonicalJson(input.resumePayload);
        payloadBytes = Buffer.byteLength(serialized);
        payloadHash = createHash('sha256').update(serialized).digest('hex');
    }
    catch {
        return { ok: false, error: 'invalid_checkpoint' };
    }
    if (payloadBytes > MAX_TASK_RECOVERY_CHECKPOINT_BYTES)
        return { ok: false, error: 'invalid_checkpoint' };
    const lock = await access.withTaskLock(input.teamName, input.taskId, cwd, async () => {
        const task = await access.readTask(input.teamName, input.taskId, cwd);
        if (!task || task.status !== 'in_progress' || task.version !== input.taskVersion || task.owner !== input.workerName
            || !task.claim || task.claim.owner !== input.workerName || task.claim.token !== input.claimToken) {
            return { ok: false, error: 'claim_conflict' };
        }
        const checkpoint = {
            schema_version: 1,
            team_name: input.teamName,
            task_id: input.taskId,
            worker_name: input.workerName,
            sequence: input.sequence,
            task_version: input.taskVersion,
            claim_token: input.claimToken,
            resume_payload_hash: payloadHash,
            resume_payload: input.resumePayload,
            updated_at: input.updatedAt ?? new Date().toISOString(),
        };
        const path = checkpointPath(cwd, input.teamName, input.taskId, input.claimToken, input.sequence);
        const existing = await readCheckpoint(path);
        if (existing) {
            if (!sameCheckpointPublication(existing, checkpoint)) {
                return { ok: false, error: 'publication_conflict' };
            }
            return { ok: true, checkpoint: existing, path, replayed: true };
        }
        const publication = await publishImmutableCheckpoint(path, JSON.stringify(checkpoint));
        if (publication !== 'created') {
            const replayed = await readCheckpoint(path);
            return replayed && sameCheckpointPublication(replayed, checkpoint)
                ? { ok: true, checkpoint: replayed, path, replayed: true }
                : { ok: false, error: 'publication_conflict' };
        }
        const latest = latestPath(cwd, input.teamName, input.taskId, input.claimToken);
        const existingLatest = await readCheckpointLatest(latest);
        if (!existingLatest || input.sequence >= existingLatest.sequence) {
            await writeAtomic(latest, JSON.stringify({ sequence: input.sequence, path, resume_payload_hash: payloadHash }));
        }
        return { ok: true, checkpoint, path, replayed: false };
    });
    return lock.ok ? lock.value : { ok: false, error: 'claim_conflict' };
}
export async function selectTaskRecoveryCheckpoint(teamName, task, cwd) {
    if (!task.owner || !task.claim)
        return { ok: false, error: 'stale' };
    const root = absPath(cwd, TeamPaths.checkpoints(teamName, task.id, taskRecoveryClaimTokenHash(task.claim.token)));
    if (!existsSync(root))
        return { ok: false, error: 'missing' };
    let names;
    try {
        names = await readdir(root);
    }
    catch {
        return { ok: false, error: 'malformed' };
    }
    const paths = names.filter((name) => /^\d+\.json$/.test(name)).map((name) => `${root}/${name}`);
    if (paths.length === 0)
        return { ok: false, error: 'missing' };
    const parsed = await Promise.all(paths.map(async (path) => ({ path, checkpoint: await readCheckpoint(path) })));
    if (parsed.some(({ checkpoint }) => !checkpoint))
        return { ok: false, error: 'malformed' };
    const valid = parsed;
    const matching = valid.filter(({ checkpoint }) => checkpoint.team_name === teamName && checkpoint.task_id === task.id
        && checkpoint.worker_name === task.owner && checkpoint.task_version === task.version && checkpoint.claim_token === task.claim?.token);
    if (matching.length === 0)
        return { ok: false, error: 'stale' };
    const highest = Math.max(...matching.map(({ checkpoint }) => checkpoint.sequence));
    const selected = matching.filter(({ checkpoint }) => checkpoint.sequence === highest);
    if (selected.length !== 1)
        return { ok: false, error: 'ambiguous' };
    const otherHighest = valid.filter(({ checkpoint }) => checkpoint.sequence === highest && checkpoint.resume_payload_hash !== selected[0].checkpoint.resume_payload_hash);
    if (otherHighest.length > 0)
        return { ok: false, error: 'ambiguous' };
    return { ok: true, checkpoint: selected[0].checkpoint, path: selected[0].path };
}
export async function readTaskRecoveryCheckpoint(path) {
    const checkpoint = await readCheckpoint(path);
    return checkpoint ? { ok: true, checkpoint, path } : { ok: false, error: existsSync(path) ? 'malformed' : 'missing' };
}
//# sourceMappingURL=task-recovery-checkpoint.js.map