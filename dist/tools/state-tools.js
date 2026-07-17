/**
 * State Management MCP Tools
 *
 * Provides tools for reading, writing, and managing mode state files.
 * All paths are validated to stay within the worktree boundary.
 */
import { z } from 'zod';
import { createHash } from 'crypto';
import { existsSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'path';
import { resolveStatePath, ensureOmcDir, validateWorkingDirectory, resolveSessionStatePath, ensureSessionStateDir, listSessionIds, validateSessionId, getOmcRoot, OmcPaths, } from '../lib/worktree-paths.js';
import { resolveSessionId } from '../lib/session-id.js';
import { validatePayload } from '../lib/payload-limits.js';
import { canClearStateForSession, findCompletedSessionStateFiles, findCompletedSessionStateCandidates, findSessionOwnedStateCandidates, findSessionOwnedStateFiles, getStateSessionOwner, writeStateFileLocked, writeStateFileLockedIf, writeStateFileLockedCreateIf, clearStateFileLockedIf, emergencyMutateStateFileIf, recoverEmergencyStateFile, } from '../lib/mode-state-io.js';
import { isModeActive, getActiveModes, getAllModeStatuses, clearModeState, getStateFilePath, MODE_CONFIGS, getActiveSessionsForMode } from '../hooks/mode-registry/index.js';
import { namedWorkflowRuntimeSupported, validateNamedWorkflowStateStructure } from '../hooks/autopilot/named-workflow-resume-validator.js';
import { cancelMergeReadiness, createInitialMergeReadinessState, readMergeReadinessState, setMergeReadinessContent, recordMergeReadinessMCQAnswer } from '../hooks/merge-readiness/runtime.js';
import { formatMergeReadinessReport, redactMergeReadinessState } from '../hooks/merge-readiness/report.js';
// Canonical execution modes from mode-registry (deep-interview and self-improve
// are first-class modes with dedicated MODE_CONFIGS entries; ralplan remains an
// extra state-only mode handled via the registry-fallback path).
const EXECUTION_MODES = [
    'autopilot', 'autoresearch', 'team', 'ralph', 'ultrawork', 'ultraqa', 'deep-interview', 'self-improve'
];
// merge-readiness is read/clear-eligible (state_read/status/clear + /cancel work) but NOT write-eligible.
const STATE_TOOL_MODES = [
    ...EXECUTION_MODES,
    'ralplan',
    'omc-teams',
    'skill-active',
    'merge-readiness'
];
// Modes that may be generically written via state_write. Excludes merge-readiness (runtime-owned).
const STATE_WRITE_MODES = [
    ...EXECUTION_MODES,
    'ralplan',
    'omc-teams',
    'skill-active'
];
const EXTRA_STATE_ONLY_MODES = ['ralplan', 'omc-teams', 'skill-active'];
const CANCEL_SIGNAL_TTL_MS = 30_000;
const OWNER_SESSION_FALLBACK_MODES = new Set(['ralph']);
const CONVERGED_STATE_PATH_MODES = new Set(['ralph', 'ultrawork']);
function getStateFileName(mode) {
    const normalizedName = mode.endsWith('-state') ? mode : `${mode}-state`;
    return `${normalizedName}.json`;
}
function readJsonRecord(filePath) {
    try {
        return JSON.parse(readFileSync(filePath, 'utf-8'));
    }
    catch {
        return null;
    }
}
const NAMED_WORKFLOW_MARKERS = ['workflow', 'workflowRunId', 'pipelineTracking'];
function hasOwnProperty(record, key) {
    return Object.prototype.hasOwnProperty.call(record, key);
}
/** Any own named-workflow marker, including a falsy value, makes the record runtime-owned. */
function hasNamedWorkflowMarker(record) {
    if (!record)
        return false;
    return NAMED_WORKFLOW_MARKERS.some((marker) => hasOwnProperty(record, marker));
}
function hasValidatedNamedWorkflowTuple(record) {
    if (!NAMED_WORKFLOW_MARKERS.every((marker) => hasOwnProperty(record, marker)))
        return false;
    const sessionId = getStateSessionOwner(record);
    return typeof sessionId === 'string' && validateNamedWorkflowStateStructure(record, sessionId) !== null;
}
/** The portable emergency path may only pause or clear an exact discovered run. */
function isExactEmergencyNamedMutation(record, requestedRunId) {
    return hasValidatedNamedWorkflowTuple(record) &&
        typeof requestedRunId === 'string' &&
        record.workflowRunId === requestedRunId;
}
/** A named pause request is an exact capability, not a state replay payload. */
function isExactNamedPauseRequest(record) {
    const allowed = new Set(['active', 'workflowRunId', 'target_state_sha256']);
    return record.active === false &&
        typeof record.workflowRunId === 'string' &&
        Object.keys(record).every((key) => allowed.has(key)) &&
        (!hasOwnProperty(record, 'target_state_sha256') ||
            (typeof record.target_state_sha256 === 'string' && /^[a-f0-9]{64}$/.test(record.target_state_sha256)));
}
function matchesNamedPauseTarget(current, sessionId, workflowRunId, stateDigest) {
    return current.active === true &&
        current.workflowRunId === workflowRunId &&
        hasValidatedNamedWorkflowTuple(current) &&
        getStateSessionOwner(current) === sessionId &&
        (stateDigest === undefined || createHash('sha256').update(JSON.stringify(current)).digest('hex') === stateDigest);
}
function listSessionIdsUnderOmcRoot(omcRoot) {
    const sessionsDir = join(omcRoot, 'state', 'sessions');
    if (!existsSync(sessionsDir)) {
        return [];
    }
    try {
        return readdirSync(sessionsDir, { withFileTypes: true })
            .filter((entry) => entry.isDirectory())
            .map((entry) => entry.name)
            .filter((name) => /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,255}$/.test(name));
    }
    catch {
        return [];
    }
}
function getConvergedOmcRoots(root) {
    const roots = new Set([getOmcRoot(root)]);
    roots.add(join(root, OmcPaths.ROOT));
    roots.add(join(homedir(), OmcPaths.ROOT));
    return [...roots];
}
function getConvergedStateCandidates(mode, root, sessionId) {
    if (!CONVERGED_STATE_PATH_MODES.has(mode)) {
        return [];
    }
    const filename = getStateFileName(mode);
    const paths = new Set();
    for (const omcRoot of getConvergedOmcRoots(root)) {
        const stateDir = join(omcRoot, 'state');
        if (sessionId) {
            paths.add(join(stateDir, 'sessions', sessionId, filename));
            for (const sid of listSessionIdsUnderOmcRoot(omcRoot)) {
                const candidatePath = join(stateDir, 'sessions', sid, filename);
                const raw = readJsonRecord(candidatePath);
                if (raw && getStateSessionOwner(raw) === sessionId) {
                    paths.add(candidatePath);
                }
            }
        }
        else {
            for (const sid of listSessionIdsUnderOmcRoot(omcRoot)) {
                paths.add(join(stateDir, 'sessions', sid, filename));
            }
        }
        paths.add(join(stateDir, filename));
        paths.add(join(omcRoot, filename));
    }
    return [...paths];
}
function isConvergedCandidateActiveForSession(statePath, sessionId) {
    const raw = readJsonRecord(statePath);
    if (!raw || raw.active !== true) {
        return false;
    }
    if (!sessionId) {
        return true;
    }
    return canClearStateForSession(raw, sessionId);
}
function emergencyRecoveryOptionsForProject(mode, path, root) {
    if (mode !== 'autopilot' || !isSharedHomeAutopilotCandidate(path, root))
        return undefined;
    return { authorizeState: (state) => isStateCandidateForProject(mode, path, state, root) };
}
function clearDiscoveredStateCandidate(candidate, predicate, recoveryOptions) {
    return clearStateFileLockedIf(candidate.path, (current) => predicate(current) && JSON.stringify(current) === candidate.snapshot, recoveryOptions);
}
function clearAutopilotMarkerCandidate(candidate, root) {
    // A marker-bearing record may be malformed, but a clear is an exact deletion
    // capability over the discovered bytes after ownership/project filtering.
    // It must never become a pause, resume, or replacement write.
    const predicate = (current) => isStateCandidateForProject('autopilot', candidate.path, current, root) &&
        JSON.stringify(current) === candidate.snapshot;
    if (!namedWorkflowRuntimeSupported()) {
        return emergencyMutateStateFileIf(candidate.path, predicate, null, emergencyRecoveryOptionsForProject('autopilot', candidate.path, root));
    }
    return clearStateFileLockedIf(candidate.path, predicate, emergencyRecoveryOptionsForProject('autopilot', candidate.path, root)) === 'cleared';
}
function discoverStatePaths(paths) {
    const discovered = [];
    for (const path of paths) {
        const state = readJsonRecord(path);
        if (!state)
            continue;
        discovered.push({
            path,
            state,
            snapshot: JSON.stringify(state),
            ownerSessionId: getStateSessionOwner(state),
            workflowRunId: typeof state.workflowRunId === 'string' ? state.workflowRunId : undefined,
        });
    }
    return discovered;
}
function clearConvergedStateCandidates(mode, root, sessionId, discovered = discoverStatePaths(getConvergedStateCandidates(mode, root, sessionId))) {
    let cleared = 0;
    let hadFailure = false;
    for (const candidate of discovered) {
        const result = clearDiscoveredStateCandidate(candidate, (current) => isStateCandidateForProject(mode, candidate.path, current, root) && (!sessionId || canClearStateForSession(current, sessionId)));
        if (result === 'cleared')
            cleared++;
        else if (result === 'failed')
            hadFailure = true;
    }
    return { cleared, hadFailure, paths: discovered.map((candidate) => candidate.path) };
}
function hasActiveConvergedState(mode, root, sessionId) {
    return getConvergedStateCandidates(mode, root, sessionId)
        .some((statePath) => isConvergedCandidateActiveForSession(statePath, sessionId));
}
function readTeamNamesFromStateFile(statePath) {
    if (!existsSync(statePath))
        return [];
    try {
        const raw = JSON.parse(readFileSync(statePath, 'utf-8'));
        const teamName = typeof raw.team_name === 'string'
            ? raw.team_name.trim()
            : typeof raw.teamName === 'string'
                ? raw.teamName.trim()
                : '';
        return teamName ? [teamName] : [];
    }
    catch {
        return [];
    }
}
function pruneMissionBoardTeams(root, teamNames) {
    const missionStatePath = join(getOmcRoot(root), 'state', 'mission-state.json');
    if (!existsSync(missionStatePath))
        return 0;
    try {
        const parsed = JSON.parse(readFileSync(missionStatePath, 'utf-8'));
        if (!Array.isArray(parsed.missions))
            return 0;
        const shouldRemoveAll = teamNames == null;
        const teamNameSet = new Set(teamNames ?? []);
        const remainingMissions = parsed.missions.filter((mission) => {
            if (mission.source !== 'team')
                return true;
            if (shouldRemoveAll)
                return false;
            const missionTeamName = typeof mission.teamName === 'string'
                ? mission.teamName.trim()
                : typeof mission.name === 'string'
                    ? mission.name.trim()
                    : '';
            return !missionTeamName || !teamNameSet.has(missionTeamName);
        });
        const removed = parsed.missions.length - remainingMissions.length;
        if (removed > 0) {
            writeFileSync(missionStatePath, JSON.stringify({
                ...parsed,
                updatedAt: new Date().toISOString(),
                missions: remainingMissions,
            }, null, 2));
        }
        return removed;
    }
    catch {
        return 0;
    }
}
function cleanupTeamRuntimeState(root, teamNames) {
    const teamStateRoot = join(getOmcRoot(root), 'state', 'team');
    if (!existsSync(teamStateRoot))
        return 0;
    const shouldRemoveAll = teamNames == null;
    let removed = 0;
    if (shouldRemoveAll) {
        try {
            rmSync(teamStateRoot, { recursive: true, force: true });
            return 1;
        }
        catch {
            return 0;
        }
    }
    for (const teamName of teamNames ?? []) {
        if (!teamName)
            continue;
        try {
            rmSync(join(teamStateRoot, teamName), { recursive: true, force: true });
            removed += 1;
        }
        catch {
            // best effort
        }
    }
    return removed;
}
/**
 * Get the state file path for any mode (including swarm and ralplan).
 *
 * - For registry modes (8 modes): uses getStateFilePath from mode-registry
 * - For ralplan (not in registry): uses resolveStatePath from worktree-paths
 *
 * This handles swarm's SQLite (.db) file transparently.
 */
function getStatePath(mode, root) {
    if (MODE_CONFIGS[mode]) {
        return getStateFilePath(root, mode);
    }
    // Fallback for modes not in registry (e.g., ralplan)
    return resolveStatePath(mode, root);
}
function getLegacyStateFileCandidates(mode, root) {
    const normalizedName = mode.endsWith('-state') ? mode : `${mode}-state`;
    const candidates = [
        getStatePath(mode, root),
        join(getOmcRoot(root), `${normalizedName}.json`),
    ];
    if (mode === 'autopilot')
        candidates.push(join(homedir(), '.omc', 'state', 'autopilot-state.json'));
    return [...new Set(candidates)];
}
function isSharedHomeAutopilotCandidate(path, root) {
    const sharedHomeStateRoot = resolve(homedir(), '.omc', 'state');
    const candidatePath = resolve(path);
    const canonicalStateRoot = resolve(getOmcRoot(root), 'state');
    const isDescendant = (ancestor, descendant) => {
        const fromAncestor = relative(ancestor, descendant);
        return fromAncestor === '' || (!fromAncestor.startsWith(`..${sep}`) && fromAncestor !== '..' && !isAbsolute(fromAncestor));
    };
    return !isDescendant(canonicalStateRoot, candidatePath) && isDescendant(sharedHomeStateRoot, candidatePath);
}
function isStateCandidateForProject(mode, path, state, root) {
    if (mode !== 'autopilot' || !isSharedHomeAutopilotCandidate(path, root))
        return true;
    return typeof state.project_path === 'string' && resolve(state.project_path) === resolve(root);
}
function isAutopilotRecoveryCandidateForProject(path, root) {
    if (!isSharedHomeAutopilotCandidate(path, root))
        return true;
    const primary = readJsonRecord(path);
    if (primary)
        return isStateCandidateForProject('autopilot', path, primary, root);
    const artifactPrefix = `${basename(path)}.emergency-quarantine.`;
    let artifacts;
    try {
        artifacts = readdirSync(dirname(path)).filter((name) => name.startsWith(artifactPrefix) && (name.endsWith('.payload') || /^[0-9a-f-]{36}$/i.test(name.slice(artifactPrefix.length))));
    }
    catch {
        return false;
    }
    if (artifacts.length === 0)
        return false;
    return artifacts.every((name) => {
        const state = readJsonRecord(join(dirname(path), name));
        return state !== null && isStateCandidateForProject('autopilot', path, state, root);
    });
}
function getWorkingDirectoryLocalOmcRoot(root) {
    return join(root, OmcPaths.ROOT);
}
function shouldCheckWorkingDirectoryLocalState(root) {
    return getWorkingDirectoryLocalOmcRoot(root) !== getOmcRoot(root);
}
function getWorkingDirectoryLocalSessionStatePath(mode, root, sessionId) {
    const normalizedName = mode.endsWith('-state') ? mode : `${mode}-state`;
    return join(getWorkingDirectoryLocalOmcRoot(root), 'state', 'sessions', sessionId, `${normalizedName}.json`);
}
function getWorkingDirectoryLocalLegacyStateFileCandidates(mode, root) {
    const normalizedName = mode.endsWith('-state') ? mode : `${mode}-state`;
    return [
        join(getWorkingDirectoryLocalOmcRoot(root), 'state', `${normalizedName}.json`),
        join(getWorkingDirectoryLocalOmcRoot(root), `${normalizedName}.json`),
    ];
}
function getWorkingDirectoryLocalStateClearCandidates(mode, root, sessionId) {
    if (!shouldCheckWorkingDirectoryLocalState(root)) {
        return [];
    }
    const paths = new Set();
    if (sessionId) {
        paths.add(getWorkingDirectoryLocalSessionStatePath(mode, root, sessionId));
    }
    for (const legacyPath of getWorkingDirectoryLocalLegacyStateFileCandidates(mode, root)) {
        paths.add(legacyPath);
    }
    return [...paths];
}
function clearWorkingDirectoryLocalStateCandidates(mode, root, sessionId, discovered = discoverStatePaths(getWorkingDirectoryLocalStateClearCandidates(mode, root, sessionId))) {
    let cleared = 0;
    let hadFailure = false;
    const localLegacyPaths = new Set(getWorkingDirectoryLocalLegacyStateFileCandidates(mode, root));
    for (const candidate of discovered) {
        const result = clearDiscoveredStateCandidate(candidate, (current) => !sessionId || !localLegacyPaths.has(candidate.path) || canClearStateForSession(current, sessionId));
        if (result === 'cleared')
            cleared++;
        else if (result === 'failed')
            hadFailure = true;
    }
    return { cleared, hadFailure, paths: discovered.map((candidate) => candidate.path) };
}
function clearLegacyStateCandidates(mode, root, sessionId, discovered = discoverStatePaths(getLegacyStateFileCandidates(mode, root))) {
    let cleared = 0;
    let hadFailure = false;
    for (const candidate of discovered) {
        const result = clearDiscoveredStateCandidate(candidate, (current) => isStateCandidateForProject(mode, candidate.path, current, root) && (!sessionId || canClearStateForSession(current, sessionId)), emergencyRecoveryOptionsForProject(mode, candidate.path, root));
        if (result === 'cleared')
            cleared++;
        else if (result === 'failed')
            hadFailure = true;
    }
    return { cleared, hadFailure };
}
function clearSessionOwnedStateCandidates(mode, root, sessionId, discovered = findSessionOwnedStateCandidates(mode, sessionId, root)) {
    let cleared = 0;
    let hadFailure = false;
    for (const candidate of discovered) {
        const result = clearDiscoveredStateCandidate(candidate, (current) => isStateCandidateForProject(mode, candidate.path, current, root) && canClearStateForSession(current, sessionId), emergencyRecoveryOptionsForProject(mode, candidate.path, root));
        if (result === 'cleared')
            cleared++;
        else if (result === 'failed')
            hadFailure = true;
    }
    return { cleared, hadFailure, paths: discovered.map((candidate) => candidate.path) };
}
function clearCompletedSessionStateCandidates(mode, root, requesterSessionId, discovered = findCompletedSessionStateCandidates(mode, root, requesterSessionId)) {
    let cleared = 0;
    let hadFailure = false;
    for (const candidate of discovered) {
        const result = clearDiscoveredStateCandidate(candidate, (current) => current.active === true && Boolean(candidate.completionEvidencePath && existsSync(candidate.completionEvidencePath)), emergencyRecoveryOptionsForProject(mode, candidate.path, root));
        if (result === 'cleared')
            cleared++;
        else if (result === 'failed')
            hadFailure = true;
    }
    return { cleared, hadFailure, paths: discovered.map((candidate) => candidate.path) };
}
function getStateClearCheckedPaths(mode, root, sessionId) {
    const paths = new Set();
    if (sessionId) {
        paths.add(MODE_CONFIGS[mode]
            ? getStateFilePath(root, mode, sessionId)
            : resolveSessionStatePath(mode, sessionId, root));
    }
    else {
        paths.add(getStatePath(mode, root));
    }
    for (const legacyPath of getLegacyStateFileCandidates(mode, root)) {
        paths.add(legacyPath);
    }
    for (const localPath of getWorkingDirectoryLocalStateClearCandidates(mode, root, sessionId)) {
        paths.add(localPath);
    }
    const sessionIds = sessionId ? [sessionId, ...listSessionIds(root)] : listSessionIds(root);
    for (const sid of new Set(sessionIds)) {
        paths.add(MODE_CONFIGS[mode]
            ? getStateFilePath(root, mode, sid)
            : resolveSessionStatePath(mode, sid, root));
    }
    return [...paths];
}
function formatStateClearNoopMessage(mode, root, sessionId) {
    const scope = sessionId ? ` in session: ${sessionId}` : '';
    const checkedPaths = getStateClearCheckedPaths(mode, root, sessionId);
    const checked = checkedPaths.length > 0
        ? `\n- Checked paths:\n${checkedPaths.map((statePath) => `  - ${statePath}`).join('\n')}`
        : '';
    return `No state found to clear for mode: ${mode}${scope}${checked}`;
}
function getModeRuntimeArtifactNames(mode) {
    return [
        `${mode}-stop-breaker.json`,
        `${mode}-last-steer-at`,
        `${mode}-continue-steer.lock`,
    ];
}
function clearModeRuntimeArtifacts(mode, root, sessionId) {
    let cleared = 0;
    let hadFailure = false;
    const stateRoot = join(getOmcRoot(root), 'state');
    const candidateDirs = new Set([stateRoot]);
    if (sessionId) {
        candidateDirs.add(join(stateRoot, 'sessions', sessionId));
    }
    else {
        for (const sid of listSessionIds(root)) {
            candidateDirs.add(join(stateRoot, 'sessions', sid));
        }
    }
    for (const dir of candidateDirs) {
        for (const artifactName of getModeRuntimeArtifactNames(mode)) {
            const artifactPath = join(dir, artifactName);
            if (!existsSync(artifactPath)) {
                continue;
            }
            try {
                unlinkSync(artifactPath);
                cleared++;
            }
            catch {
                hadFailure = true;
            }
        }
    }
    return { cleared, hadFailure };
}
function writeSessionCancelSignal(root, sessionId, mode, candidate) {
    ensureSessionStateDir(sessionId, root);
    const now = Date.now();
    const cancelSignalPath = resolveSessionStatePath('cancel-signal', sessionId, root);
    const payload = {
        active: true,
        requested_at: new Date(now).toISOString(),
        expires_at: new Date(now + CANCEL_SIGNAL_TTL_MS).toISOString(),
        mode,
        source: 'state_clear',
        ...(candidate?.workflowRunId ? { target_workflow_run_id: candidate.workflowRunId } : {}),
        ...(candidate ? { target_state_sha256: createHash('sha256').update(candidate.snapshot).digest('hex') } : {}),
    };
    if (!writeStateFileLocked(cancelSignalPath, payload)) {
        throw new Error(`state mutation lock unavailable for cancel signal: ${cancelSignalPath}`);
    }
}
function isSessionModeActive(mode, root, sessionId) {
    if (MODE_CONFIGS[mode]) {
        return isModeActive(mode, root, sessionId);
    }
    const statePath = resolveSessionStatePath(mode, sessionId, root);
    if (!existsSync(statePath)) {
        return false;
    }
    try {
        const state = JSON.parse(readFileSync(statePath, 'utf-8'));
        return state.active === true;
    }
    catch {
        return false;
    }
}
function findSingleOwningSessionForMode(mode, root, requesterSessionId) {
    const owningSessions = listSessionIds(root).filter((sid) => (sid !== requesterSessionId && isSessionModeActive(mode, root, sid)));
    return owningSessions.length === 1 ? owningSessions[0] : undefined;
}
function canonicalWorkflowJson(value) {
    if (Array.isArray(value))
        return `[${value.map(canonicalWorkflowJson).join(',')}]`;
    if (value && typeof value === 'object') {
        const record = value;
        return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonicalWorkflowJson(record[key])}`).join(',')}}`;
    }
    return JSON.stringify(value);
}
function isValidPublicWorkflowDescriptor(descriptor) {
    const stages = descriptor.stages;
    if (descriptor.descriptorVersion !== 1 || descriptor.profileVersion !== 1 || typeof descriptor.workflowName !== 'string' || !Array.isArray(stages) || !stages.every(stage => typeof stage === 'string') || typeof descriptor.profileHash !== 'string')
        return false;
    const allowed = new Set(['ralplan,execution', 'ralplan,execution,ralph', 'ralplan,execution,qa', 'ralplan,execution,ralph,qa']);
    if (!allowed.has(stages.join(',')))
        return false;
    const canonical = canonicalWorkflowJson({ descriptorVersion: 1, workflowName: descriptor.workflowName, profileVersion: 1, stages });
    return createHash('sha256').update(canonical).digest('hex') === descriptor.profileHash;
}
export function redactAutopilotPublicState(state) {
    if (!state || typeof state !== 'object') {
        return state;
    }
    const record = state;
    if (!hasNamedWorkflowMarker(record)) {
        return state;
    }
    const workflow = record.workflow;
    if (!hasValidatedNamedWorkflowTuple(record) || !workflow || typeof workflow !== 'object') {
        return { name: 'invalid', version: 1, shortHash: 'invalid', stages: [], currentStage: null, status: 'workflow_descriptor_integrity_failed', progress: '0/0' };
    }
    const descriptor = workflow;
    if (!isValidPublicWorkflowDescriptor(descriptor)) {
        return { name: 'invalid', version: 1, shortHash: 'invalid', stages: [], currentStage: null, status: 'workflow_descriptor_integrity_failed', progress: '0/0' };
    }
    const stages = Array.isArray(descriptor.stages) && descriptor.stages.every((stage) => typeof stage === 'string')
        ? descriptor.stages
        : [];
    const pipelineTracking = record.pipelineTracking && typeof record.pipelineTracking === 'object'
        ? record.pipelineTracking
        : undefined;
    const currentStageIndex = typeof pipelineTracking?.currentStageIndex === 'number'
        ? pipelineTracking.currentStageIndex
        : -1;
    const pipelineStages = Array.isArray(pipelineTracking?.stages) ? pipelineTracking.stages : [];
    const terminal = record.active === false && record.phase === 'complete' && currentStageIndex === stages.length;
    const currentPipelineStage = terminal ? undefined : pipelineStages[currentStageIndex];
    const currentStage = currentPipelineStage && typeof currentPipelineStage === 'object'
        && typeof currentPipelineStage.id === 'string'
        ? currentPipelineStage.id
        : null;
    const currentStageStatus = currentPipelineStage && typeof currentPipelineStage === 'object'
        && typeof currentPipelineStage.status === 'string'
        ? currentPipelineStage.status
        : null;
    const safeState = {
        name: typeof descriptor.workflowName === 'string' ? descriptor.workflowName.slice(0, 32) : 'invalid',
        workflowRunId: record.workflowRunId,
        version: typeof descriptor.profileVersion === 'number' ? descriptor.profileVersion : 1,
        shortHash: typeof descriptor.profileHash === 'string' ? descriptor.profileHash.slice(0, 12) : 'invalid',
        stages,
        currentStage,
        status: terminal ? 'complete' : currentStageStatus,
        progress: currentStageIndex >= 0 ? `${Math.min(currentStageIndex + 1, stages.length)}/${stages.length}` : `0/${stages.length}`,
    };
    return safeState;
}
function publicStateForMode(mode, state) {
    if (mode === 'autopilot') {
        return redactAutopilotPublicState(state);
    }
    return mode === 'merge-readiness'
        ? redactMergeReadinessState(state)
        : state;
}
// ============================================================================
// state_read - Read state for a mode
// ============================================================================
export const stateReadTool = {
    name: 'state_read',
    description: 'Read the current state for a specific mode (ralph, ultrawork, autopilot, etc.). Returns the JSON state data or indicates if no state exists.',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    schema: {
        mode: z.enum(STATE_TOOL_MODES).describe('The mode to read state for'),
        workingDirectory: z.string().optional().describe('Working directory (defaults to cwd)'),
        session_id: z.string().optional().describe('Session ID for session-scoped state isolation. When provided, the tool operates only within that session. When omitted, the tool aggregates legacy state plus all session-scoped state (may include other sessions).'),
    },
    handler: async (args) => {
        const { mode, workingDirectory, session_id } = args;
        try {
            const root = validateWorkingDirectory(workingDirectory);
            const sessionId = session_id;
            // If session_id provided, read from session-scoped path
            if (sessionId) {
                validateSessionId(sessionId);
                const statePath = MODE_CONFIGS[mode]
                    ? getStateFilePath(root, mode, sessionId)
                    : resolveSessionStatePath(mode, sessionId, root);
                if (!existsSync(statePath)) {
                    const completedSessionPaths = findCompletedSessionStateFiles(mode, root, sessionId);
                    if (completedSessionPaths.length > 0) {
                        const orphanList = completedSessionPaths
                            .map((orphanPath) => {
                            const sessionMarker = `${join('state', 'sessions')}/`;
                            const markerIndex = orphanPath.indexOf(sessionMarker);
                            if (markerIndex === -1)
                                return `- ${orphanPath}`;
                            const rest = orphanPath.slice(markerIndex + sessionMarker.length);
                            const orphanSessionId = rest.split(/[\\/]/)[0] || 'unknown';
                            return `- session: ${orphanSessionId}\n  path: ${orphanPath}`;
                        })
                            .join('\n');
                        return {
                            content: [{
                                    type: 'text',
                                    text: `No state found for mode: ${mode} in session: ${sessionId}\nExpected path: ${statePath}\n\nDiscovered ${completedSessionPaths.length} completed-session orphan state file${completedSessionPaths.length === 1 ? '' : 's'} for this mode:\n${orphanList}\n\nRun state_clear(mode="${mode}", session_id="${sessionId}") to clear the current session plus these completed-session orphan files.`
                                }]
                        };
                    }
                    return {
                        content: [{
                                type: 'text',
                                text: `No state found for mode: ${mode} in session: ${sessionId}\nExpected path: ${statePath}`
                            }]
                    };
                }
                const content = readFileSync(statePath, 'utf-8');
                const state = JSON.parse(content);
                return {
                    content: [{
                            type: 'text',
                            text: `## State for ${mode} (session: ${sessionId})\n\nPath: ${statePath}\n\n\`\`\`json\n${JSON.stringify(publicStateForMode(mode, state), null, 2)}\n\`\`\``
                        }]
                };
            }
            // No session_id: scan all sessions and legacy path
            const statePath = getStatePath(mode, root);
            const legacyExists = existsSync(statePath);
            const sessionIds = listSessionIds(root);
            const activeSessions = [];
            for (const sid of sessionIds) {
                const sessionStatePath = MODE_CONFIGS[mode]
                    ? getStateFilePath(root, mode, sid)
                    : resolveSessionStatePath(mode, sid, root);
                if (existsSync(sessionStatePath)) {
                    activeSessions.push(sid);
                }
            }
            if (!legacyExists && activeSessions.length === 0) {
                return {
                    content: [{
                            type: 'text',
                            text: `No state found for mode: ${mode}\nExpected legacy path: ${statePath}\nNo active sessions found.\n\nNote: Reading from legacy/aggregate path (no session_id). This may include state from other sessions.`
                        }]
                };
            }
            let output = `## State for ${mode}\n\nNote: Reading from legacy/aggregate path (no session_id). This may include state from other sessions.\n\n`;
            // Show legacy state if exists
            if (legacyExists) {
                try {
                    const content = readFileSync(statePath, 'utf-8');
                    const state = JSON.parse(content);
                    output += `### Legacy Path (shared)\nPath: ${statePath}\n\n\`\`\`json\n${JSON.stringify(publicStateForMode(mode, state), null, 2)}\n\`\`\`\n\n`;
                }
                catch {
                    output += `### Legacy Path (shared)\nPath: ${statePath}\n*Error reading state file*\n\n`;
                }
            }
            // Show active sessions
            if (activeSessions.length > 0) {
                output += `### Active Sessions (${activeSessions.length})\n\n`;
                for (const sid of activeSessions) {
                    const sessionStatePath = MODE_CONFIGS[mode]
                        ? getStateFilePath(root, mode, sid)
                        : resolveSessionStatePath(mode, sid, root);
                    try {
                        const content = readFileSync(sessionStatePath, 'utf-8');
                        const state = JSON.parse(content);
                        output += `**Session: ${sid}**\nPath: ${sessionStatePath}\n\n\`\`\`json\n${JSON.stringify(publicStateForMode(mode, state), null, 2)}\n\`\`\`\n\n`;
                    }
                    catch {
                        output += `**Session: ${sid}**\nPath: ${sessionStatePath}\n*Error reading state file*\n\n`;
                    }
                }
            }
            return {
                content: [{
                        type: 'text',
                        text: output
                    }]
            };
        }
        catch (error) {
            return {
                content: [{
                        type: 'text',
                        text: `Error reading state for ${mode}: ${error instanceof Error ? error.message : String(error)}`
                    }],
                isError: true
            };
        }
    }
};
// ============================================================================
// state_write - Write state for a mode
// ============================================================================
export const stateWriteTool = {
    name: 'state_write',
    description: 'Write/update state for a specific mode. Creates the state file and directories if they do not exist. Common fields (active, iteration, phase, etc.) can be set directly as parameters. Additional custom fields can be passed via the optional `state` parameter. Note: swarm uses SQLite and cannot be written via this tool.',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    schema: {
        mode: z.enum(STATE_WRITE_MODES).describe('The mode to write state for'),
        active: z.boolean().optional().describe('Whether the mode is currently active'),
        iteration: z.number().optional().describe('Current iteration number'),
        max_iterations: z.number().optional().describe('Maximum iterations allowed'),
        current_phase: z.string().max(200).optional().describe('Current execution phase'),
        task_description: z.string().max(2000).optional().describe('Description of the task being executed'),
        plan_path: z.string().max(500).optional().describe('Path to the plan file'),
        started_at: z.string().max(100).optional().describe('ISO timestamp when the mode started'),
        completed_at: z.string().max(100).optional().describe('ISO timestamp when the mode completed'),
        error: z.string().max(2000).optional().describe('Error message if the mode failed'),
        state: z.record(z.string(), z.unknown()).optional().describe('Additional custom state fields (merged with explicit parameters)'),
        workingDirectory: z.string().optional().describe('Working directory (defaults to cwd)'),
        session_id: z.string().optional().describe('Session ID for session-scoped state isolation. When provided, the tool operates only within that session. When omitted, the tool aggregates legacy state plus all session-scoped state (may include other sessions).'),
    },
    handler: async (args) => {
        const { mode, active, iteration, max_iterations, current_phase, task_description, plan_path, started_at, completed_at, error, state, workingDirectory, session_id } = args;
        try {
            const root = validateWorkingDirectory(workingDirectory);
            const sessionId = session_id;
            // Validate custom state payload size if provided
            if (state) {
                const validation = validatePayload(state);
                if (!validation.valid) {
                    return {
                        content: [{
                                type: 'text',
                                text: `Error: state payload rejected — ${validation.error}`
                            }],
                        isError: true
                    };
                }
            }
            // Determine state path based on session_id
            let statePath;
            if (sessionId) {
                validateSessionId(sessionId);
                ensureSessionStateDir(sessionId, root);
                statePath = MODE_CONFIGS[mode]
                    ? getStateFilePath(root, mode, sessionId)
                    : resolveSessionStatePath(mode, sessionId, root);
            }
            else {
                ensureOmcDir('state', root);
                statePath = getStatePath(mode, root);
            }
            // Build state from explicit params + custom state
            const builtState = {};
            // Add explicit params (only if provided)
            if (active !== undefined)
                builtState.active = active;
            if (iteration !== undefined)
                builtState.iteration = iteration;
            if (max_iterations !== undefined)
                builtState.max_iterations = max_iterations;
            if (current_phase !== undefined)
                builtState.current_phase = current_phase;
            if (task_description !== undefined)
                builtState.task_description = task_description;
            if (plan_path !== undefined)
                builtState.plan_path = plan_path;
            if (started_at !== undefined)
                builtState.started_at = started_at;
            if (completed_at !== undefined)
                builtState.completed_at = completed_at;
            if (error !== undefined)
                builtState.error = error;
            // Merge custom state fields (explicit params take precedence)
            if (state) {
                for (const [key, value] of Object.entries(state)) {
                    if (!(key in builtState)) {
                        builtState[key] = value;
                    }
                }
            }
            const requestedRunId = typeof builtState.workflowRunId === 'string' ? builtState.workflowRunId : undefined;
            const requestedStateDigest = typeof builtState.target_state_sha256 === 'string' ? builtState.target_state_sha256 : undefined;
            const isExactNamedPause = isExactNamedPauseRequest(builtState);
            if (mode === 'autopilot' && (hasNamedWorkflowMarker(builtState) || hasOwnProperty(builtState, 'target_state_sha256')) && !isExactNamedPause) {
                throw new Error('named autopilot workflow markers are runtime-owned; only active:false with an exact workflowRunId and optional state digest may pause a run');
            }
            // Add metadata
            const stateWithMeta = {
                ...builtState,
                _meta: {
                    mode,
                    sessionId: sessionId || null,
                    updatedAt: new Date().toISOString(),
                    updatedBy: 'state_write_tool'
                }
            };
            let writtenState = stateWithMeta;
            let namedPauseCommitted = false;
            if (mode === 'autopilot' && builtState.active === false) {
                let currentState = null;
                try {
                    currentState = JSON.parse(readFileSync(statePath, 'utf8'));
                }
                catch { /* missing or malformed state is handled below */ }
                if (hasNamedWorkflowMarker(currentState ?? {})) {
                    if (!isExactNamedPause || !requestedRunId) {
                        throw new Error('named autopilot workflow state requires active:false with its exact workflowRunId');
                    }
                    if (namedWorkflowRuntimeSupported()) {
                        const result = writeStateFileLockedIf(statePath, (current) => matchesNamedPauseTarget(current, sessionId, requestedRunId, requestedStateDigest), (current) => ({ ...current, active: false }));
                        if (result !== 'written') {
                            throw new Error(result === 'failed'
                                ? 'state mutation lock unavailable'
                                : 'named autopilot run changed, is stale, or failed integrity validation');
                        }
                        namedPauseCommitted = true;
                    }
                    else {
                        const snapshot = JSON.stringify(currentState);
                        const written = emergencyMutateStateFileIf(statePath, (current) => JSON.stringify(current) === snapshot &&
                            isExactEmergencyNamedMutation(current, requestedRunId) &&
                            (requestedStateDigest === undefined || createHash('sha256').update(JSON.stringify(current)).digest('hex') === requestedStateDigest), (current) => ({ ...current, active: false }));
                        if (!written)
                            throw new Error('autopilot run changed before deactivation');
                        namedPauseCommitted = true;
                    }
                }
                else {
                    const result = writeStateFileLockedCreateIf(statePath, (current) => !hasNamedWorkflowMarker(current), (current) => {
                        writtenState = { ...(current ?? {}), ...stateWithMeta };
                        return writtenState;
                    });
                    if (result !== 'written')
                        throw new Error(result === 'failed' ? 'state mutation lock unavailable' : 'autopilot run changed before deactivation');
                }
            }
            else if (mode === 'autopilot') {
                let namedWorkflowExists = false;
                const result = writeStateFileLockedCreateIf(statePath, (current) => {
                    if (!hasNamedWorkflowMarker(current))
                        return true;
                    namedWorkflowExists = true;
                    return false;
                }, (current) => {
                    writtenState = { ...(current ?? {}), ...stateWithMeta };
                    return writtenState;
                });
                if (result !== 'written') {
                    if (namedWorkflowExists)
                        throw new Error('named autopilot workflow state is runtime-owned; only exact-run deactivation is allowed');
                    throw new Error(result === 'failed' ? 'state mutation lock unavailable' : 'autopilot state changed before write');
                }
            }
            else if (!writeStateFileLocked(statePath, stateWithMeta)) {
                throw new Error('state mutation lock unavailable');
            }
            const sessionInfo = sessionId ? ` (session: ${sessionId})` : ' (legacy path)';
            const warningMessage = sessionId ? '' : '\n\nWARNING: No session_id provided. State written to legacy shared path which may leak across parallel sessions. Pass session_id for session-scoped isolation.';
            return {
                content: [{
                        type: 'text',
                        text: namedPauseCommitted
                            ? `Paused named autopilot workflow${sessionInfo}. Resume state is preserved.`
                            : `Successfully wrote state for ${mode}${sessionInfo}\nPath: ${statePath}\n\n\`\`\`json\n${JSON.stringify(writtenState, null, 2)}\n\`\`\`${warningMessage}`
                    }]
            };
        }
        catch (error) {
            return {
                content: [{
                        type: 'text',
                        text: `Error writing state for ${mode}: ${error instanceof Error ? error.message : String(error)}`
                    }],
                isError: true
            };
        }
    }
};
// ============================================================================
// state_clear - Clear state for a mode
// ============================================================================
function discoverAllRootSessionStateCandidates(mode, root) {
    const paths = new Set();
    const roots = new Set([...getConvergedOmcRoots(root), getWorkingDirectoryLocalOmcRoot(root), getOmcRoot(root)]);
    for (const omcRoot of roots) {
        for (const sid of listSessionIdsUnderOmcRoot(omcRoot)) {
            paths.add(join(omcRoot, 'state', 'sessions', sid, getStateFileName(mode)));
        }
    }
    return discoverStatePaths([...paths]);
}
function recoverAutopilotEmergencyTransactions(root, sessionId) {
    const broadPaths = new Set([
        ...getLegacyStateFileCandidates('autopilot', root),
        ...getWorkingDirectoryLocalStateClearCandidates('autopilot', root),
        ...getConvergedStateCandidates('autopilot', root),
    ]);
    const localOmcRoot = getWorkingDirectoryLocalOmcRoot(root);
    for (const sid of listSessionIdsUnderOmcRoot(localOmcRoot)) {
        broadPaths.add(join(localOmcRoot, 'state', 'sessions', sid, getStateFileName('autopilot')));
    }
    for (const omcRoot of getConvergedOmcRoots(root)) {
        for (const sid of listSessionIdsUnderOmcRoot(omcRoot)) {
            broadPaths.add(join(omcRoot, 'state', 'sessions', sid, getStateFileName('autopilot')));
        }
    }
    const directSessionPaths = new Set();
    if (sessionId) {
        directSessionPaths.add(resolveSessionStatePath('autopilot', sessionId, root));
        directSessionPaths.add(getWorkingDirectoryLocalSessionStatePath('autopilot', root, sessionId));
        for (const omcRoot of getConvergedOmcRoots(root)) {
            directSessionPaths.add(join(omcRoot, 'state', 'sessions', sessionId, getStateFileName('autopilot')));
        }
        for (const path of directSessionPaths)
            broadPaths.add(path);
    }
    for (const path of broadPaths) {
        const recoveryOptions = emergencyRecoveryOptionsForProject('autopilot', path, root);
        if (!isAutopilotRecoveryCandidateForProject(path, root))
            continue;
        if (sessionId && !directSessionPaths.has(path)) {
            const visibleOwner = getStateSessionOwner(readJsonRecord(path) ?? {});
            const journal = readJsonRecord(`${path}.emergency-journal.json`);
            const journalOwner = typeof journal?.sessionOwner === 'string' ? journal.sessionOwner : undefined;
            if (visibleOwner !== sessionId && journalOwner !== sessionId)
                continue;
        }
        if (!recoverEmergencyStateFile(path, recoveryOptions))
            throw new Error(`workflow_emergency_recovery_failed: ${path}`);
        if (recoveryOptions && !isAutopilotRecoveryCandidateForProject(path, root))
            continue;
        const artifactPrefix = `${basename(path)}.emergency-`;
        let artifacts;
        try {
            artifacts = readdirSync(dirname(path)).filter((name) => name.startsWith(artifactPrefix) && !name.endsWith('.recovery.guard'));
        }
        catch {
            artifacts = [];
        }
        if (artifacts.length > 0)
            throw new Error(`workflow_emergency_recovery_failed: ${path}`);
    }
}
export const stateClearTool = {
    name: 'state_clear',
    description: 'Clear/delete state for a specific mode. Removes the state file and any associated marker files. For merge-readiness, cancels an active gate while preserving the terminal audit record (no deletion).',
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    schema: {
        mode: z.enum(STATE_TOOL_MODES).describe('The mode to clear state for'),
        workingDirectory: z.string().optional().describe('Working directory (defaults to cwd)'),
        session_id: z.string().optional().describe('Session ID for session-scoped state isolation. When provided, the tool operates only within that session. When omitted, the tool aggregates legacy state plus all session-scoped state (may include other sessions).'),
    },
    handler: async (args) => {
        const { mode, workingDirectory, session_id } = args;
        try {
            const root = validateWorkingDirectory(workingDirectory);
            const sessionId = session_id;
            // Merge-readiness is an audit gate, so clearing it must leave a durable
            // terminal result and report rather than deleting the evidence trail.
            if (mode === 'merge-readiness') {
                const cancelledSessions = [];
                const blockedSessions = [];
                const cancelActiveSession = (targetSessionId) => {
                    const current = readMergeReadinessState(root, targetSessionId);
                    if (!current?.active)
                        return 'inactive';
                    // cancelMergeReadiness fail-closes to an active blocked state when the
                    // write cannot land; distinguish that from a real cancelled result so
                    // the operator learns the cancel did not persist.
                    return cancelMergeReadiness(root, targetSessionId)?.result === 'cancelled' ? 'cancelled' : 'blocked';
                };
                const recordResult = (sid, status) => {
                    if (status === 'cancelled')
                        cancelledSessions.push(sid);
                    else if (status === 'blocked')
                        blockedSessions.push(sid);
                };
                if (sessionId) {
                    validateSessionId(sessionId);
                    recordResult(sessionId, cancelActiveSession(sessionId));
                }
                else {
                    // Omitting session_id must not cross session boundaries: only cancel
                    // the caller's own session (resolved from env) and legacy state,
                    // never other sessions' active gates.
                    const callerSid = (process.env.CLAUDE_SESSION_ID && process.env.CLAUDE_SESSION_ID.trim()) || resolveSessionId({ context: "cli" });
                    if (callerSid)
                        recordResult(callerSid, cancelActiveSession(callerSid));
                    recordResult('legacy', cancelActiveSession());
                }
                const blocked = blockedSessions.length > 0;
                const text = blocked
                    ? `Merge-readiness cancellation FAILED for: ${blockedSessions.join(', ')}. The state could not be persisted (read-only state dir / full disk); the gate(s) remain active on disk. Resolve and re-run.`
                    : cancelledSessions.length > 0
                        ? `Cancelled merge-readiness gate(s) with durable state audit records: ${cancelledSessions.join(', ')}`
                        : 'No active merge-readiness gate found; existing state audit records were preserved.';
                return {
                    content: [{ type: 'text', text }],
                    ...(blocked ? { isError: true } : {}),
                };
            }
            if (mode === 'autopilot')
                recoverAutopilotEmergencyTransactions(root, sessionId);
            const cleanedTeamNames = new Set();
            const collectTeamNamesForCleanup = (statePath) => {
                if (mode !== 'team')
                    return;
                for (const teamName of readTeamNamesFromStateFile(statePath)) {
                    cleanedTeamNames.add(teamName);
                }
            };
            // If session_id provided, clear only session-specific state
            if (sessionId) {
                validateSessionId(sessionId);
                const requestedSessionCandidates = findSessionOwnedStateCandidates(mode, sessionId, root)
                    .filter((candidate) => isStateCandidateForProject(mode, candidate.path, candidate.state, root));
                const requestedSessionOwnedPaths = requestedSessionCandidates.map((candidate) => candidate.path);
                for (const teamStatePath of findSessionOwnedStateFiles('team', sessionId, root)) {
                    collectTeamNamesForCleanup(teamStatePath);
                }
                if (mode === 'team') {
                    for (const teamStatePath of findCompletedSessionStateFiles('team', root, sessionId)) {
                        collectTeamNamesForCleanup(teamStatePath);
                    }
                }
                const completedCandidates = findCompletedSessionStateCandidates(mode, root, sessionId)
                    .filter((candidate) => isStateCandidateForProject(mode, candidate.path, candidate.state, root));
                const legacyCandidates = discoverStatePaths(getLegacyStateFileCandidates(mode, root)).filter((candidate) => isStateCandidateForProject(mode, candidate.path, candidate.state, root));
                const localCandidates = discoverStatePaths(getWorkingDirectoryLocalStateClearCandidates(mode, root, sessionId))
                    .filter((candidate) => isStateCandidateForProject(mode, candidate.path, candidate.state, root));
                const convergedCandidates = discoverStatePaths(getConvergedStateCandidates(mode, root, sessionId))
                    .filter((candidate) => isStateCandidateForProject(mode, candidate.path, candidate.state, root));
                const operationCandidates = [...new Map([
                        ...requestedSessionCandidates,
                        ...completedCandidates,
                        ...legacyCandidates.filter((candidate) => canClearStateForSession(candidate.state, sessionId)),
                        ...localCandidates.filter((candidate) => canClearStateForSession(candidate.state, sessionId)),
                        ...convergedCandidates.filter((candidate) => canClearStateForSession(candidate.state, sessionId)),
                    ].map((candidate) => [candidate.path, candidate])).values()];
                const directCandidate = requestedSessionCandidates.find((candidate) => candidate.path === resolveSessionStatePath(mode, sessionId, root)) ?? requestedSessionCandidates[0];
                const namedPrimaries = mode === 'autopilot' ? operationCandidates.filter((candidate) => hasNamedWorkflowMarker(candidate.state)) : [];
                const namedPrimaryPaths = new Set(namedPrimaries.map((candidate) => candidate.path));
                let directCleared = 0;
                for (const candidate of namedPrimaries) {
                    const success = clearAutopilotMarkerCandidate(candidate, root);
                    if (!success || existsSync(candidate.path))
                        throw new Error(`primary state mutation failed; dependent state preserved: ${candidate.path}`);
                    directCleared += 1;
                }
                const completedSessionCleanup = clearCompletedSessionStateCandidates(mode, root, sessionId, completedCandidates.filter((candidate) => !namedPrimaryPaths.has(candidate.path)));
                const runtimeCleanup = clearModeRuntimeArtifacts(mode, root, sessionId);
                let convergedCleanup = { cleared: 0, hadFailure: false, paths: [] };
                const sessionSignalCandidates = operationCandidates.filter((candidate) => !hasNamedWorkflowMarker(candidate.state));
                const signaledCandidateDirs = new Set();
                for (const candidate of sessionSignalCandidates) {
                    const signalDir = dirname(candidate.path);
                    if (signaledCandidateDirs.has(signalDir))
                        continue;
                    signaledCandidateDirs.add(signalDir);
                    const now = Date.now();
                    const signalPath = join(signalDir, 'cancel-signal-state.json');
                    const payload = {
                        active: true,
                        requested_at: new Date(now).toISOString(),
                        expires_at: new Date(now + CANCEL_SIGNAL_TTL_MS).toISOString(),
                        mode,
                        source: 'state_clear',
                        ...(candidate.workflowRunId ? { target_workflow_run_id: candidate.workflowRunId } : {}),
                        target_state_sha256: createHash('sha256').update(candidate.snapshot).digest('hex'),
                    };
                    try {
                        writeStateFileLocked(signalPath, payload);
                    }
                    catch { /* best-effort */ }
                }
                if (sessionSignalCandidates.length === 0 && namedPrimaries.length === 0)
                    writeSessionCancelSignal(root, sessionId, mode, directCandidate);
                if (MODE_CONFIGS[mode]) {
                    const expectedDirectState = directCandidate?.state;
                    const success = clearModeState(mode, root, sessionId, expectedDirectState);
                    if (directCandidate && !existsSync(directCandidate.path))
                        directCleared = 1;
                    const sessionCleanup = clearSessionOwnedStateCandidates(mode, root, sessionId, requestedSessionCandidates);
                    const legacyCleanup = clearLegacyStateCandidates(mode, root, sessionId, legacyCandidates);
                    const shouldUseLocalFallback = requestedSessionOwnedPaths.length === 0 &&
                        completedSessionCleanup.cleared === 0 &&
                        sessionCleanup.cleared === 0 &&
                        legacyCleanup.cleared === 0;
                    const workingDirectoryLocalCleanup = shouldUseLocalFallback
                        ? clearWorkingDirectoryLocalStateCandidates(mode, root, sessionId, localCandidates)
                        : { cleared: 0, hadFailure: false, paths: [] };
                    convergedCleanup = clearConvergedStateCandidates(mode, root, sessionId, convergedCandidates);
                    let ownerSessionId;
                    let ownerSessionCleanup = { cleared: 0, hadFailure: false, paths: [] };
                    let ownerLegacyCleanup = { cleared: 0, hadFailure: false };
                    if (OWNER_SESSION_FALLBACK_MODES.has(mode) &&
                        requestedSessionOwnedPaths.length === 0 &&
                        completedCandidates.length === 0 &&
                        legacyCandidates.length === 0 &&
                        completedSessionCleanup.cleared === 0 &&
                        sessionCleanup.cleared === 0 &&
                        legacyCleanup.cleared === 0 &&
                        convergedCleanup.cleared === 0 &&
                        workingDirectoryLocalCleanup.cleared === 0) {
                        ownerSessionId = findSingleOwningSessionForMode(mode, root, sessionId);
                        if (ownerSessionId) {
                            if (mode === 'team') {
                                for (const teamStatePath of findSessionOwnedStateFiles('team', ownerSessionId, root)) {
                                    collectTeamNamesForCleanup(teamStatePath);
                                }
                            }
                            const ownerCandidates = findSessionOwnedStateCandidates(mode, ownerSessionId, root);
                            const ownerDirectCandidate = ownerCandidates.find((candidate) => candidate.path === resolveSessionStatePath(mode, ownerSessionId, root)) ?? ownerCandidates[0];
                            const ownerNamedPrimary = mode === 'autopilot' && ownerDirectCandidate && hasNamedWorkflowMarker(ownerDirectCandidate.state) ? ownerDirectCandidate : undefined;
                            if (ownerNamedPrimary) {
                                const success = clearAutopilotMarkerCandidate(ownerNamedPrimary, root);
                                if (!success || existsSync(ownerNamedPrimary.path))
                                    throw new Error('primary state mutation failed; dependent state preserved');
                            }
                            else {
                                writeSessionCancelSignal(root, ownerSessionId, mode, ownerDirectCandidate);
                                clearModeState(mode, root, ownerSessionId, ownerDirectCandidate?.state);
                            }
                            const ownerRuntimeCleanup = clearModeRuntimeArtifacts(mode, root, ownerSessionId);
                            runtimeCleanup.cleared += ownerRuntimeCleanup.cleared;
                            runtimeCleanup.hadFailure ||= ownerRuntimeCleanup.hadFailure;
                            ownerSessionCleanup = clearSessionOwnedStateCandidates(mode, root, ownerSessionId, ownerCandidates.filter((candidate) => candidate.path !== ownerNamedPrimary?.path));
                            ownerLegacyCleanup = clearLegacyStateCandidates(mode, root, ownerSessionId);
                        }
                    }
                    const ghostNoteParts = [];
                    if (legacyCleanup.cleared > 0) {
                        ghostNoteParts.push('ghost legacy file also removed');
                    }
                    if (completedSessionCleanup.cleared > 0) {
                        ghostNoteParts.push(`removed ${completedSessionCleanup.cleared} completed-session orphan file${completedSessionCleanup.cleared === 1 ? '' : 's'}`);
                    }
                    if (sessionCleanup.cleared > 0) {
                        ghostNoteParts.push(`removed ${sessionCleanup.cleared} recovered session file${sessionCleanup.cleared === 1 ? '' : 's'}`);
                    }
                    if (workingDirectoryLocalCleanup.cleared > 0) {
                        ghostNoteParts.push(`removed ${workingDirectoryLocalCleanup.cleared} workingDirectory-local state file${workingDirectoryLocalCleanup.cleared === 1 ? '' : 's'}`);
                    }
                    if (convergedCleanup.cleared > 0) {
                        ghostNoteParts.push(`removed ${convergedCleanup.cleared} converged state file${convergedCleanup.cleared === 1 ? '' : 's'}`);
                    }
                    if (runtimeCleanup.cleared > 0) {
                        ghostNoteParts.push(`removed ${runtimeCleanup.cleared} runtime artifact${runtimeCleanup.cleared === 1 ? '' : 's'}`);
                    }
                    if (ownerSessionId) {
                        ghostNoteParts.push(`cleared owning session: ${ownerSessionId}`);
                    }
                    const ghostNote = ghostNoteParts.length > 0 ? ` (${ghostNoteParts.join(', ')})` : '';
                    const runtimeCleanupNote = (() => {
                        if (mode !== 'team')
                            return '';
                        const teamNames = [...cleanedTeamNames];
                        const removedRoots = cleanupTeamRuntimeState(root, teamNames);
                        const prunedMissions = pruneMissionBoardTeams(root, teamNames);
                        const details = [];
                        if (removedRoots > 0)
                            details.push(`removed ${removedRoots} team runtime root(s)`);
                        if (prunedMissions > 0)
                            details.push(`pruned ${prunedMissions} HUD mission entry(ies)`);
                        return details.length > 0 ? ` (${details.join(', ')})` : '';
                    })();
                    const clearedStateOrArtifacts = directCleared + completedSessionCleanup.cleared +
                        sessionCleanup.cleared +
                        legacyCleanup.cleared +
                        convergedCleanup.cleared +
                        workingDirectoryLocalCleanup.cleared +
                        ownerSessionCleanup.cleared +
                        ownerLegacyCleanup.cleared +
                        runtimeCleanup.cleared;
                    const capturedCleanupIncomplete = operationCandidates.some((candidate) => existsSync(candidate.path));
                    if (!ownerSessionId && clearedStateOrArtifacts === 0 && success &&
                        !capturedCleanupIncomplete &&
                        !legacyCleanup.hadFailure &&
                        !sessionCleanup.hadFailure &&
                        !workingDirectoryLocalCleanup.hadFailure &&
                        !convergedCleanup.hadFailure &&
                        !completedSessionCleanup.hadFailure &&
                        !ownerSessionCleanup.hadFailure &&
                        !ownerLegacyCleanup.hadFailure &&
                        !runtimeCleanup.hadFailure) {
                        return {
                            content: [{
                                    type: 'text',
                                    text: formatStateClearNoopMessage(mode, root, sessionId)
                                }]
                        };
                    }
                    if (!capturedCleanupIncomplete &&
                        success &&
                        !legacyCleanup.hadFailure &&
                        !sessionCleanup.hadFailure &&
                        !workingDirectoryLocalCleanup.hadFailure &&
                        !convergedCleanup.hadFailure &&
                        !completedSessionCleanup.hadFailure &&
                        !ownerSessionCleanup.hadFailure &&
                        !ownerLegacyCleanup.hadFailure &&
                        !runtimeCleanup.hadFailure) {
                        return {
                            content: [{
                                    type: 'text',
                                    text: `Successfully cleared state for mode: ${mode} in session: ${sessionId}${ghostNote}${runtimeCleanupNote}`
                                }]
                        };
                    }
                    else {
                        return {
                            content: [{
                                    type: 'text',
                                    text: `Warning: Some files could not be removed for mode: ${mode} in session: ${sessionId}${ghostNote}${runtimeCleanupNote}`
                                }],
                            isError: true,
                        };
                    }
                }
                // Fallback for modes not in registry (e.g., ralplan)
                const sessionCleanup = clearSessionOwnedStateCandidates(mode, root, sessionId, requestedSessionCandidates);
                const legacyCleanup = clearLegacyStateCandidates(mode, root, sessionId, legacyCandidates);
                const shouldUseLocalFallback = requestedSessionOwnedPaths.length === 0 &&
                    completedSessionCleanup.cleared === 0 &&
                    sessionCleanup.cleared === 0 &&
                    legacyCleanup.cleared === 0;
                const workingDirectoryLocalCleanup = shouldUseLocalFallback
                    ? clearWorkingDirectoryLocalStateCandidates(mode, root, sessionId, localCandidates)
                    : { cleared: 0, hadFailure: false, paths: [] };
                convergedCleanup = clearConvergedStateCandidates(mode, root, sessionId, convergedCandidates);
                let ownerSessionId;
                let ownerSessionCleanup = { cleared: 0, hadFailure: false, paths: [] };
                let ownerLegacyCleanup = { cleared: 0, hadFailure: false };
                if (OWNER_SESSION_FALLBACK_MODES.has(mode) &&
                    requestedSessionOwnedPaths.length === 0 &&
                    completedCandidates.length === 0 &&
                    legacyCandidates.length === 0 &&
                    completedSessionCleanup.cleared === 0 &&
                    sessionCleanup.cleared === 0 &&
                    legacyCleanup.cleared === 0 &&
                    convergedCleanup.cleared === 0 &&
                    workingDirectoryLocalCleanup.cleared === 0) {
                    ownerSessionId = findSingleOwningSessionForMode(mode, root, sessionId);
                    if (ownerSessionId) {
                        if (mode === 'team') {
                            for (const teamStatePath of findSessionOwnedStateFiles('team', ownerSessionId, root)) {
                                collectTeamNamesForCleanup(teamStatePath);
                            }
                        }
                        const ownerCandidates = findSessionOwnedStateCandidates(mode, ownerSessionId, root);
                        if (mode === 'autopilot' && ownerCandidates.some((candidate) => hasNamedWorkflowMarker(candidate.state)) && !namedWorkflowRuntimeSupported()) {
                            throw new Error('unsupported-runtime');
                        }
                        const ownerDirectCandidate = ownerCandidates.find((candidate) => candidate.path === resolveSessionStatePath(mode, ownerSessionId, root)) ?? ownerCandidates[0];
                        writeSessionCancelSignal(root, ownerSessionId, mode, ownerDirectCandidate);
                        const ownerRuntimeCleanup = clearModeRuntimeArtifacts(mode, root, ownerSessionId);
                        runtimeCleanup.cleared += ownerRuntimeCleanup.cleared;
                        runtimeCleanup.hadFailure ||= ownerRuntimeCleanup.hadFailure;
                        ownerSessionCleanup = clearSessionOwnedStateCandidates(mode, root, ownerSessionId, ownerCandidates);
                        ownerLegacyCleanup = clearLegacyStateCandidates(mode, root, ownerSessionId);
                    }
                }
                const ghostNoteParts = [];
                if (legacyCleanup.cleared > 0) {
                    ghostNoteParts.push('ghost legacy file also removed');
                }
                if (completedSessionCleanup.cleared > 0) {
                    ghostNoteParts.push(`removed ${completedSessionCleanup.cleared} completed-session orphan file${completedSessionCleanup.cleared === 1 ? '' : 's'}`);
                }
                if (sessionCleanup.cleared > 0) {
                    ghostNoteParts.push(`removed ${sessionCleanup.cleared} recovered session file${sessionCleanup.cleared === 1 ? '' : 's'}`);
                }
                if (workingDirectoryLocalCleanup.cleared > 0) {
                    ghostNoteParts.push(`removed ${workingDirectoryLocalCleanup.cleared} workingDirectory-local state file${workingDirectoryLocalCleanup.cleared === 1 ? '' : 's'}`);
                }
                if (convergedCleanup.cleared > 0) {
                    ghostNoteParts.push(`removed ${convergedCleanup.cleared} converged state file${convergedCleanup.cleared === 1 ? '' : 's'}`);
                }
                if (runtimeCleanup.cleared > 0) {
                    ghostNoteParts.push(`removed ${runtimeCleanup.cleared} runtime artifact${runtimeCleanup.cleared === 1 ? '' : 's'}`);
                }
                if (ownerSessionId) {
                    ghostNoteParts.push(`cleared owning session: ${ownerSessionId}`);
                }
                const ghostNote = ghostNoteParts.length > 0 ? ` (${ghostNoteParts.join(', ')})` : '';
                const runtimeCleanupNote = (() => {
                    if (mode !== 'team')
                        return '';
                    const teamNames = [...cleanedTeamNames];
                    const removedRoots = cleanupTeamRuntimeState(root, teamNames);
                    const prunedMissions = pruneMissionBoardTeams(root, teamNames);
                    const details = [];
                    if (removedRoots > 0)
                        details.push(`removed ${removedRoots} team runtime root(s)`);
                    if (prunedMissions > 0)
                        details.push(`pruned ${prunedMissions} HUD mission entry(ies)`);
                    return details.length > 0 ? ` (${details.join(', ')})` : '';
                })();
                const clearedStateOrArtifacts = completedSessionCleanup.cleared +
                    sessionCleanup.cleared +
                    legacyCleanup.cleared +
                    convergedCleanup.cleared +
                    workingDirectoryLocalCleanup.cleared +
                    ownerSessionCleanup.cleared +
                    ownerLegacyCleanup.cleared +
                    runtimeCleanup.cleared;
                const capturedCleanupIncomplete = operationCandidates.some((candidate) => existsSync(candidate.path));
                const hadFailure = capturedCleanupIncomplete || legacyCleanup.hadFailure || sessionCleanup.hadFailure ||
                    workingDirectoryLocalCleanup.hadFailure || convergedCleanup.hadFailure ||
                    completedSessionCleanup.hadFailure || ownerSessionCleanup.hadFailure ||
                    ownerLegacyCleanup.hadFailure || runtimeCleanup.hadFailure;
                if (!ownerSessionId && clearedStateOrArtifacts === 0 && !hadFailure) {
                    return {
                        content: [{
                                type: 'text',
                                text: formatStateClearNoopMessage(mode, root, sessionId)
                            }]
                    };
                }
                return {
                    content: [{
                            type: 'text',
                            text: `${hadFailure ? 'Warning: Some files could not be removed' : 'Successfully cleared state'} for mode: ${mode} in session: ${sessionId}${ghostNote}${runtimeCleanupNote}`
                        }],
                    ...(hadFailure ? { isError: true } : {}),
                };
            }
            // No session_id: clear from all locations (legacy + all sessions)
            // Write cancel signals FIRST (before deleting files) so the stop hook's
            // isSessionCancelInProgress check sees the signal during the deletion window.
            // Mirrors the session_id path at line ~403. (patch: fix missing cancel signal)
            const broadLegacyCandidates = discoverStatePaths(getLegacyStateFileCandidates(mode, root)).filter((candidate) => isStateCandidateForProject(mode, candidate.path, candidate.state, root));
            const broadSessionCandidates = [...new Map([
                    ...listSessionIds(root).flatMap((sid) => findSessionOwnedStateCandidates(mode, sid, root)),
                    ...discoverAllRootSessionStateCandidates(mode, root),
                ].map((candidate) => [candidate.path, candidate])).values()]
                .filter((candidate) => isStateCandidateForProject(mode, candidate.path, candidate.state, root));
            const broadConvergedCandidates = discoverStatePaths(getConvergedStateCandidates(mode, root))
                .filter((candidate) => isStateCandidateForProject(mode, candidate.path, candidate.state, root));
            const broadOperationCandidates = [...new Map([
                    ...broadLegacyCandidates,
                    ...broadSessionCandidates,
                    ...broadConvergedCandidates,
                ].map((candidate) => [candidate.path, candidate])).values()];
            const broadNamedPrimaries = mode === 'autopilot' ? broadOperationCandidates.filter((candidate) => hasNamedWorkflowMarker(candidate.state)) : [];
            for (const candidate of broadNamedPrimaries) {
                const success = clearAutopilotMarkerCandidate(candidate, root);
                if (!success || existsSync(candidate.path))
                    throw new Error(`primary state mutation failed; dependent state preserved: ${candidate.path}`);
            }
            const broadLegacySignalCandidates = broadLegacyCandidates.filter((candidate) => !hasNamedWorkflowMarker(candidate.state));
            const broadSessionSignalCandidates = broadSessionCandidates.filter((candidate) => !hasNamedWorkflowMarker(candidate.state));
            if (broadLegacySignalCandidates.length > 0 || broadSessionSignalCandidates.length > 0) {
                const now = Date.now();
                const cancelSignalPayload = {
                    active: true,
                    requested_at: new Date(now).toISOString(),
                    expires_at: new Date(now + CANCEL_SIGNAL_TTL_MS).toISOString(),
                    mode,
                    source: 'state_clear',
                };
                const signaledLegacyDirs = new Set();
                for (const legacyCandidate of broadLegacySignalCandidates) {
                    const signalDir = dirname(legacyCandidate.path);
                    if (signaledLegacyDirs.has(signalDir))
                        continue;
                    signaledLegacyDirs.add(signalDir);
                    const legacySignalPath = join(signalDir, 'cancel-signal-state.json');
                    const legacyPayload = {
                        ...cancelSignalPayload,
                        ...(legacyCandidate.workflowRunId ? { target_workflow_run_id: legacyCandidate.workflowRunId } : {}),
                        target_state_sha256: createHash('sha256').update(legacyCandidate.snapshot).digest('hex'),
                    };
                    try {
                        writeStateFileLocked(legacySignalPath, legacyPayload);
                    }
                    catch { /* best-effort */ }
                }
                const signaledOwners = new Set();
                for (const candidate of broadSessionSignalCandidates) {
                    const owner = candidate.ownerSessionId;
                    if (!owner || signaledOwners.has(owner))
                        continue;
                    signaledOwners.add(owner);
                    try {
                        writeSessionCancelSignal(root, owner, mode, candidate);
                    }
                    catch { /* best-effort */ }
                }
            }
            const runtimeCleanup = clearModeRuntimeArtifacts(mode, root);
            let clearedCount = 0;
            const errors = [];
            if (mode === 'team') {
                collectTeamNamesForCleanup(getStateFilePath(root, 'team'));
            }
            // Clear legacy path
            if (MODE_CONFIGS[mode]) {
                const primaryLegacyStatePath = getStateFilePath(root, mode);
                const primaryCandidate = broadLegacyCandidates.find((candidate) => candidate.path === primaryLegacyStatePath);
                if (primaryCandidate) {
                    const success = clearModeState(mode, root, undefined, primaryCandidate.state);
                    if (success && !existsSync(primaryCandidate.path)) {
                        clearedCount++;
                    }
                    else if (existsSync(primaryCandidate.path)) {
                        errors.push('legacy path skipped');
                    }
                    else if (!success) {
                        errors.push('legacy path');
                    }
                }
            }
            const extraLegacyCleanup = clearLegacyStateCandidates(mode, root, undefined, broadLegacyCandidates);
            clearedCount += extraLegacyCleanup.cleared;
            if (extraLegacyCleanup.hadFailure) {
                errors.push('legacy path');
            }
            const convergedCleanup = clearConvergedStateCandidates(mode, root, undefined, broadConvergedCandidates);
            clearedCount += convergedCleanup.cleared;
            if (convergedCleanup.hadFailure) {
                errors.push('converged paths');
            }
            clearedCount += runtimeCleanup.cleared;
            if (runtimeCleanup.hadFailure) {
                errors.push('runtime artifacts');
            }
            const processedBroadPaths = new Set([
                ...broadLegacyCandidates.map((candidate) => candidate.path),
                ...broadConvergedCandidates.map((candidate) => candidate.path),
            ]);
            // Clear each captured session candidate by its exact discovered path.
            for (const candidate of broadSessionCandidates) {
                if (processedBroadPaths.has(candidate.path))
                    continue;
                processedBroadPaths.add(candidate.path);
                if (mode === 'team')
                    collectTeamNamesForCleanup(candidate.path);
                const result = clearDiscoveredStateCandidate(candidate, (current) => isStateCandidateForProject(mode, candidate.path, current, root), emergencyRecoveryOptionsForProject(mode, candidate.path, root));
                if (result === 'cleared') {
                    clearedCount++;
                }
                else if (result === 'failed' || existsSync(candidate.path)) {
                    errors.push(`session candidate: ${candidate.path}`);
                }
            }
            const broadCapturedCandidates = [...new Map([
                    ...broadLegacyCandidates,
                    ...broadConvergedCandidates,
                    ...broadSessionCandidates,
                ].map((candidate) => [candidate.path, candidate])).values()];
            for (const candidate of broadCapturedCandidates) {
                if (existsSync(candidate.path) && !errors.some((error) => error.includes(candidate.path))) {
                    errors.push(`captured candidate survived: ${candidate.path}`);
                }
            }
            clearedCount = broadCapturedCandidates.filter((candidate) => !existsSync(candidate.path)).length + runtimeCleanup.cleared;
            let removedTeamRoots = 0;
            let prunedMissionEntries = 0;
            if (mode === 'team') {
                const teamNames = [...cleanedTeamNames];
                const removeSelector = teamNames.length > 0 ? teamNames : undefined;
                removedTeamRoots = cleanupTeamRuntimeState(root, removeSelector);
                prunedMissionEntries = pruneMissionBoardTeams(root, removeSelector);
            }
            if (clearedCount === 0 && errors.length === 0 && removedTeamRoots === 0 && prunedMissionEntries === 0) {
                return {
                    content: [{
                            type: 'text',
                            text: formatStateClearNoopMessage(mode, root)
                        }]
                };
            }
            let message = `Cleared state for mode: ${mode}\n- Locations cleared: ${clearedCount}`;
            if (errors.length > 0) {
                message += `\n- Errors: ${errors.join(', ')}`;
            }
            if (mode === 'team') {
                if (removedTeamRoots > 0) {
                    message += `\n- Team runtime roots removed: ${removedTeamRoots}`;
                }
                if (prunedMissionEntries > 0) {
                    message += `\n- HUD mission entries pruned: ${prunedMissionEntries}`;
                }
            }
            message += '\nWARNING: No session_id provided. Cleared legacy plus all session-scoped state; this is a broad operation that may affect other sessions.';
            return {
                content: [{
                        type: 'text',
                        text: message
                    }],
                ...(errors.length > 0 ? { isError: true } : {})
            };
        }
        catch (error) {
            return {
                content: [{
                        type: 'text',
                        text: `Error clearing state for ${mode}: ${error instanceof Error ? error.message : String(error)}`
                    }],
                isError: true
            };
        }
    }
};
// ============================================================================
// state_list_active - List all active modes
// ============================================================================
export const stateListActiveTool = {
    name: 'state_list_active',
    description: 'List all currently active modes. By default, scopes to the current session (OMC_SESSION_ID). Pass all:true to list active modes across all sessions.',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    schema: {
        workingDirectory: z.string().optional().describe('Working directory (defaults to cwd)'),
        session_id: z.string().optional().describe('Explicit session ID to scope the listing. Overrides OMC_SESSION_ID when provided.'),
        all: z.boolean().optional().describe('When true, list active modes across all sessions (legacy + every session-scoped dir). Overrides the default current-session scope.'),
    },
    handler: async (args) => {
        const { workingDirectory, session_id, all } = args;
        try {
            const root = validateWorkingDirectory(workingDirectory);
            // Resolve the effective session ID:
            //   1. Explicit session_id arg wins (back-compat for callers that pass it directly).
            //   2. all:true opts out of session scoping entirely → show everything.
            //   3. Otherwise default to the current session via resolveSessionId({context:'cli'}).
            const explicitSessionId = session_id;
            const showAll = all === true;
            const sessionId = explicitSessionId
                ?? (showAll ? undefined : resolveSessionId({ context: 'cli' }));
            // If session_id resolved (explicit or current session), show modes for that session
            if (sessionId) {
                validateSessionId(sessionId);
                // Get active modes from registry for this session
                const activeModes = [...getActiveModes(root, sessionId)];
                for (const mode of EXTRA_STATE_ONLY_MODES) {
                    try {
                        const statePath = resolveSessionStatePath(mode, sessionId, root);
                        if (existsSync(statePath)) {
                            const content = readFileSync(statePath, 'utf-8');
                            const state = JSON.parse(content);
                            if (state.active) {
                                activeModes.push(mode);
                            }
                        }
                    }
                    catch {
                        // Ignore parse errors
                    }
                }
                for (const mode of CONVERGED_STATE_PATH_MODES) {
                    if (!activeModes.includes(mode) && hasActiveConvergedState(mode, root, sessionId)) {
                        activeModes.push(mode);
                    }
                }
                if (activeModes.length === 0) {
                    return {
                        content: [{
                                type: 'text',
                                text: `## Active Modes (session: ${sessionId})\n\nNo modes are currently active in this session.`
                            }]
                    };
                }
                const modeList = activeModes.map(mode => `- **${mode}**`).join('\n');
                return {
                    content: [{
                            type: 'text',
                            text: `## Active Modes (session: ${sessionId}, ${activeModes.length})\n\n${modeList}`
                        }]
                };
            }
            // No session_id: show all active modes across all sessions
            const modeSessionMap = new Map();
            // Check legacy paths
            const legacyActiveModes = [...getActiveModes(root)];
            for (const mode of EXTRA_STATE_ONLY_MODES) {
                const statePath = getStatePath(mode, root);
                if (existsSync(statePath)) {
                    try {
                        const content = readFileSync(statePath, 'utf-8');
                        const state = JSON.parse(content);
                        if (state.active) {
                            legacyActiveModes.push(mode);
                        }
                    }
                    catch {
                        // Ignore parse errors
                    }
                }
            }
            for (const mode of CONVERGED_STATE_PATH_MODES) {
                if (!legacyActiveModes.includes(mode) && hasActiveConvergedState(mode, root)) {
                    legacyActiveModes.push(mode);
                }
            }
            for (const mode of legacyActiveModes) {
                if (!modeSessionMap.has(mode)) {
                    modeSessionMap.set(mode, []);
                }
                modeSessionMap.get(mode).push('legacy');
            }
            // Check all sessions
            const sessionIds = listSessionIds(root);
            for (const sid of sessionIds) {
                const sessionActiveModes = [...getActiveModes(root, sid)];
                for (const mode of EXTRA_STATE_ONLY_MODES) {
                    try {
                        const statePath = resolveSessionStatePath(mode, sid, root);
                        if (existsSync(statePath)) {
                            const content = readFileSync(statePath, 'utf-8');
                            const state = JSON.parse(content);
                            if (state.active) {
                                sessionActiveModes.push(mode);
                            }
                        }
                    }
                    catch {
                        // Ignore parse errors
                    }
                }
                for (const mode of sessionActiveModes) {
                    if (!modeSessionMap.has(mode)) {
                        modeSessionMap.set(mode, []);
                    }
                    modeSessionMap.get(mode).push(sid);
                }
            }
            if (modeSessionMap.size === 0) {
                return {
                    content: [{
                            type: 'text',
                            text: '## Active Modes\n\nNo modes are currently active.'
                        }]
                };
            }
            const lines = [`## Active Modes (${modeSessionMap.size})\n`];
            for (const [mode, sessions] of Array.from(modeSessionMap.entries())) {
                lines.push(`- **${mode}** (${sessions.join(', ')})`);
            }
            return {
                content: [{
                        type: 'text',
                        text: lines.join('\n')
                    }]
            };
        }
        catch (error) {
            return {
                content: [{
                        type: 'text',
                        text: `Error listing active modes: ${error instanceof Error ? error.message : String(error)}`
                    }],
                isError: true
            };
        }
    }
};
// ============================================================================
// state_get_status - Get detailed status for a mode
// ============================================================================
export const stateGetStatusTool = {
    name: 'state_get_status',
    description: 'Get detailed status for a specific mode or all modes. Shows active status, file paths, and state contents.',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    schema: {
        mode: z.enum(STATE_TOOL_MODES).optional().describe('Specific mode to check (omit for all modes)'),
        workingDirectory: z.string().optional().describe('Working directory (defaults to cwd)'),
        session_id: z.string().optional().describe('Session ID for session-scoped state isolation. When provided, the tool operates only within that session. When omitted, the tool aggregates legacy state plus all session-scoped state (may include other sessions).'),
    },
    handler: async (args) => {
        const { mode, workingDirectory, session_id } = args;
        try {
            const root = validateWorkingDirectory(workingDirectory);
            const sessionId = session_id;
            if (mode) {
                // Single mode status
                const lines = [`## Status: ${mode}\n`];
                if (sessionId) {
                    // Session-specific status
                    validateSessionId(sessionId);
                    const statePath = MODE_CONFIGS[mode]
                        ? getStateFilePath(root, mode, sessionId)
                        : resolveSessionStatePath(mode, sessionId, root);
                    const active = MODE_CONFIGS[mode]
                        ? isModeActive(mode, root, sessionId)
                        : existsSync(statePath) && (() => {
                            try {
                                const content = readFileSync(statePath, 'utf-8');
                                const state = JSON.parse(content);
                                return state.active === true;
                            }
                            catch {
                                return false;
                            }
                        })();
                    let statePreview = 'No state file';
                    if (existsSync(statePath)) {
                        try {
                            const content = readFileSync(statePath, 'utf-8');
                            const state = JSON.parse(content);
                            statePreview = JSON.stringify(publicStateForMode(mode, state), null, 2).slice(0, 500);
                            if (statePreview.length >= 500)
                                statePreview += '\n...(truncated)';
                        }
                        catch {
                            statePreview = 'Error reading state file';
                        }
                    }
                    lines.push(`### Session: ${sessionId}`);
                    lines.push(`- **Active:** ${active ? 'Yes' : 'No'}`);
                    lines.push(`- **State Path:** ${statePath}`);
                    lines.push(`- **Exists:** ${existsSync(statePath) ? 'Yes' : 'No'}`);
                    lines.push(`\n### State Preview\n\`\`\`json\n${statePreview}\n\`\`\``);
                    return {
                        content: [{
                                type: 'text',
                                text: lines.join('\n')
                            }]
                    };
                }
                // No session_id: show all sessions + legacy
                const legacyPath = getStatePath(mode, root);
                const legacyActive = MODE_CONFIGS[mode]
                    ? isModeActive(mode, root)
                    : existsSync(legacyPath) && (() => {
                        try {
                            const content = readFileSync(legacyPath, 'utf-8');
                            const state = JSON.parse(content);
                            return state.active === true;
                        }
                        catch {
                            return false;
                        }
                    })();
                lines.push(`### Legacy Path`);
                lines.push(`- **Active:** ${legacyActive ? 'Yes' : 'No'}`);
                lines.push(`- **State Path:** ${legacyPath}`);
                lines.push(`- **Exists:** ${existsSync(legacyPath) ? 'Yes' : 'No'}\n`);
                // Show active sessions for this mode
                const activeSessions = MODE_CONFIGS[mode]
                    ? getActiveSessionsForMode(mode, root)
                    : listSessionIds(root).filter(sid => {
                        try {
                            const sessionPath = resolveSessionStatePath(mode, sid, root);
                            if (existsSync(sessionPath)) {
                                const content = readFileSync(sessionPath, 'utf-8');
                                const state = JSON.parse(content);
                                return state.active === true;
                            }
                            return false;
                        }
                        catch {
                            return false;
                        }
                    });
                if (activeSessions.length > 0) {
                    lines.push(`### Active Sessions (${activeSessions.length})`);
                    for (const sid of activeSessions) {
                        lines.push(`- ${sid}`);
                    }
                }
                else {
                    lines.push(`### Active Sessions\nNo active sessions for this mode.`);
                }
                return {
                    content: [{
                            type: 'text',
                            text: lines.join('\n')
                        }]
                };
            }
            // All modes status
            const statuses = getAllModeStatuses(root, sessionId);
            const lines = sessionId
                ? [`## All Mode Statuses (session: ${sessionId})\n`]
                : ['## All Mode Statuses\n'];
            for (const status of statuses) {
                const icon = status.active ? '[ACTIVE]' : '[INACTIVE]';
                lines.push(`${icon} **${status.mode}**: ${status.active ? 'Active' : 'Inactive'}`);
                lines.push(`   Path: \`${status.stateFilePath}\``);
                // Show active sessions if no specific session_id
                if (!sessionId && MODE_CONFIGS[status.mode]) {
                    const activeSessions = getActiveSessionsForMode(status.mode, root);
                    if (activeSessions.length > 0) {
                        lines.push(`   Active sessions: ${activeSessions.join(', ')}`);
                    }
                }
            }
            // Also check extra state-only modes (not in MODE_CONFIGS)
            for (const mode of EXTRA_STATE_ONLY_MODES) {
                const statePath = sessionId
                    ? resolveSessionStatePath(mode, sessionId, root)
                    : getStatePath(mode, root);
                let active = false;
                if (existsSync(statePath)) {
                    try {
                        const content = readFileSync(statePath, 'utf-8');
                        const state = JSON.parse(content);
                        active = state.active === true;
                    }
                    catch {
                        // Ignore parse errors
                    }
                }
                const icon = active ? '[ACTIVE]' : '[INACTIVE]';
                lines.push(`${icon} **${mode}**: ${active ? 'Active' : 'Inactive'}`);
                lines.push(`   Path: \`${statePath}\``);
            }
            return {
                content: [{
                        type: 'text',
                        text: lines.join('\n')
                    }]
            };
        }
        catch (error) {
            return {
                content: [{
                        type: 'text',
                        text: `Error getting status: ${error instanceof Error ? error.message : String(error)}`
                    }],
                isError: true
            };
        }
    }
};
/**
 * All state tools for registration
 */
export const stateTools = [
    stateReadTool,
    stateWriteTool,
    stateClearTool,
    stateListActiveTool,
    stateGetStatusTool,
    {
        name: 'merge_readiness_start',
        description: 'Initialize a merge-readiness gate session for the current change. Call this first, before merge_readiness_set_content. The depth profile is parsed from the summary (--quick or --deep; standard is the default when neither flag is present). Re-running it while an active attempt is still pending is rejected - cancel via merge_readiness_cancel or let the attempt pass/pause first, so the in-progress audit trail is never silently overwritten.',
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
        schema: {
            summary: z.string().max(2000),
            baseRef: z.string().max(200).regex(/^[A-Za-z0-9._\/@{}~^:-]+$/, "baseRef must be a valid git ref").refine((s) => !s.startsWith("-"), "baseRef must not start with '-'").optional().describe("Base ref to diff committed changes against (e.g. origin/dev, HEAD, HEAD~1, HEAD^). Defaults to the branch upstream / origin/HEAD."),
            workingDirectory: z.string().optional(), session_id: z.string().optional(),
        },
        handler: async (args) => {
            try {
                const directory = validateWorkingDirectory(args.workingDirectory || process.cwd());
                const sessionId = (args.session_id && args.session_id.trim()) || (process.env.CLAUDE_SESSION_ID && process.env.CLAUDE_SESSION_ID.trim()) || resolveSessionId({ context: "cli" });
                const state = createInitialMergeReadinessState(directory, args.summary, sessionId, args.baseRef);
                const blocked = state.result === 'blocked';
                return { content: [{ type: 'text', text: blocked ? `Merge-readiness blocked: ${state.validation_errors?.join(' ') ?? 'missing evidence'}` : `Merge-readiness started (profile: ${state.profile}, threshold: ${state.threshold}, max rounds: ${state.max_rounds}). Awaiting content via merge_readiness_set_content.` }], ...(blocked ? { isError: true } : {}) };
            }
            catch (error) {
                return { content: [{ type: 'text', text: `Merge-readiness error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
            }
        },
    },
    {
        name: 'merge_readiness_set_content',
        description: 'Validate and submit the five-section merge-readiness report and objective MCQs. Requires an active gate (call merge_readiness_start first).',
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
        schema: {
            why: z.string().max(10000), whatChanged: z.string().max(10000), tradeoffs: z.string().max(10000), risksConsidered: z.string().max(10000), teamUnderstanding: z.string().max(10000),
            questions: z.array(z.object({ id: z.string().max(100), dimension: z.enum(['why', 'change', 'tradeoff', 'risk', 'team']), stem: z.string().max(2000), options: z.array(z.object({ id: z.string().max(100), text: z.string().max(1000) })).max(8), correctOptionId: z.string().max(100), rationale: z.string().max(2000).optional() })).max(8),
            workingDirectory: z.string().optional(), session_id: z.string().optional(),
        },
        handler: async (args) => {
            try {
                const directory = validateWorkingDirectory(args.workingDirectory || process.cwd());
                const sessionId = (args.session_id && args.session_id.trim()) || (process.env.CLAUDE_SESSION_ID && process.env.CLAUDE_SESSION_ID.trim()) || resolveSessionId({ context: "cli" });
                const state = setMergeReadinessContent(directory, args, sessionId);
                if (!state || !state.active) {
                    return { content: [{ type: 'text', text: 'Merge-readiness content rejected: no active gate (the gate is missing or already terminal - pass/cancelled/overridden). Call merge_readiness_start first.' }], isError: true };
                }
                const errors = state.validation_errors ?? [];
                return { content: [{ type: 'text', text: errors.length > 0 ? `Merge-readiness content rejected: ${errors.join(' ')}` : `Merge-readiness content accepted. Next question: ${state.pending_question?.id ?? 'none'}` }], ...(errors.length > 0 ? { isError: true } : {}) };
            }
            catch (error) {
                return { content: [{ type: 'text', text: `Merge-readiness error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
            }
        },
    },
    {
        name: 'merge_readiness_record_answer',
        description: 'Record the human-selected option for the current merge-readiness MCQ. Advances the gate; returns the next question or the final result plus readiness score.',
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
        schema: {
            questionId: z.string().max(100),
            optionId: z.string().max(100),
            workingDirectory: z.string().optional(), session_id: z.string().optional(),
        },
        handler: async (args) => {
            try {
                const directory = validateWorkingDirectory(args.workingDirectory || process.cwd());
                const sessionId = (args.session_id && args.session_id.trim()) || (process.env.CLAUDE_SESSION_ID && process.env.CLAUDE_SESSION_ID.trim()) || resolveSessionId({ context: "cli" });
                const state = recordMergeReadinessMCQAnswer(directory, args.questionId, args.optionId, sessionId);
                if (!state) {
                    return { content: [{ type: 'text', text: 'Merge-readiness answer rejected: no active gate, or the questionId/optionId does not match the current MCQ.' }], isError: true };
                }
                const result = state.result;
                const score = state.readiness_score;
                const persistFailed = result === 'blocked' && (state.validation_errors ?? []).some((e) => e.includes('persisted'));
                const text = persistFailed
                    ? `Merge-readiness answer NOT recorded: state could not be persisted (read-only state dir / full disk / invalid path). The gate is still armed on disk. ${(state.validation_errors ?? []).join(' ')}`
                    : result === 'pass' || result === 'paused' || result === 'blocked' || result === 'overridden'
                        ? `Merge-readiness ${result}. Readiness score: ${score}. ${result === 'pass' ? 'The change may proceed to human merge approval.' : result === 'paused' ? 'Explanation gap remains; reread the report and rerun /merge-readiness.' : result === 'blocked' ? 'Missing evidence; produce it before rerunning.' : 'Gate overridden; terminal session state preserves the record.'}`
                        : `Answer recorded. Next question: ${state.pending_question?.id ?? 'none'}. Answered: ${state.answers.length}/${state.questions.length}.`;
                return { content: [{ type: 'text', text }], ...(persistFailed ? { isError: true } : {}) };
            }
            catch (error) {
                return { content: [{ type: 'text', text: `Merge-readiness error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
            }
        },
    },
    {
        name: 'merge_readiness_report',
        description: 'Render the authoritative merge-readiness session state as a Markdown report without writing a file.',
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        schema: { workingDirectory: z.string().optional(), session_id: z.string().optional() },
        handler: async (args) => {
            try {
                const directory = validateWorkingDirectory(args.workingDirectory || process.cwd());
                const sessionId = (args.session_id && args.session_id.trim()) || (process.env.CLAUDE_SESSION_ID && process.env.CLAUDE_SESSION_ID.trim()) || resolveSessionId({ context: 'cli' });
                const state = readMergeReadinessState(directory, sessionId);
                if (!state) {
                    return { content: [{ type: 'text', text: 'Merge-readiness report unavailable: no session state found.' }], isError: true };
                }
                return { content: [{ type: 'text', text: formatMergeReadinessReport(state) }] };
            }
            catch (error) {
                return { content: [{ type: 'text', text: `Merge-readiness error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
            }
        },
    },
    {
        name: 'merge_readiness_cancel',
        description: 'Cancel an active merge-readiness gate while preserving its terminal state audit record.',
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        schema: { workingDirectory: z.string().optional(), session_id: z.string().optional() },
        handler: async (args) => {
            try {
                const directory = validateWorkingDirectory(args.workingDirectory || process.cwd());
                const sessionId = (args.session_id && args.session_id.trim()) || (process.env.CLAUDE_SESSION_ID && process.env.CLAUDE_SESSION_ID.trim()) || resolveSessionId({ context: 'cli' });
                const state = cancelMergeReadiness(directory, sessionId);
                const persistFailed = state?.result === 'blocked' && (state.validation_errors ?? []).some((e) => e.includes('persisted'));
                if (persistFailed) {
                    return { content: [{ type: 'text', text: `Merge-readiness cancellation FAILED: state could not be persisted (read-only state dir / full disk). The gate is still armed on disk. ${(state?.validation_errors ?? []).join(' ')}` }], isError: true };
                }
                if (!state || state.result !== 'cancelled') {
                    return { content: [{ type: 'text', text: 'Merge-readiness cancellation rejected: no active gate.' }], isError: true };
                }
                return { content: [{ type: 'text', text: 'Merge-readiness cancelled. Terminal session state preserved as the audit record.' }] };
            }
            catch (error) {
                return { content: [{ type: 'text', text: `Merge-readiness error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
            }
        },
    },
];
//# sourceMappingURL=state-tools.js.map