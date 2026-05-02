import { existsSync } from 'fs';
import { readFile, realpath, stat } from 'fs/promises';
import { join, relative, resolve, sep } from 'path';
import { getOmcRoot } from '../lib/worktree-paths.js';
/**
 * Resolve the canonical OMC team state root for a leader working directory.
 *
 * This mirrors the OMX team API helper while preserving OMC's state boundary:
 * the canonical leader root is the state directory that contains `team/<name>`.
 * Runtime worker envs may still pass a team-specific root; worker resolution
 * accepts both root shapes for compatibility.
 */
export function resolveCanonicalTeamStateRoot(leaderCwd, env = process.env) {
    const explicit = readExplicitTeamStateRoot(env);
    if (explicit)
        return resolve(leaderCwd, explicit);
    return resolve(getOmcRoot(leaderCwd), 'state');
}
function readExplicitTeamStateRoot(env) {
    const omc = typeof env.OMC_TEAM_STATE_ROOT === 'string' ? env.OMC_TEAM_STATE_ROOT.trim() : '';
    if (omc)
        return omc;
    return typeof env.OMX_TEAM_STATE_ROOT === 'string' ? env.OMX_TEAM_STATE_ROOT.trim() : '';
}
function readLeaderCwd(env) {
    const omc = typeof env.OMC_TEAM_LEADER_CWD === 'string' ? env.OMC_TEAM_LEADER_CWD.trim() : '';
    if (omc)
        return omc;
    return typeof env.OMX_TEAM_LEADER_CWD === 'string' ? env.OMX_TEAM_LEADER_CWD.trim() : '';
}
async function readJsonIfExists(path) {
    try {
        if (!existsSync(path))
            return null;
        const parsed = JSON.parse(await readFile(path, 'utf-8'));
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
            ? parsed
            : null;
    }
    catch {
        return null;
    }
}
function metadataStateRoot(value) {
    return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}
async function normalizePath(path) {
    const resolved = resolve(path);
    try {
        return await realpath(resolved);
    }
    catch {
        return resolved;
    }
}
function pathIsSameOrInside(candidate, parent) {
    if (candidate === parent)
        return true;
    const rel = relative(parent, candidate);
    return rel !== '' && !rel.startsWith('..') && rel !== '..' && !rel.startsWith(`..${sep}`);
}
function teamRootPath(stateRoot, teamName, layout) {
    return layout === 'team_root' ? stateRoot : join(stateRoot, 'team', teamName);
}
async function candidateLayouts(resolvedStateRoot, teamName) {
    const layouts = [];
    if (await pathIsDirectory(join(resolvedStateRoot, 'team', teamName)))
        layouts.push('state_root');
    if (await pathIsDirectory(join(resolvedStateRoot, 'workers')) || existsSync(join(resolvedStateRoot, 'config.json')) || existsSync(join(resolvedStateRoot, 'manifest.json')) || existsSync(join(resolvedStateRoot, 'manifest.v2.json'))) {
        layouts.push('team_root');
    }
    return layouts.length > 0 ? layouts : ['state_root', 'team_root'];
}
async function cwdMatchesIdentityWorktree(cwd, identity) {
    const worktreePath = metadataStateRoot(identity.worktree_path);
    if (!worktreePath)
        return { matches: true };
    const [normalizedCwd, normalizedWorktree] = await Promise.all([
        normalizePath(cwd),
        normalizePath(worktreePath),
    ]);
    return pathIsSameOrInside(normalizedCwd, normalizedWorktree)
        ? { matches: true, worktreePath: normalizedWorktree }
        : { matches: false, worktreePath: normalizedWorktree };
}
async function validateWorkerStateRoot(stateRoot, cwd, worker) {
    const resolvedStateRoot = resolve(cwd, stateRoot);
    let lastIdentityPath = join(resolvedStateRoot, 'team', worker.teamName, 'workers', worker.workerName, 'identity.json');
    for (const layout of await candidateLayouts(resolvedStateRoot, worker.teamName)) {
        const identityPath = join(teamRootPath(resolvedStateRoot, worker.teamName, layout), 'workers', worker.workerName, 'identity.json');
        lastIdentityPath = identityPath;
        const identity = await readJsonIfExists(identityPath);
        if (!identity)
            continue;
        const identityName = metadataStateRoot(identity.name);
        if (identityName && identityName !== worker.workerName) {
            return { ok: false, stateRoot: null, source: null, reason: 'identity_worker_mismatch', identityPath };
        }
        const worktreeMatch = await cwdMatchesIdentityWorktree(cwd, identity);
        if (!worktreeMatch.matches) {
            return {
                ok: false,
                stateRoot: null,
                source: null,
                reason: 'identity_worktree_mismatch',
                identityPath,
                worktreePath: worktreeMatch.worktreePath,
            };
        }
        return {
            ok: true,
            stateRoot: resolvedStateRoot,
            source: null,
            identityPath,
            worktreePath: worktreeMatch.worktreePath,
        };
    }
    return {
        ok: false,
        stateRoot: null,
        source: null,
        reason: 'missing_or_invalid_identity',
        identityPath: lastIdentityPath,
    };
}
async function validateWithSource(stateRoot, source, cwd, worker) {
    const validated = await validateWorkerStateRoot(stateRoot, cwd, worker);
    return validated.ok ? { ...validated, source } : validated;
}
async function readMetadataRootFromValidatedCandidate(candidateStateRoot, filename, cwd, worker) {
    const validated = await validateWorkerStateRoot(candidateStateRoot, cwd, worker);
    if (!validated.ok)
        return null;
    const resolvedStateRoot = resolve(cwd, candidateStateRoot);
    for (const layout of await candidateLayouts(resolvedStateRoot, worker.teamName)) {
        const teamRoot = teamRootPath(resolvedStateRoot, worker.teamName, layout);
        const metadataPath = filename === 'identity.json'
            ? join(teamRoot, 'workers', worker.workerName, filename)
            : join(teamRoot, filename);
        const parsed = await readJsonIfExists(metadataPath);
        const root = metadataStateRoot(parsed?.team_state_root);
        if (root)
            return root;
    }
    return null;
}
async function pathIsDirectory(path) {
    try {
        return (await stat(path)).isDirectory();
    }
    catch {
        return false;
    }
}
function workerListContains(parsed, workerName) {
    const workers = parsed?.workers;
    return Array.isArray(workers)
        && workers.some((worker) => worker && typeof worker === 'object' && !Array.isArray(worker)
            && metadataStateRoot(worker.name) === workerName);
}
function metadataTeamMatches(parsed, teamName) {
    const name = metadataStateRoot(parsed?.name);
    return !name || name === teamName;
}
async function readTeamMetadataRootFromCandidate(candidateStateRoot, filename, cwd, worker) {
    const resolvedStateRoot = resolve(cwd, candidateStateRoot);
    for (const layout of await candidateLayouts(resolvedStateRoot, worker.teamName)) {
        const parsed = await readJsonIfExists(join(teamRootPath(resolvedStateRoot, worker.teamName, layout), filename));
        if (!metadataTeamMatches(parsed, worker.teamName) || !workerListContains(parsed, worker.workerName))
            continue;
        const root = metadataStateRoot(parsed?.team_state_root);
        if (root)
            return root;
    }
    return null;
}
async function validateWorkerNotifyStateRoot(stateRoot, source, cwd, worker) {
    const identityResolved = await validateWithSource(stateRoot, source, cwd, worker);
    if (identityResolved.ok)
        return identityResolved;
    const resolvedStateRoot = resolve(cwd, stateRoot);
    for (const layout of await candidateLayouts(resolvedStateRoot, worker.teamName)) {
        const teamRoot = teamRootPath(resolvedStateRoot, worker.teamName, layout);
        const workerDir = join(teamRoot, 'workers', worker.workerName);
        if (await pathIsDirectory(workerDir)) {
            return {
                ok: true,
                stateRoot: resolvedStateRoot,
                source: 'worker_directory',
                identityPath: join(workerDir, 'identity.json'),
            };
        }
        for (const [filename, metadataSource] of [
            ['manifest.json', 'manifest_metadata'],
            ['manifest.v2.json', 'manifest_metadata'],
            ['config.json', 'config_metadata'],
        ]) {
            const parsed = await readJsonIfExists(join(teamRoot, filename));
            if (!metadataTeamMatches(parsed, worker.teamName) || !workerListContains(parsed, worker.workerName))
                continue;
            return {
                ok: true,
                stateRoot: resolvedStateRoot,
                source: metadataSource,
                identityPath: join(workerDir, 'identity.json'),
            };
        }
    }
    return {
        ok: false,
        stateRoot: null,
        source: null,
        reason: identityResolved.reason || 'missing_worker_marker',
        identityPath: identityResolved.identityPath,
    };
}
async function resolveWorkerTeamStateRootWithOptions(cwd, worker, env, options) {
    const explicit = readExplicitTeamStateRoot(env);
    if (explicit) {
        const resolved = await validateWithSource(resolve(cwd, explicit), 'env', cwd, worker);
        if (resolved.ok)
            return resolved;
        return { ...resolved, source: 'env' };
    }
    const leaderCwd = readLeaderCwd(env);
    const leaderStateRoot = leaderCwd ? resolveCanonicalTeamStateRoot(resolve(cwd, leaderCwd), {}) : '';
    const cwdStateRoot = resolveCanonicalTeamStateRoot(cwd, {});
    const hintedCandidates = [
        ...(leaderStateRoot ? [{ stateRoot: leaderStateRoot, source: 'leader_cwd' }] : []),
        ...(options.allowCwdFallback ? [{ stateRoot: cwdStateRoot, source: 'cwd' }] : []),
    ];
    const metadataSources = [
        ['identity.json', 'identity_metadata'],
        ['manifest.json', 'manifest_metadata'],
        ['manifest.v2.json', 'manifest_metadata'],
        ['config.json', 'config_metadata'],
    ];
    for (const candidate of hintedCandidates) {
        const direct = await validateWithSource(candidate.stateRoot, candidate.source, cwd, worker);
        if (!direct.ok)
            continue;
        if (options.preferMetadataRoot) {
            for (const [filename, source] of metadataSources) {
                const metadataRoot = await readMetadataRootFromValidatedCandidate(candidate.stateRoot, filename, cwd, worker);
                if (!metadataRoot)
                    continue;
                const resolved = await validateWithSource(resolve(cwd, metadataRoot), source, cwd, worker);
                if (resolved.ok)
                    return resolved;
            }
        }
        return direct;
    }
    const diagnosticStateRoot = leaderStateRoot || (options.allowCwdFallback ? cwdStateRoot : '');
    const diagnostic = diagnosticStateRoot
        ? await validateWithSource(diagnosticStateRoot, leaderStateRoot ? 'leader_cwd' : 'cwd', cwd, worker)
        : null;
    return {
        ok: false,
        stateRoot: null,
        source: null,
        reason: diagnostic?.reason || 'no_valid_worker_state_root',
        identityPath: diagnostic?.identityPath,
    };
}
/**
 * Resolve the canonical team state root for an OMC team worker PostToolUse/git hook.
 */
export async function resolveWorkerTeamStateRoot(cwd, worker, env = process.env) {
    return resolveWorkerTeamStateRootWithOptions(cwd, worker, env, {
        allowCwdFallback: true,
        preferMetadataRoot: false,
    });
}
/**
 * Resolve the team state root for non-git worker notify hooks without guessing
 * a local worker worktree state directory when no runtime hint exists.
 */
export async function resolveWorkerNotifyTeamStateRoot(cwd, worker, env = process.env) {
    const explicit = readExplicitTeamStateRoot(env);
    if (explicit) {
        const resolved = await validateWorkerNotifyStateRoot(resolve(cwd, explicit), 'env', cwd, worker);
        if (resolved.ok)
            return resolved;
        return { ...resolved, source: 'env' };
    }
    const leaderCwd = readLeaderCwd(env);
    const leaderStateRoot = leaderCwd ? resolveCanonicalTeamStateRoot(resolve(cwd, leaderCwd), {}) : '';
    if (!leaderStateRoot) {
        return { ok: false, stateRoot: null, source: null, reason: 'no_valid_worker_state_root' };
    }
    const direct = await validateWorkerNotifyStateRoot(leaderStateRoot, 'leader_cwd', cwd, worker);
    if (!direct.ok)
        return direct;
    for (const [filename, source] of [
        ['identity.json', 'identity_metadata'],
        ['manifest.json', 'manifest_metadata'],
        ['manifest.v2.json', 'manifest_metadata'],
        ['config.json', 'config_metadata'],
    ]) {
        const metadataRoot = filename === 'identity.json'
            ? await readMetadataRootFromValidatedCandidate(leaderStateRoot, filename, cwd, worker)
            : await readTeamMetadataRootFromCandidate(leaderStateRoot, filename, cwd, worker);
        if (!metadataRoot)
            continue;
        const resolved = await validateWorkerNotifyStateRoot(resolve(cwd, metadataRoot), source, cwd, worker);
        if (resolved.ok)
            return resolved;
    }
    return direct;
}
export async function resolveWorkerTeamStateRootPath(cwd, worker, env = process.env) {
    const resolved = await resolveWorkerTeamStateRoot(cwd, worker, env);
    return resolved.ok ? resolved.stateRoot : null;
}
export async function resolveWorkerNotifyTeamStateRootPath(cwd, worker, env = process.env) {
    const resolved = await resolveWorkerNotifyTeamStateRoot(cwd, worker, env);
    return resolved.ok ? resolved.stateRoot : null;
}
//# sourceMappingURL=state-root.js.map