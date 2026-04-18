import { execFileSync, spawnSync } from 'child_process';
import { existsSync } from 'fs';
import { mkdir, readFile, symlink, writeFile } from 'fs/promises';
import { dirname, join, resolve } from 'path';
import { readModeState, writeModeState, } from '../lib/mode-state-io.js';
import { isModeActiveInAnySession } from '../hooks/mode-registry/index.js';
import { parseEvaluatorResult, } from './contracts.js';
const AUTORESEARCH_RESULTS_HEADER = 'iteration\tcommit\tpass\tscore\tstatus\tdescription\n';
const AUTORESEARCH_WORKTREE_EXCLUDES = ['results.tsv', 'run.log', 'node_modules', '.omc/'];
// Exclusive modes that cannot run concurrently with autoresearch
const EXCLUSIVE_MODES = ['ralph', 'ultrawork', 'autopilot', 'autoresearch'];
function nowIso() {
    return new Date().toISOString();
}
export function getAutoresearchMissionArtifactLayout(projectRoot, missionSlug, runId) {
    const missionRoot = join(projectRoot, '.omc', 'autoresearch', missionSlug);
    const runDir = join(missionRoot, 'runs', runId);
    return {
        missionRoot,
        missionSpecFile: join(missionRoot, 'mission.md'),
        evaluatorReferenceFile: join(missionRoot, 'evaluator.json'),
        runsDir: join(missionRoot, 'runs'),
        runDir,
        evaluationsDir: join(runDir, 'evaluations'),
        decisionLogFile: join(runDir, 'decision-log.md'),
    };
}
export function buildAutoresearchRunTag(date = new Date()) {
    const iso = date.toISOString();
    return iso
        .replace(/[-:]/g, '')
        .replace(/\.\d{3}Z$/, 'Z')
        .replace('T', 'T');
}
function buildRunId(missionSlug, runTag) {
    return `${missionSlug}-${runTag.toLowerCase()}`;
}
function activeRunStateFile(projectRoot) {
    return join(projectRoot, '.omc', 'state', 'autoresearch-state.json');
}
function trimContent(value, max = 4000) {
    const trimmed = value.trim();
    return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max)}\n...`;
}
function readGit(repoPath, args) {
    try {
        return execFileSync('git', args, {
            cwd: repoPath,
            encoding: 'utf-8',
            stdio: ['ignore', 'pipe', 'pipe'],
        }).trim();
    }
    catch (error) {
        const err = error;
        const stderr = typeof err.stderr === 'string'
            ? err.stderr.trim()
            : err.stderr instanceof Buffer
                ? err.stderr.toString('utf-8').trim()
                : '';
        throw new Error(stderr || `git ${args.join(' ')} failed`);
    }
}
function tryResolveGitCommit(worktreePath, ref) {
    const result = spawnSync('git', ['rev-parse', '--verify', `${ref}^{commit}`], {
        cwd: worktreePath,
        encoding: 'utf-8',
    });
    if (result.status !== 0)
        return null;
    const resolved = (result.stdout || '').trim();
    return resolved || null;
}
async function writeGitInfoExclude(worktreePath, pattern) {
    const excludePath = readGit(worktreePath, ['rev-parse', '--git-path', 'info/exclude']);
    const existing = existsSync(excludePath)
        ? await readFile(excludePath, 'utf-8')
        : '';
    const lines = new Set(existing.split(/\r?\n/).filter(Boolean));
    if (lines.has(pattern))
        return;
    const next = `${existing}${existing.endsWith('\n') || existing.length === 0 ? '' : '\n'}${pattern}\n`;
    await ensureParentDir(excludePath);
    await writeFile(excludePath, next, 'utf-8');
}
async function ensureRuntimeExcludes(worktreePath) {
    for (const file of AUTORESEARCH_WORKTREE_EXCLUDES) {
        await writeGitInfoExclude(worktreePath, file);
    }
}
async function appendDecisionLog(decisionLogFile, entry) {
    const lines = [
        `## Iteration ${entry.iteration} — ${entry.decision}`,
        '',
        `- Description: ${entry.description}`,
        `- Reason: ${entry.reason}`,
    ];
    if (entry.evaluator) {
        lines.push(`- Evaluator status: ${entry.evaluator.status}`, `- Pass: ${String(entry.evaluator.pass ?? '')}`, `- Score: ${typeof entry.evaluator.score === 'number' ? String(entry.evaluator.score) : ''}`);
    }
    if (entry.notes && entry.notes.length > 0) {
        lines.push('- Notes:');
        for (const note of entry.notes) {
            lines.push(`  - ${note}`);
        }
    }
    lines.push('', '');
    const existing = existsSync(decisionLogFile)
        ? await readFile(decisionLogFile, 'utf-8')
        : '# Autoresearch Decision Log\n\n';
    await ensureParentDir(decisionLogFile);
    await writeFile(decisionLogFile, `${existing}${lines.join('\n')}`, 'utf-8');
}
async function ensureAutoresearchWorktreeDependencies(repoRoot, worktreePath) {
    const sourceNodeModules = join(repoRoot, 'node_modules');
    const targetNodeModules = join(worktreePath, 'node_modules');
    if (!existsSync(sourceNodeModules) || existsSync(targetNodeModules)) {
        return;
    }
    await symlink(sourceNodeModules, targetNodeModules, process.platform === 'win32' ? 'junction' : 'dir');
}
function readGitShortHead(worktreePath) {
    return readGit(worktreePath, ['rev-parse', '--short=7', 'HEAD']);
}
function readGitFullHead(worktreePath) {
    return readGit(worktreePath, ['rev-parse', 'HEAD']);
}
function requireGitSuccess(worktreePath, args) {
    const result = spawnSync('git', args, {
        cwd: worktreePath,
        encoding: 'utf-8',
    });
    if (result.status === 0)
        return;
    throw new Error((result.stderr || '').trim() || `git ${args.join(' ')} failed`);
}
function gitStatusLines(worktreePath) {
    const result = spawnSync('git', ['status', '--porcelain', '--untracked-files=all'], {
        cwd: worktreePath,
        encoding: 'utf-8',
    });
    if (result.status !== 0) {
        throw new Error((result.stderr || '').trim() || `git status failed for ${worktreePath}`);
    }
    return (result.stdout || '')
        .split(/\r?\n/)
        .map((line) => line.trimEnd())
        .filter(Boolean);
}
function normalizeGitStatusPath(path) {
    return path.startsWith('\"') && path.endsWith('\"')
        ? path.slice(1, -1).replace(/\\\"/g, '\"')
        : path;
}
function isAllowedRuntimeDirtyPath(path) {
    return AUTORESEARCH_WORKTREE_EXCLUDES.some((exclude) => exclude.endsWith('/')
        ? path.startsWith(exclude) || path === exclude.slice(0, -1)
        : path === exclude);
}
function allowedBootstrapDirtyPaths(worktreePath, allowedDirtyPaths = []) {
    const normalizedWorktreePath = resolve(worktreePath);
    return new Set(allowedDirtyPaths
        .map((path) => {
        const normalizedPath = resolve(path);
        return normalizedPath.startsWith(`${normalizedWorktreePath}/`)
            ? normalizedPath.slice(normalizedWorktreePath.length + 1)
            : null;
    })
        .filter((path) => Boolean(path)));
}
function isAllowedRuntimeDirtyLine(line, allowedBootstrapPaths) {
    const trimmed = line.trim();
    if (trimmed.length < 4)
        return false;
    const path = normalizeGitStatusPath(trimmed.slice(3).trim());
    if (!trimmed.startsWith('?? '))
        return false;
    return isAllowedRuntimeDirtyPath(path) || allowedBootstrapPaths.has(path);
}
export function assertResetSafeWorktree(worktreePath, allowedDirtyPaths = []) {
    const lines = gitStatusLines(worktreePath);
    const allowedBootstrapPaths = allowedBootstrapDirtyPaths(worktreePath, allowedDirtyPaths);
    const blocking = lines.filter((line) => !isAllowedRuntimeDirtyLine(line, allowedBootstrapPaths));
    if (blocking.length === 0)
        return;
    throw new Error(`autoresearch_reset_requires_clean_worktree:${worktreePath}:${blocking.join(' | ')}`);
}
async function ensureParentDir(filePath) {
    await mkdir(dirname(filePath), { recursive: true });
}
async function writeJsonFile(filePath, value) {
    await ensureParentDir(filePath);
    await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf-8');
}
async function readJsonFile(filePath) {
    return JSON.parse(await readFile(filePath, 'utf-8'));
}
async function readActiveRunState(projectRoot) {
    const file = activeRunStateFile(projectRoot);
    if (!existsSync(file))
        return null;
    return readJsonFile(file);
}
async function writeActiveRunState(projectRoot, value) {
    await writeJsonFile(activeRunStateFile(projectRoot), value);
}
async function assertAutoresearchLockAvailable(projectRoot) {
    const state = await readActiveRunState(projectRoot);
    if (state?.active && state.run_id) {
        throw new Error(`autoresearch_active_run_exists:${state.run_id}`);
    }
}
/**
 * Assert no exclusive mode is already active (ralph, ultrawork, autopilot).
 * Mirrors OMX assertModeStartAllowed semantics using OMC mode-state-io.
 */
export async function assertModeStartAllowed(mode, projectRoot) {
    for (const other of EXCLUSIVE_MODES) {
        if (other === mode)
            continue;
        if (isModeActiveInAnySession(other, projectRoot)) {
            throw new Error(`Cannot start ${mode}: ${other} is already active`);
        }
    }
}
async function activateAutoresearchRun(manifest) {
    await writeActiveRunState(manifest.repo_root, {
        schema_version: 1,
        active: true,
        run_id: manifest.run_id,
        mission_slug: manifest.mission_slug,
        repo_root: manifest.repo_root,
        worktree_path: manifest.worktree_path,
        status: manifest.status,
        updated_at: nowIso(),
    });
}
async function deactivateAutoresearchRun(manifest) {
    const previous = await readActiveRunState(manifest.repo_root);
    await writeActiveRunState(manifest.repo_root, {
        schema_version: 1,
        active: false,
        run_id: previous?.run_id ?? manifest.run_id,
        mission_slug: previous?.mission_slug ?? manifest.mission_slug,
        repo_root: manifest.repo_root,
        worktree_path: previous?.worktree_path ?? manifest.worktree_path,
        status: manifest.status,
        updated_at: nowIso(),
        completed_at: nowIso(),
    });
}
/**
 * Start autoresearch mode state using OMC's writeModeState.
 */
function startAutoresearchMode(taskDescription, projectRoot) {
    writeModeState('autoresearch', {
        active: true,
        mode: 'autoresearch',
        iteration: 0,
        current_phase: 'starting',
        task_description: taskDescription,
        started_at: nowIso(),
        updated_at: nowIso(),
    }, projectRoot);
}
/**
 * Update autoresearch mode state (merge semantics).
 */
function updateAutoresearchMode(updates, projectRoot) {
    const current = readModeState('autoresearch', projectRoot);
    if (!current)
        return;
    writeModeState('autoresearch', { ...current, ...updates, updated_at: nowIso() }, projectRoot);
}
/**
 * Cancel autoresearch mode state.
 */
function cancelAutoresearchMode(projectRoot) {
    const state = readModeState('autoresearch', projectRoot);
    if (state && state.active) {
        writeModeState('autoresearch', {
            ...state,
            active: false,
            current_phase: 'cancelled',
            completed_at: nowIso(),
            updated_at: nowIso(),
        }, projectRoot);
    }
}
function resultPassValue(value) {
    return value === undefined ? '' : String(value);
}
function resultScoreValue(value) {
    return typeof value === 'number' ? String(value) : '';
}
async function initializeAutoresearchResultsFile(resultsFile) {
    if (existsSync(resultsFile))
        return;
    await ensureParentDir(resultsFile);
    await writeFile(resultsFile, AUTORESEARCH_RESULTS_HEADER, 'utf-8');
}
async function appendAutoresearchResultsRow(resultsFile, row) {
    const existing = existsSync(resultsFile)
        ? await readFile(resultsFile, 'utf-8')
        : AUTORESEARCH_RESULTS_HEADER;
    await writeFile(resultsFile, `${existing}${row.iteration}\t${row.commit}\t${resultPassValue(row.pass)}\t${resultScoreValue(row.score)}\t${row.status}\t${row.description}\n`, 'utf-8');
}
async function appendAutoresearchLedgerEntry(ledgerFile, entry) {
    const parsed = existsSync(ledgerFile)
        ? await readJsonFile(ledgerFile)
        : { schema_version: 1, entries: [] };
    const entries = Array.isArray(parsed.entries) ? parsed.entries : [];
    entries.push(entry);
    await writeJsonFile(ledgerFile, {
        schema_version: typeof parsed.schema_version === 'number' ? parsed.schema_version : 1,
        run_id: parsed.run_id,
        created_at: parsed.created_at || nowIso(),
        updated_at: nowIso(),
        entries,
    });
}
async function readAutoresearchLedgerEntries(ledgerFile) {
    if (!existsSync(ledgerFile))
        return [];
    const parsed = await readJsonFile(ledgerFile);
    return Array.isArray(parsed.entries) ? parsed.entries : [];
}
export async function countTrailingAutoresearchNoops(ledgerFile) {
    const entries = await readAutoresearchLedgerEntries(ledgerFile);
    let count = 0;
    for (let index = entries.length - 1; index >= 0; index -= 1) {
        const entry = entries[index];
        if (!entry || entry.kind !== 'iteration' || entry.decision !== 'noop')
            break;
        count += 1;
    }
    return count;
}
function formatAutoresearchInstructionSummary(entries, maxEntries = 3) {
    return entries
        .slice(-maxEntries)
        .map((entry) => ({
        iteration: entry.iteration,
        decision: entry.decision,
        reason: trimContent(entry.decision_reason, 160),
        kept_commit: entry.kept_commit,
        candidate_commit: entry.candidate_commit,
        evaluator_status: entry.evaluator?.status ?? null,
        evaluator_score: typeof entry.evaluator?.score === 'number' ? entry.evaluator.score : null,
        description: trimContent(entry.description, 120),
    }));
}
async function buildAutoresearchInstructionContext(manifest) {
    const entries = await readAutoresearchLedgerEntries(manifest.ledger_file);
    const previous = entries.at(-1);
    return {
        previousIterationOutcome: previous
            ? `${previous.decision}:${trimContent(previous.decision_reason, 160)}`
            : null,
        recentLedgerSummary: formatAutoresearchInstructionSummary(entries),
    };
}
export async function runAutoresearchEvaluator(contract, worktreePath, ledgerFile, latestEvaluatorFile) {
    const ran_at = nowIso();
    const result = spawnSync(contract.sandbox.evaluator.command, {
        cwd: worktreePath,
        encoding: 'utf-8',
        shell: true,
        maxBuffer: 1024 * 1024,
    });
    const stdout = result.stdout?.trim() || '';
    const stderr = result.stderr?.trim() || '';
    let record;
    if (result.error || result.status !== 0) {
        record = {
            command: contract.sandbox.evaluator.command,
            ran_at,
            status: 'error',
            exit_code: result.status,
            stdout,
            stderr: result.error ? [stderr, result.error.message].filter(Boolean).join('\n') : stderr,
        };
    }
    else {
        try {
            const parsed = parseEvaluatorResult(stdout);
            record = {
                command: contract.sandbox.evaluator.command,
                ran_at,
                status: parsed.pass ? 'pass' : 'fail',
                pass: parsed.pass,
                ...(parsed.score !== undefined ? { score: parsed.score } : {}),
                exit_code: result.status,
                stdout,
                stderr,
            };
        }
        catch (error) {
            record = {
                command: contract.sandbox.evaluator.command,
                ran_at,
                status: 'error',
                exit_code: result.status,
                stdout,
                stderr,
                parse_error: error instanceof Error ? error.message : String(error),
            };
        }
    }
    if (latestEvaluatorFile) {
        await writeJsonFile(latestEvaluatorFile, record);
    }
    if (ledgerFile) {
        await appendAutoresearchLedgerEntry(ledgerFile, {
            iteration: -1,
            kind: 'iteration',
            decision: record.status === 'error' ? 'error' : record.status === 'pass' ? 'keep' : 'discard',
            decision_reason: 'raw evaluator record',
            candidate_status: 'candidate',
            base_commit: readGitShortHead(worktreePath),
            candidate_commit: null,
            kept_commit: readGitShortHead(worktreePath),
            keep_policy: contract.sandbox.evaluator.keep_policy ?? 'score_improvement',
            evaluator: record,
            created_at: nowIso(),
            notes: ['raw evaluator invocation'],
            description: 'raw evaluator record',
        });
    }
    return record;
}
function comparableScore(previousScore, nextScore) {
    return typeof previousScore === 'number' && typeof nextScore === 'number';
}
export function decideAutoresearchOutcome(manifest, candidate, evaluation) {
    if (candidate.status === 'abort') {
        return {
            decision: 'abort',
            decisionReason: 'candidate requested abort',
            keep: false,
            evaluator: null,
            notes: ['run stopped by candidate artifact'],
        };
    }
    if (candidate.status === 'noop') {
        return {
            decision: 'noop',
            decisionReason: 'candidate reported noop',
            keep: false,
            evaluator: null,
            notes: ['no code change was proposed'],
        };
    }
    if (candidate.status === 'interrupted') {
        return {
            decision: 'interrupted',
            decisionReason: 'candidate session was interrupted',
            keep: false,
            evaluator: null,
            notes: ['supervisor should inspect worktree cleanliness before continuing'],
        };
    }
    if (!evaluation || evaluation.status === 'error') {
        return {
            decision: 'discard',
            decisionReason: 'evaluator error',
            keep: false,
            evaluator: evaluation,
            notes: ['candidate discarded because evaluator errored or crashed'],
        };
    }
    if (!evaluation.pass) {
        return {
            decision: 'discard',
            decisionReason: 'evaluator reported failure',
            keep: false,
            evaluator: evaluation,
            notes: ['candidate discarded because evaluator pass=false'],
        };
    }
    if (manifest.keep_policy === 'pass_only') {
        return {
            decision: 'keep',
            decisionReason: 'pass_only keep policy accepted evaluator pass=true',
            keep: true,
            evaluator: evaluation,
            notes: ['candidate kept because sandbox opted into pass_only policy'],
        };
    }
    if (!comparableScore(manifest.last_kept_score, evaluation.score)) {
        return {
            decision: 'ambiguous',
            decisionReason: 'evaluator pass without comparable score',
            keep: false,
            evaluator: evaluation,
            notes: ['candidate discarded because score_improvement policy requires comparable numeric scores'],
        };
    }
    if (evaluation.score > manifest.last_kept_score) {
        return {
            decision: 'keep',
            decisionReason: 'score improved over last kept score',
            keep: true,
            evaluator: evaluation,
            notes: ['candidate kept because evaluator score increased'],
        };
    }
    return {
        decision: 'discard',
        decisionReason: 'score did not improve',
        keep: false,
        evaluator: evaluation,
        notes: ['candidate discarded because evaluator score was not better than the kept baseline'],
    };
}
export function buildAutoresearchInstructions(contract, context) {
    return [
        '# OMC Autoresearch Supervisor Instructions',
        '',
        `Run ID: ${context.runId}`,
        `Mission directory: ${contract.missionDir}`,
        `Mission file: ${contract.missionFile}`,
        `Sandbox file: ${contract.sandboxFile}`,
        `Mission slug: ${contract.missionSlug}`,
        `Iteration: ${context.iteration}`,
        `Baseline commit: ${context.baselineCommit}`,
        `Last kept commit: ${context.lastKeptCommit}`,
        `Last kept score: ${typeof context.lastKeptScore === 'number' ? context.lastKeptScore : 'n/a'}`,
        `Results file: ${context.resultsFile}`,
        `Candidate artifact: ${context.candidateFile}`,
        `Keep policy: ${context.keepPolicy}`,
        '',
        'Iteration state snapshot:',
        '```json',
        JSON.stringify({
            iteration: context.iteration,
            baseline_commit: context.baselineCommit,
            last_kept_commit: context.lastKeptCommit,
            last_kept_score: context.lastKeptScore ?? null,
            previous_iteration_outcome: context.previousIterationOutcome ?? 'none yet',
            recent_ledger_summary: context.recentLedgerSummary ?? [],
            keep_policy: context.keepPolicy,
        }, null, 2),
        '```',
        '',
        'Operate as a thin autoresearch experiment worker for exactly one experiment cycle.',
        'Do not loop forever inside this session. Make at most one candidate commit, then write the candidate artifact JSON and exit.',
        '',
        'Candidate artifact contract:',
        '- Write JSON to the exact candidate artifact path above.',
        '- status: candidate | noop | abort | interrupted',
        '- candidate_commit: string | null',
        '- base_commit: current base commit before your edits',
        '- for status=candidate, candidate_commit must resolve in git and match the worktree HEAD commit when you exit',
        '- base_commit must still match the last kept commit provided above',
        '- description: short one-line summary',
        '- notes: array of short strings',
        '- created_at: ISO timestamp',
        '',
        'Supervisor semantics after you exit:',
        '- status=candidate => evaluator runs, then supervisor keeps or discards and may reset the worktree',
        '- status=noop => supervisor logs a noop iteration and relaunches',
        '- status=abort => supervisor stops the run',
        '- status=interrupted => supervisor inspects worktree safety before deciding how to proceed',
        '',
        'Evaluator contract:',
        `- command: ${contract.sandbox.evaluator.command}`,
        '- format: json',
        '- required output field: pass (boolean)',
        '- optional output field: score (number)',
        '',
        'Mission content:',
        '```md',
        trimContent(contract.missionContent),
        '```',
        '',
        'Sandbox policy:',
        '```md',
        trimContent(contract.sandbox.body || contract.sandboxContent),
        '```',
    ].join('\n');
}
export async function materializeAutoresearchMissionToWorktree(contract, worktreePath) {
    const missionDir = join(worktreePath, contract.missionRelativeDir);
    const missionFile = join(missionDir, 'mission.md');
    const sandboxFile = join(missionDir, 'sandbox.md');
    await mkdir(missionDir, { recursive: true });
    await writeFile(missionFile, contract.missionContent, 'utf-8');
    await writeFile(sandboxFile, contract.sandboxContent, 'utf-8');
    return {
        ...contract,
        missionDir,
        missionFile,
        sandboxFile,
    };
}
export async function loadAutoresearchRunManifest(projectRoot, runId) {
    const manifestFile = join(projectRoot, '.omc', 'logs', 'autoresearch', runId, 'manifest.json');
    if (!existsSync(manifestFile)) {
        throw new Error(`autoresearch_resume_manifest_missing:${runId}`);
    }
    return readJsonFile(manifestFile);
}
async function writeRunManifest(manifest) {
    manifest.updated_at = nowIso();
    await writeJsonFile(manifest.manifest_file, manifest);
}
async function writeInstructionsFile(contract, manifest) {
    const instructionContext = await buildAutoresearchInstructionContext(manifest);
    await writeFile(manifest.instructions_file, `${buildAutoresearchInstructions(contract, {
        runId: manifest.run_id,
        iteration: manifest.iteration + 1,
        baselineCommit: manifest.baseline_commit,
        lastKeptCommit: manifest.last_kept_commit,
        lastKeptScore: manifest.last_kept_score,
        resultsFile: manifest.results_file,
        candidateFile: manifest.candidate_file,
        keepPolicy: manifest.keep_policy,
        previousIterationOutcome: instructionContext.previousIterationOutcome,
        recentLedgerSummary: instructionContext.recentLedgerSummary,
    })}\n`, 'utf-8');
}
async function seedBaseline(contract, manifest) {
    const evaluation = await runAutoresearchEvaluator(contract, manifest.worktree_path);
    await writeJsonFile(manifest.latest_evaluator_file, evaluation);
    const artifactLayout = getAutoresearchMissionArtifactLayout(manifest.repo_root, manifest.mission_slug, manifest.run_id);
    await writeJsonFile(join(artifactLayout.evaluationsDir, 'iteration-0000.json'), evaluation);
    await appendAutoresearchResultsRow(manifest.results_file, {
        iteration: 0,
        commit: readGitShortHead(manifest.worktree_path),
        pass: evaluation.pass,
        score: evaluation.score,
        status: evaluation.status === 'error' ? 'error' : 'baseline',
        description: 'initial baseline evaluation',
    });
    await appendAutoresearchLedgerEntry(manifest.ledger_file, {
        iteration: 0,
        kind: 'baseline',
        decision: evaluation.status === 'error' ? 'error' : 'baseline',
        decision_reason: evaluation.status === 'error' ? 'baseline evaluator error' : 'baseline established',
        candidate_status: 'baseline',
        base_commit: manifest.baseline_commit,
        candidate_commit: null,
        kept_commit: manifest.last_kept_commit,
        keep_policy: manifest.keep_policy,
        evaluator: evaluation,
        created_at: nowIso(),
        notes: ['baseline row is always recorded'],
        description: 'initial baseline evaluation',
    });
    await appendDecisionLog(artifactLayout.decisionLogFile, {
        iteration: 0,
        decision: 'baseline',
        description: 'initial baseline evaluation',
        reason: 'baseline established',
        evaluator: evaluation,
        notes: ['baseline established'],
    });
    manifest.last_kept_score = evaluation.pass && typeof evaluation.score === 'number' ? evaluation.score : null;
    await writeRunManifest(manifest);
    await writeInstructionsFile(contract, manifest);
    return evaluation;
}
export async function prepareAutoresearchRuntime(contract, projectRoot, worktreePath, options = {}) {
    await assertAutoresearchLockAvailable(projectRoot);
    await ensureRuntimeExcludes(worktreePath);
    await ensureAutoresearchWorktreeDependencies(projectRoot, worktreePath);
    assertResetSafeWorktree(worktreePath, [contract.missionFile, contract.sandboxFile]);
    const runTag = options.runTag || buildAutoresearchRunTag();
    const runId = buildRunId(contract.missionSlug, runTag);
    const baselineCommit = readGitShortHead(worktreePath);
    const branchName = readGit(worktreePath, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
    const runDir = join(projectRoot, '.omc', 'logs', 'autoresearch', runId);
    const stateFile = activeRunStateFile(projectRoot);
    const instructionsFile = join(runDir, 'bootstrap-instructions.md');
    const manifestFile = join(runDir, 'manifest.json');
    const ledgerFile = join(runDir, 'iteration-ledger.json');
    const latestEvaluatorFile = join(runDir, 'latest-evaluator-result.json');
    const candidateFile = join(runDir, 'candidate.json');
    const resultsFile = join(worktreePath, 'results.tsv');
    const taskDescription = `autoresearch ${contract.missionRelativeDir} (${runId})`;
    const keepPolicy = contract.sandbox.evaluator.keep_policy ?? 'score_improvement';
    const artifactLayout = getAutoresearchMissionArtifactLayout(projectRoot, contract.missionSlug, runId);
    const deadlineAt = typeof options.maxRuntimeMs === 'number'
        ? new Date(Date.now() + options.maxRuntimeMs).toISOString()
        : undefined;
    await mkdir(runDir, { recursive: true });
    await mkdir(artifactLayout.evaluationsDir, { recursive: true });
    await initializeAutoresearchResultsFile(resultsFile);
    await ensureParentDir(artifactLayout.missionSpecFile);
    await writeFile(artifactLayout.missionSpecFile, contract.missionContent, 'utf-8');
    await ensureParentDir(artifactLayout.evaluatorReferenceFile);
    await writeJsonFile(artifactLayout.evaluatorReferenceFile, {
        command: contract.sandbox.evaluator.command,
        format: contract.sandbox.evaluator.format,
        ...(contract.sandbox.evaluator.keep_policy ? { keep_policy: contract.sandbox.evaluator.keep_policy } : {}),
    });
    await writeJsonFile(candidateFile, {
        status: 'noop',
        candidate_commit: null,
        base_commit: baselineCommit,
        description: 'not-yet-written',
        notes: ['candidate artifact will be overwritten by the launched session'],
        created_at: nowIso(),
    });
    const manifest = {
        schema_version: 1,
        run_id: runId,
        run_tag: runTag,
        mission_dir: contract.missionDir,
        mission_file: contract.missionFile,
        sandbox_file: contract.sandboxFile,
        repo_root: projectRoot,
        worktree_path: worktreePath,
        mission_slug: contract.missionSlug,
        branch_name: branchName,
        baseline_commit: baselineCommit,
        last_kept_commit: readGitFullHead(worktreePath),
        last_kept_score: null,
        latest_candidate_commit: null,
        results_file: resultsFile,
        instructions_file: instructionsFile,
        manifest_file: manifestFile,
        ledger_file: ledgerFile,
        latest_evaluator_file: latestEvaluatorFile,
        candidate_file: candidateFile,
        evaluator: contract.sandbox.evaluator,
        keep_policy: keepPolicy,
        status: 'running',
        stop_reason: null,
        iteration: 0,
        created_at: nowIso(),
        updated_at: nowIso(),
        completed_at: null,
    };
    await writeInstructionsFile(contract, manifest);
    await writeRunManifest(manifest);
    await writeJsonFile(ledgerFile, {
        schema_version: 1,
        run_id: runId,
        created_at: nowIso(),
        updated_at: nowIso(),
        entries: [],
    });
    await writeJsonFile(latestEvaluatorFile, {
        run_id: runId,
        status: 'not-yet-run',
        updated_at: nowIso(),
    });
    const existingModeState = readModeState('autoresearch', projectRoot);
    if (existingModeState?.active) {
        throw new Error(`autoresearch_active_mode_exists:${String(existingModeState.run_id || 'unknown')}`);
    }
    startAutoresearchMode(taskDescription, projectRoot);
    await activateAutoresearchRun(manifest);
    updateAutoresearchMode({
        current_phase: 'evaluating-baseline',
        run_id: runId,
        run_tag: runTag,
        mission_dir: contract.missionDir,
        mission_file: contract.missionFile,
        sandbox_file: contract.sandboxFile,
        mission_slug: contract.missionSlug,
        repo_root: projectRoot,
        worktree_path: worktreePath,
        baseline_commit: baselineCommit,
        last_kept_commit: manifest.last_kept_commit,
        results_file: resultsFile,
        manifest_path: manifestFile,
        iteration_ledger_path: ledgerFile,
        latest_evaluator_result_path: latestEvaluatorFile,
        bootstrap_instructions_path: instructionsFile,
        candidate_path: candidateFile,
        keep_policy: keepPolicy,
        state_file: stateFile,
        mission_artifact_root: artifactLayout.missionRoot,
        mission_spec_file: artifactLayout.missionSpecFile,
        evaluator_reference_file: artifactLayout.evaluatorReferenceFile,
        decision_log_file: artifactLayout.decisionLogFile,
        max_runtime_ms: options.maxRuntimeMs,
        deadline_at: deadlineAt,
    }, projectRoot);
    const evaluation = await seedBaseline(contract, manifest);
    updateAutoresearchMode({
        current_phase: 'running',
        latest_evaluator_status: evaluation.status,
        latest_evaluator_pass: evaluation.pass,
        latest_evaluator_score: evaluation.score,
        latest_evaluator_ran_at: evaluation.ran_at,
        last_kept_commit: manifest.last_kept_commit,
        last_kept_score: manifest.last_kept_score,
    }, projectRoot);
    return {
        runId,
        runTag,
        runDir,
        instructionsFile,
        manifestFile,
        ledgerFile,
        latestEvaluatorFile,
        resultsFile,
        stateFile,
        candidateFile,
        repoRoot: projectRoot,
        worktreePath,
        taskDescription,
    };
}
export async function resumeAutoresearchRuntime(projectRoot, runId) {
    await assertAutoresearchLockAvailable(projectRoot);
    const manifest = await loadAutoresearchRunManifest(projectRoot, runId);
    if (manifest.status !== 'running') {
        throw new Error(`autoresearch_resume_terminal_run:${runId}`);
    }
    if (!existsSync(manifest.worktree_path)) {
        throw new Error(`autoresearch_resume_missing_worktree:${manifest.worktree_path}`);
    }
    await ensureRuntimeExcludes(manifest.worktree_path);
    await ensureAutoresearchWorktreeDependencies(projectRoot, manifest.worktree_path);
    assertResetSafeWorktree(manifest.worktree_path, [manifest.mission_file, manifest.sandbox_file]);
    startAutoresearchMode(`autoresearch resume ${runId}`, projectRoot);
    await activateAutoresearchRun(manifest);
    updateAutoresearchMode({
        current_phase: 'running',
        run_id: manifest.run_id,
        run_tag: manifest.run_tag,
        mission_dir: manifest.mission_dir,
        mission_file: manifest.mission_file,
        sandbox_file: manifest.sandbox_file,
        mission_slug: manifest.mission_slug,
        repo_root: manifest.repo_root,
        worktree_path: manifest.worktree_path,
        baseline_commit: manifest.baseline_commit,
        last_kept_commit: manifest.last_kept_commit,
        last_kept_score: manifest.last_kept_score,
        results_file: manifest.results_file,
        manifest_path: manifest.manifest_file,
        iteration_ledger_path: manifest.ledger_file,
        latest_evaluator_result_path: manifest.latest_evaluator_file,
        bootstrap_instructions_path: manifest.instructions_file,
        candidate_path: manifest.candidate_file,
        keep_policy: manifest.keep_policy,
        state_file: activeRunStateFile(projectRoot),
    }, projectRoot);
    return {
        runId: manifest.run_id,
        runTag: manifest.run_tag,
        runDir: dirname(manifest.manifest_file),
        instructionsFile: manifest.instructions_file,
        manifestFile: manifest.manifest_file,
        ledgerFile: manifest.ledger_file,
        latestEvaluatorFile: manifest.latest_evaluator_file,
        resultsFile: manifest.results_file,
        stateFile: activeRunStateFile(projectRoot),
        candidateFile: manifest.candidate_file,
        repoRoot: manifest.repo_root,
        worktreePath: manifest.worktree_path,
        taskDescription: `autoresearch resume ${runId}`,
    };
}
export function parseAutoresearchCandidateArtifact(raw) {
    let parsed;
    try {
        parsed = JSON.parse(raw);
    }
    catch {
        throw new Error('autoresearch candidate artifact must be valid JSON');
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('autoresearch candidate artifact must be a JSON object');
    }
    const record = parsed;
    const status = record.status;
    if (status !== 'candidate' && status !== 'noop' && status !== 'abort' && status !== 'interrupted') {
        throw new Error('autoresearch candidate artifact status must be candidate|noop|abort|interrupted');
    }
    if (record.candidate_commit !== null && typeof record.candidate_commit !== 'string') {
        throw new Error('autoresearch candidate artifact candidate_commit must be string|null');
    }
    if (typeof record.base_commit !== 'string' || !record.base_commit.trim()) {
        throw new Error('autoresearch candidate artifact base_commit is required');
    }
    if (typeof record.description !== 'string') {
        throw new Error('autoresearch candidate artifact description is required');
    }
    if (!Array.isArray(record.notes) || record.notes.some((note) => typeof note !== 'string')) {
        throw new Error('autoresearch candidate artifact notes must be a string array');
    }
    if (typeof record.created_at !== 'string' || !record.created_at.trim()) {
        throw new Error('autoresearch candidate artifact created_at is required');
    }
    return {
        status,
        candidate_commit: record.candidate_commit,
        base_commit: record.base_commit,
        description: record.description,
        notes: record.notes,
        created_at: record.created_at,
    };
}
async function readCandidateArtifact(candidateFile) {
    if (!existsSync(candidateFile)) {
        throw new Error(`autoresearch_candidate_missing:${candidateFile}`);
    }
    return parseAutoresearchCandidateArtifact(await readFile(candidateFile, 'utf-8'));
}
async function finalizeRun(manifest, projectRoot, updates) {
    manifest.status = updates.status;
    manifest.stop_reason = updates.stopReason;
    manifest.completed_at = nowIso();
    await writeRunManifest(manifest);
    updateAutoresearchMode({
        active: false,
        current_phase: updates.status,
        completed_at: manifest.completed_at,
        stop_reason: updates.stopReason,
    }, projectRoot);
    await deactivateAutoresearchRun(manifest);
}
function resetToLastKeptCommit(manifest) {
    assertResetSafeWorktree(manifest.worktree_path, [manifest.mission_file, manifest.sandbox_file]);
    requireGitSuccess(manifest.worktree_path, ['reset', '--hard', manifest.last_kept_commit]);
}
function validateAutoresearchCandidate(manifest, candidate) {
    const resolvedBaseCommit = tryResolveGitCommit(manifest.worktree_path, candidate.base_commit);
    if (!resolvedBaseCommit) {
        return {
            reason: `candidate base_commit does not resolve in git: ${candidate.base_commit}`,
        };
    }
    if (resolvedBaseCommit !== manifest.last_kept_commit) {
        return {
            reason: `candidate base_commit ${resolvedBaseCommit} does not match last kept commit ${manifest.last_kept_commit}`,
        };
    }
    if (candidate.status !== 'candidate') {
        return {
            candidate: {
                ...candidate,
                base_commit: resolvedBaseCommit,
            },
        };
    }
    if (!candidate.candidate_commit) {
        return {
            reason: 'candidate status requires a non-null candidate_commit',
        };
    }
    const resolvedCandidateCommit = tryResolveGitCommit(manifest.worktree_path, candidate.candidate_commit);
    if (!resolvedCandidateCommit) {
        return {
            reason: `candidate_commit does not resolve in git: ${candidate.candidate_commit}`,
        };
    }
    const headCommit = readGitFullHead(manifest.worktree_path);
    if (resolvedCandidateCommit !== headCommit) {
        return {
            reason: `candidate_commit ${resolvedCandidateCommit} does not match worktree HEAD ${headCommit}`,
        };
    }
    return {
        candidate: {
            ...candidate,
            base_commit: resolvedBaseCommit,
            candidate_commit: resolvedCandidateCommit,
        },
    };
}
async function failAutoresearchIteration(manifest, projectRoot, reason, candidate) {
    const artifactLayout = getAutoresearchMissionArtifactLayout(projectRoot, manifest.mission_slug, manifest.run_id);
    const headCommit = (() => {
        try {
            return readGitShortHead(manifest.worktree_path);
        }
        catch {
            return manifest.baseline_commit;
        }
    })();
    await appendAutoresearchResultsRow(manifest.results_file, {
        iteration: manifest.iteration,
        commit: headCommit,
        status: 'error',
        description: candidate?.description || 'candidate validation failed',
    });
    await appendAutoresearchLedgerEntry(manifest.ledger_file, {
        iteration: manifest.iteration,
        kind: 'iteration',
        decision: 'error',
        decision_reason: reason,
        candidate_status: candidate?.status ?? 'candidate',
        base_commit: candidate?.base_commit ?? manifest.last_kept_commit,
        candidate_commit: candidate?.candidate_commit ?? null,
        kept_commit: manifest.last_kept_commit,
        keep_policy: manifest.keep_policy,
        evaluator: null,
        created_at: nowIso(),
        notes: [...(candidate?.notes ?? []), `validation_error:${reason}`],
        description: candidate?.description || 'candidate validation failed',
    });
    await appendDecisionLog(artifactLayout.decisionLogFile, {
        iteration: manifest.iteration,
        decision: 'error',
        description: candidate?.description || 'candidate validation failed',
        reason,
        notes: [...(candidate?.notes ?? []), `validation_error:${reason}`],
    });
    await finalizeRun(manifest, projectRoot, { status: 'failed', stopReason: reason });
    return 'error';
}
export async function processAutoresearchCandidate(contract, manifest, projectRoot) {
    manifest.iteration += 1;
    const artifactLayout = getAutoresearchMissionArtifactLayout(projectRoot, manifest.mission_slug, manifest.run_id);
    let candidate;
    try {
        candidate = await readCandidateArtifact(manifest.candidate_file);
    }
    catch (error) {
        return failAutoresearchIteration(manifest, projectRoot, error instanceof Error ? error.message : String(error));
    }
    const validation = validateAutoresearchCandidate(manifest, candidate);
    if ('reason' in validation) {
        return failAutoresearchIteration(manifest, projectRoot, validation.reason, candidate);
    }
    candidate = validation.candidate;
    manifest.latest_candidate_commit = candidate.candidate_commit;
    if (candidate.status === 'abort') {
        await appendAutoresearchResultsRow(manifest.results_file, {
            iteration: manifest.iteration,
            commit: readGitShortHead(manifest.worktree_path),
            status: 'abort',
            description: candidate.description,
        });
        await appendAutoresearchLedgerEntry(manifest.ledger_file, {
            iteration: manifest.iteration,
            kind: 'iteration',
            decision: 'abort',
            decision_reason: 'candidate requested abort',
            candidate_status: candidate.status,
            base_commit: candidate.base_commit,
            candidate_commit: candidate.candidate_commit,
            kept_commit: manifest.last_kept_commit,
            keep_policy: manifest.keep_policy,
            evaluator: null,
            created_at: nowIso(),
            notes: candidate.notes,
            description: candidate.description,
        });
        await appendDecisionLog(artifactLayout.decisionLogFile, {
            iteration: manifest.iteration,
            decision: 'abort',
            description: candidate.description,
            reason: 'candidate requested abort',
            notes: candidate.notes,
        });
        await finalizeRun(manifest, projectRoot, { status: 'stopped', stopReason: 'candidate abort' });
        return 'abort';
    }
    if (candidate.status === 'interrupted') {
        try {
            assertResetSafeWorktree(manifest.worktree_path, [manifest.mission_file, manifest.sandbox_file]);
        }
        catch {
            await finalizeRun(manifest, projectRoot, { status: 'failed', stopReason: 'interrupted dirty worktree requires operator intervention' });
            return 'error';
        }
        await appendAutoresearchResultsRow(manifest.results_file, {
            iteration: manifest.iteration,
            commit: readGitShortHead(manifest.worktree_path),
            status: 'interrupted',
            description: candidate.description,
        });
        await appendAutoresearchLedgerEntry(manifest.ledger_file, {
            iteration: manifest.iteration,
            kind: 'iteration',
            decision: 'interrupted',
            decision_reason: 'candidate session interrupted cleanly',
            candidate_status: candidate.status,
            base_commit: candidate.base_commit,
            candidate_commit: candidate.candidate_commit,
            kept_commit: manifest.last_kept_commit,
            keep_policy: manifest.keep_policy,
            evaluator: null,
            created_at: nowIso(),
            notes: candidate.notes,
            description: candidate.description,
        });
        await appendDecisionLog(artifactLayout.decisionLogFile, {
            iteration: manifest.iteration,
            decision: 'interrupted',
            description: candidate.description,
            reason: 'candidate session interrupted cleanly',
            notes: candidate.notes,
        });
        await writeRunManifest(manifest);
        await writeInstructionsFile(contract, manifest);
        return 'interrupted';
    }
    if (candidate.status === 'noop') {
        await appendAutoresearchResultsRow(manifest.results_file, {
            iteration: manifest.iteration,
            commit: readGitShortHead(manifest.worktree_path),
            status: 'noop',
            description: candidate.description,
        });
        await appendAutoresearchLedgerEntry(manifest.ledger_file, {
            iteration: manifest.iteration,
            kind: 'iteration',
            decision: 'noop',
            decision_reason: 'candidate reported noop',
            candidate_status: candidate.status,
            base_commit: candidate.base_commit,
            candidate_commit: candidate.candidate_commit,
            kept_commit: manifest.last_kept_commit,
            keep_policy: manifest.keep_policy,
            evaluator: null,
            created_at: nowIso(),
            notes: candidate.notes,
            description: candidate.description,
        });
        await appendDecisionLog(artifactLayout.decisionLogFile, {
            iteration: manifest.iteration,
            decision: 'noop',
            description: candidate.description,
            reason: 'candidate reported noop',
            notes: candidate.notes,
        });
        await writeRunManifest(manifest);
        await writeInstructionsFile(contract, manifest);
        return 'noop';
    }
    const evaluation = await runAutoresearchEvaluator(contract, manifest.worktree_path);
    await writeJsonFile(manifest.latest_evaluator_file, evaluation);
    await writeJsonFile(join(artifactLayout.evaluationsDir, `iteration-${String(manifest.iteration).padStart(4, '0')}.json`), evaluation);
    const decision = decideAutoresearchOutcome(manifest, candidate, evaluation);
    if (decision.keep) {
        manifest.last_kept_commit = readGitFullHead(manifest.worktree_path);
        manifest.last_kept_score = typeof evaluation.score === 'number' ? evaluation.score : manifest.last_kept_score;
    }
    else {
        resetToLastKeptCommit(manifest);
    }
    await appendAutoresearchResultsRow(manifest.results_file, {
        iteration: manifest.iteration,
        commit: readGitShortHead(manifest.worktree_path),
        pass: evaluation.pass,
        score: evaluation.score,
        status: decision.decision,
        description: candidate.description,
    });
    await appendAutoresearchLedgerEntry(manifest.ledger_file, {
        iteration: manifest.iteration,
        kind: 'iteration',
        decision: decision.decision,
        decision_reason: decision.decisionReason,
        candidate_status: candidate.status,
        base_commit: candidate.base_commit,
        candidate_commit: candidate.candidate_commit,
        kept_commit: manifest.last_kept_commit,
        keep_policy: manifest.keep_policy,
        evaluator: evaluation,
        created_at: nowIso(),
        notes: [...candidate.notes, ...decision.notes],
        description: candidate.description,
    });
    await appendDecisionLog(artifactLayout.decisionLogFile, {
        iteration: manifest.iteration,
        decision: decision.decision,
        description: candidate.description,
        reason: decision.decisionReason,
        evaluator: evaluation,
        notes: [...candidate.notes, ...decision.notes],
    });
    await writeRunManifest(manifest);
    await writeInstructionsFile(contract, manifest);
    updateAutoresearchMode({
        current_phase: 'running',
        iteration: manifest.iteration,
        last_kept_commit: manifest.last_kept_commit,
        last_kept_score: manifest.last_kept_score,
        latest_evaluator_status: evaluation.status,
        latest_evaluator_pass: evaluation.pass,
        latest_evaluator_score: evaluation.score,
        latest_evaluator_ran_at: evaluation.ran_at,
        decision_log_file: artifactLayout.decisionLogFile,
    }, projectRoot);
    return decision.decision;
}
export async function finalizeAutoresearchRunState(projectRoot, runId, updates) {
    const manifest = await loadAutoresearchRunManifest(projectRoot, runId);
    if (manifest.status !== 'running') {
        return;
    }
    await finalizeRun(manifest, projectRoot, updates);
}
export async function stopAutoresearchRuntime(projectRoot) {
    const state = readModeState('autoresearch', projectRoot);
    if (!state?.active) {
        return;
    }
    const runId = typeof state.run_id === 'string' ? state.run_id : null;
    if (runId) {
        await finalizeAutoresearchRunState(projectRoot, runId, {
            status: 'stopped',
            stopReason: 'operator stop',
        });
        return;
    }
    cancelAutoresearchMode(projectRoot);
}
//# sourceMappingURL=runtime.js.map