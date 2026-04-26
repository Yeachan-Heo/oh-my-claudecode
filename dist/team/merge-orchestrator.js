// src/team/merge-orchestrator.ts
//
// Auto-merge / auto-rebase orchestrator for v2 team runtime.
//
// Responsibilities:
//   - Watch each registered worker branch HEAD (commit watcher).
//   - On observed SHA change: drive auto-merge from a dedicated "merger" worktree
//     into the leader branch (mutex-serialised, with pre-flight reset).
//   - On clean merge: fan-out auto-rebase to every other registered worker, with
//     the M1 existing-rebase short-circuit, sentinel pause/resume, and M4 dirty
//     audit on resolution.
//   - Persist last-observed SHAs atomically so we can resume across restarts.
//   - On stop: drain pending merges within drainTimeoutMs and emit a teardown
//     audit row + leader-inbox audit message for any worker we couldn't merge.
//
// Hardening flags wired in:
//   M1: existing rebase short-circuit (gitdir-aware `rebase-merge`).
//   M3: refuse main/master leader branch.
//   M4: dirty-tree audit on rebase resolution.
//   M5: v2 gate via default-on runtime-v2 flag semantics.
//   M6: persisted SHA state + restart recovery.
//
// All git invocations go through `execFileSync` (sync) so vitest can mock the
// node:child_process module via `vi.mock(...)` without spawning real processes.
//
// ## Plan divergences
//
// The implementation diverges from the original design plan in three places.
// These are intentional and known; flagged here so future readers don't try to
// "fix" them by aligning with the plan:
//
//   1. Events are written to a dedicated `orchestrator-events.jsonl` log under
//      `.omc/state/team/{team}/`, NOT to the shared `events.jsonl` used by the
//      rest of the runtime. This keeps orchestrator-internal state isolated and
//      avoids interleaving with worker/leader event streams that have different
//      consumers and retention rules.
//
//   2. The leader inbox is written on conflict (merge or rebase) and on
//      teardown (drain audit) only — NOT on every merge success. Successful
//      merges are recorded in `orchestrator-events.jsonl` and don't need to
//      page the leader. This keeps the leader inbox actionable instead of a
//      noisy log.
//
//   3. `extendLeaderBootstrapPrompt` produces a directive that is appended to
//      the leader inbox file at startup; it is NOT injected into a leader-pane
//      spawn prompt because v2 has no leader-pane prompt hook. The v2 leader
//      runs in the parent Claude Code session and discovers the inbox via the
//      file path that gets written into the leader inbox itself.
//
//   4. Sentinel forgeability: `.hook-paused` is a plain file in the worktree
//      root that any process inside the worktree can create or remove. This is
//      a deliberate trade-off — workers and the orchestrator both need
//      synchronous, lock-free coordination, and the worktree is already a
//      trust boundary owned by the worker process. A worker that forges or
//      deletes the sentinel is already inside the trust boundary.
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, appendFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { atomicWriteJson, ensureDirWithMode, validateResolvedPath } from './fs-utils.js';
import { isRuntimeV2Enabled } from './runtime-flags.js';
import { sanitizeName } from './tmux-session.js';
import { listTeamWorktrees, getWorktreePath, getBranchName } from './git-worktree.js';
import { checkMergeConflicts, mergeWorkerBranch, validateBranchName } from './merge-coordinator.js';
import { appendToInbox } from './worker-bootstrap.js';
import { appendToLeaderInbox, ensureLeaderInbox } from './leader-inbox.js';
import { formatMergeConflictForLeader, formatRebaseConflictForWorker, } from './conflict-mailbox.js';
import { pauseHookViaSentinel, resumeHookViaSentinel, } from './worker-commit-cadence.js';
const DEFAULT_POLL_INTERVAL_MS = 1000;
const DEFAULT_DRAIN_TIMEOUT_MS = 10000;
// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------
function mergerWorktreePathFor(repoRoot, teamName) {
    return join(repoRoot, '.omc', 'team', sanitizeName(teamName), 'merger');
}
function persistedStatePath(repoRoot, teamName) {
    return join(repoRoot, '.omc', 'state', 'team', sanitizeName(teamName), 'auto-merge-state.json');
}
function teardownAuditPath(repoRoot, teamName) {
    return join(repoRoot, '.omc', 'state', 'team', sanitizeName(teamName), 'teardown-audit.jsonl');
}
function orchestratorEventLogPath(repoRoot, teamName) {
    return join(repoRoot, '.omc', 'state', 'team', sanitizeName(teamName), 'orchestrator-events.jsonl');
}
// ---------------------------------------------------------------------------
// Guards (M3, M5)
// ---------------------------------------------------------------------------
function assertLeaderBranchAllowed(leaderBranch) {
    const stripped = leaderBranch.replace(/^refs\/heads\//i, '').toLowerCase();
    if (stripped === 'main' || stripped === 'master') {
        throw new Error('auto-merge refuses main/master leader branch — use a feature branch');
    }
}
function assertRuntimeV2Gate() {
    if (!isRuntimeV2Enabled()) {
        throw new Error('auto-merge requires runtime v2 (OMC_RUNTIME_V2 is explicitly disabled).');
    }
}
async function appendEvent(repoRoot, teamName, event) {
    const path = orchestratorEventLogPath(repoRoot, teamName);
    await mkdir(dirname(path), { recursive: true });
    const full = {
        ts: new Date().toISOString(),
        team: teamName,
        ...event,
    };
    await appendFile(path, `${JSON.stringify(full)}\n`, 'utf-8');
}
// ---------------------------------------------------------------------------
// Mutex (chained-Promise serialisation)
// ---------------------------------------------------------------------------
function createMutex() {
    let lock = Promise.resolve();
    return (fn) => {
        const next = lock.then(fn, fn);
        // Swallow rejections in the chain so a failed merge doesn't poison the lock.
        lock = next.catch(() => undefined);
        return next;
    };
}
// ---------------------------------------------------------------------------
// Git helpers (all sync; mockable via vi.mock('node:child_process'))
// ---------------------------------------------------------------------------
function gitRevParseHead(repoRoot, branch) {
    return execFileSync('git', ['rev-parse', `refs/heads/${branch}`], {
        cwd: repoRoot,
        encoding: 'utf-8',
        stdio: 'pipe',
    }).trim();
}
function gitPath(worktreePath, gitPathName) {
    try {
        const resolved = execFileSync('git', ['rev-parse', '--git-path', gitPathName], {
            cwd: worktreePath,
            encoding: 'utf-8',
            stdio: 'pipe',
        }).trim();
        if (resolved)
            return resolved;
    }
    catch {
        // Fall through to the legacy in-worktree .git directory path. This keeps
        // unit tests and non-git placeholder worktrees safe while real git
        // worktrees use Git's own gitdir-aware resolution above.
    }
    return join(worktreePath, '.git', gitPathName);
}
function isRebaseInProgress(worktreePath) {
    return existsSync(gitPath(worktreePath, 'rebase-merge'));
}
function isWorktreeRegistered(repoRoot, wtPath) {
    try {
        const out = execFileSync('git', ['worktree', 'list', '--porcelain'], {
            cwd: repoRoot,
            encoding: 'utf-8',
            stdio: 'pipe',
        });
        for (const line of out.split('\n')) {
            if (line.startsWith('worktree ')) {
                if (line.slice('worktree '.length).trim() === wtPath)
                    return true;
            }
        }
    }
    catch {
        // best-effort
    }
    return false;
}
function ensureMergerWorktree(repoRoot, mergerPath, leaderBranch) {
    ensureDirWithMode(dirname(mergerPath));
    if (existsSync(mergerPath) && isWorktreeRegistered(repoRoot, mergerPath)) {
        return; // reuse
    }
    // First-time create — allow the hidden merger worktree to check out the
    // leader branch even when the normal leader repo already has it checked out.
    execFileSync('git', ['worktree', 'add', '--force', mergerPath, leaderBranch], {
        cwd: repoRoot,
        stdio: 'pipe',
    });
}
function preflightMergerWorktree(mergerPath, leaderBranch) {
    // Best-effort fetch (ignore failures — offline OK).
    try {
        execFileSync('git', ['fetch', '--no-tags', 'origin', leaderBranch], {
            cwd: mergerPath,
            stdio: 'pipe',
        });
    }
    catch {
        // ignore
    }
    execFileSync('git', ['reset', '--hard', leaderBranch], {
        cwd: mergerPath,
        stdio: 'pipe',
    });
}
function parseUUFiles(porcelainOutput) {
    const files = [];
    for (const line of porcelainOutput.split('\n')) {
        if (line.startsWith('UU ')) {
            files.push(line.slice(3).trim());
        }
        else if (line.startsWith('AA ') || line.startsWith('DD ')) {
            // Both-modified variants count as conflicts too.
            files.push(line.slice(3).trim());
        }
    }
    return files;
}
// ---------------------------------------------------------------------------
// startMergeOrchestrator
// ---------------------------------------------------------------------------
export async function startMergeOrchestrator(config) {
    assertRuntimeV2Gate();
    assertLeaderBranchAllowed(config.leaderBranch);
    // Refuse leader branch names that could be misread as flags by git
    // (e.g. `--upload-pack=evil`, `-e/payload`).
    validateBranchName(config.leaderBranch);
    const pollIntervalMs = config.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    const drainTimeoutMs = config.drainTimeoutMs ?? DEFAULT_DRAIN_TIMEOUT_MS;
    const mergerPath = mergerWorktreePathFor(config.repoRoot, config.teamName);
    // Validate paths stay under repoRoot (defence-in-depth).
    validateResolvedPath(mergerPath, config.repoRoot);
    // Bootstrap merger worktree + leader inbox.
    ensureMergerWorktree(config.repoRoot, mergerPath, config.leaderBranch);
    await ensureLeaderInbox(config.teamName, config.cwd);
    // Hydrate from persisted state if present (M6).
    const persistedPath = persistedStatePath(config.repoRoot, config.teamName);
    let persisted = { lastShas: {} };
    if (existsSync(persistedPath)) {
        try {
            const { readFileSync } = await import('node:fs');
            persisted = JSON.parse(readFileSync(persistedPath, 'utf-8'));
        }
        catch {
            persisted = { lastShas: {} };
        }
    }
    const workers = new Map();
    const pausedWorkers = new Set(); // workers mid-rebase (cadence paused)
    const mutex = createMutex();
    let stopped = false;
    function persistState() {
        const payload = {
            lastShas: Object.fromEntries(Array.from(workers.values()).map((w) => [w.workerName, w.lastObservedSha])),
        };
        atomicWriteJson(persistedPath, payload);
    }
    async function fanOutRebase(triggeringWorker) {
        for (const other of workers.values()) {
            if (other.workerName === triggeringWorker)
                continue;
            const wtPath = other.workerWorktreePath;
            // M1: existing rebase short-circuit.
            if (isRebaseInProgress(wtPath)) {
                await appendEvent(config.repoRoot, config.teamName, {
                    type: 'rebase_skipped_in_progress',
                    worker: other.workerName,
                    reason: 'rebase-already-in-progress',
                });
                continue;
            }
            await appendEvent(config.repoRoot, config.teamName, {
                type: 'rebase_triggered',
                worker: other.workerName,
            });
            // Pause cadence before touching the worktree.
            await pauseHookViaSentinel(wtPath);
            pausedWorkers.add(other.workerName);
            // Best-effort fetch.
            try {
                execFileSync('git', ['fetch', '--no-tags', 'origin', config.leaderBranch], {
                    cwd: wtPath,
                    stdio: 'pipe',
                });
            }
            catch {
                // offline OK
            }
            try {
                execFileSync('git', ['rebase', config.leaderBranch], {
                    cwd: wtPath,
                    stdio: 'pipe',
                });
                // Clean rebase — resume immediately.
                await resumeHookViaSentinel(wtPath);
                pausedWorkers.delete(other.workerName);
                await appendEvent(config.repoRoot, config.teamName, {
                    type: 'rebase_succeeded',
                    worker: other.workerName,
                });
            }
            catch {
                // Conflict — leave worktree mid-rebase, parse UU files, deliver mailbox.
                let conflictingFiles = [];
                try {
                    const status = execFileSync('git', ['status', '--porcelain'], {
                        cwd: wtPath,
                        encoding: 'utf-8',
                        stdio: 'pipe',
                    });
                    conflictingFiles = parseUUFiles(status);
                }
                catch {
                    conflictingFiles = ['(rebase status unavailable)'];
                }
                const baseSha = (() => {
                    try {
                        return execFileSync('git', ['rev-parse', `refs/heads/${config.leaderBranch}`], {
                            cwd: config.repoRoot,
                            encoding: 'utf-8',
                            stdio: 'pipe',
                        }).trim();
                    }
                    catch {
                        return 'unknown';
                    }
                })();
                const message = formatRebaseConflictForWorker({
                    workerName: other.workerName,
                    workerBranch: other.workerBranch,
                    leaderBranch: config.leaderBranch,
                    conflictingFiles,
                    baseSha,
                    worktreePath: wtPath,
                    observedAt: Date.now(),
                });
                try {
                    await appendToInbox(config.teamName, other.workerName, message, config.cwd);
                }
                catch {
                    // best-effort — don't crash poller on inbox write failure
                }
                await appendEvent(config.repoRoot, config.teamName, {
                    type: 'rebase_conflict',
                    worker: other.workerName,
                    data: { conflictingFiles },
                });
                // Cadence stays paused. The rebase resolution watcher resumes on
                // git rebase state removal (M4 audit, then resume).
            }
        }
    }
    async function attemptMergeForWorker(entry) {
        await mutex(async () => {
            // Snapshot the SHA at the time the lock is taken — this is the merge target.
            const targetSha = entry.lastObservedSha;
            await appendEvent(config.repoRoot, config.teamName, {
                type: 'merge_attempted',
                worker: entry.workerName,
                data: { targetSha },
            });
            try {
                preflightMergerWorktree(mergerPath, config.leaderBranch);
            }
            catch (err) {
                const reason = err instanceof Error ? err.message : String(err);
                entry.consecutiveFailures += 1;
                await appendEvent(config.repoRoot, config.teamName, {
                    type: 'merge_conflict',
                    worker: entry.workerName,
                    reason: `preflight_failed:${reason}`,
                });
                return;
            }
            const conflicts = checkMergeConflicts(entry.workerBranch, config.leaderBranch, mergerPath);
            if (conflicts.length > 0) {
                // Deliver merge-conflict mailbox to leader.
                let mergeBaseSha = 'unknown';
                try {
                    mergeBaseSha = execFileSync('git', ['merge-base', config.leaderBranch, entry.workerBranch], { cwd: mergerPath, encoding: 'utf-8', stdio: 'pipe' }).trim();
                }
                catch {
                    // best-effort
                }
                const message = formatMergeConflictForLeader({
                    workerName: entry.workerName,
                    workerBranch: entry.workerBranch,
                    leaderBranch: config.leaderBranch,
                    conflictingFiles: conflicts,
                    mergeBaseSha,
                    observedAt: Date.now(),
                });
                try {
                    await appendToLeaderInbox(config.teamName, message, config.cwd);
                }
                catch {
                    // best-effort
                }
                await appendEvent(config.repoRoot, config.teamName, {
                    type: 'merge_conflict',
                    worker: entry.workerName,
                    data: { conflictingFiles: conflicts, mergeBaseSha },
                });
                entry.consecutiveFailures += 1;
                return;
            }
            // Clean — execute the merge in the merger worktree.
            const result = mergeWorkerBranch(entry.workerBranch, config.leaderBranch, mergerPath);
            if (!result.success) {
                // Race: conflict-detection passed but the actual merge failed (e.g. a new
                // commit landed). Fall back to the conflict-mailbox path.
                const message = formatMergeConflictForLeader({
                    workerName: entry.workerName,
                    workerBranch: entry.workerBranch,
                    leaderBranch: config.leaderBranch,
                    conflictingFiles: result.conflicts.length > 0 ? result.conflicts : ['(merge failed after clean check)'],
                    mergeBaseSha: 'unknown',
                    observedAt: Date.now(),
                });
                try {
                    await appendToLeaderInbox(config.teamName, message, config.cwd);
                }
                catch {
                    // best-effort
                }
                await appendEvent(config.repoRoot, config.teamName, {
                    type: 'merge_conflict',
                    worker: entry.workerName,
                    data: { conflictingFiles: result.conflicts },
                });
                entry.consecutiveFailures += 1;
                return;
            }
            entry.lastMergedSha = targetSha;
            entry.consecutiveFailures = 0;
            await appendEvent(config.repoRoot, config.teamName, {
                type: 'merge_succeeded',
                worker: entry.workerName,
                data: { mergeCommit: result.mergeCommit, targetSha },
            });
            // Clean merge → fan out rebase to other workers.
            // Skip fan-out after `stopped` is set so a final drain merge cannot race
            // with `cleanupTeamWorktrees` reaching into other workers' worktrees.
            if (stopped)
                return;
            await fanOutRebase(entry.workerName);
        });
    }
    async function runPollOnce() {
        if (stopped)
            return;
        for (const entry of workers.values()) {
            // Apply per-worker exponential backoff: skip ticks based on consecutiveFailures.
            // Cap so we never fully starve a worker.
            const skipModulo = Math.min(30, Math.pow(2, entry.consecutiveFailures));
            if (skipModulo > 1 && pollTickCount % skipModulo !== 0) {
                continue;
            }
            // Rebase resolution check (M4): if the worker is paused and the
            // git rebase state has gone away, audit & resume.
            if (pausedWorkers.has(entry.workerName)) {
                if (!isRebaseInProgress(entry.workerWorktreePath)) {
                    // Resolved (--continue or --abort).
                    await handleRebaseResolution(entry);
                    // Fall through — also check for new commits.
                }
                else {
                    // Still mid-rebase; don't try to merge this worker's branch yet.
                    continue;
                }
            }
            let currentSha;
            try {
                currentSha = gitRevParseHead(config.repoRoot, entry.workerBranch);
            }
            catch (err) {
                entry.consecutiveFailures += 1;
                const reason = err instanceof Error ? err.message : String(err);
                await appendEvent(config.repoRoot, config.teamName, {
                    type: 'commit_observed',
                    worker: entry.workerName,
                    reason: `rev_parse_failed:${reason}`,
                });
                continue;
            }
            if (currentSha && currentSha !== entry.lastObservedSha) {
                // SHA advanced → record + persist + try to merge.
                entry.lastObservedSha = currentSha;
                try {
                    persistState();
                }
                catch {
                    // best-effort persistence
                }
                await appendEvent(config.repoRoot, config.teamName, {
                    type: 'commit_observed',
                    worker: entry.workerName,
                    data: { sha: currentSha },
                });
                try {
                    await attemptMergeForWorker(entry);
                }
                catch (err) {
                    entry.consecutiveFailures += 1;
                    const reason = err instanceof Error ? err.message : String(err);
                    await appendEvent(config.repoRoot, config.teamName, {
                        type: 'merge_conflict',
                        worker: entry.workerName,
                        reason: `merge_threw:${reason}`,
                    });
                }
            }
        }
    }
    async function handleRebaseResolution(entry) {
        pausedWorkers.delete(entry.workerName);
        // M4: dirty-tree audit before resuming cadence.
        try {
            const status = execFileSync('git', ['status', '--porcelain'], {
                cwd: entry.workerWorktreePath,
                encoding: 'utf-8',
                stdio: 'pipe',
            }).trim();
            if (status.length > 0) {
                const dirtyFiles = status
                    .split('\n')
                    .map((l) => l.trim().replace(/^\S+\s+/, ''))
                    .filter((s) => s.length > 0);
                const audit = `## Auto-commit audit: the following files were modified during rebase pause and will be folded into the next auto-commit:\n${dirtyFiles.map((f) => `- \`${f}\``).join('\n')}`;
                try {
                    await appendToInbox(config.teamName, entry.workerName, audit, config.cwd);
                }
                catch {
                    // best-effort
                }
            }
        }
        catch {
            // status failed — proceed without audit
        }
        await resumeHookViaSentinel(entry.workerWorktreePath);
        await appendEvent(config.repoRoot, config.teamName, {
            type: 'rebase_resolved',
            worker: entry.workerName,
        });
    }
    // ----- Polling driver -----
    let pollTickCount = 0;
    const interval = setInterval(() => {
        pollTickCount += 1;
        void runPollOnce().catch(() => {
            // Errors bubble up here as a defence; per-worker failures already
            // emit events and bump consecutiveFailures inside pollOnce().
        });
    }, pollIntervalMs);
    // Don't keep the event loop alive on its own.
    if (typeof interval.unref === 'function')
        interval.unref();
    // ----- Public handle -----
    return {
        async registerWorker(workerName) {
            if (workers.has(workerName))
                return;
            const workerBranch = getBranchName(config.teamName, workerName);
            // Defence-in-depth: reject worker branch names that could be misread as
            // flags by git (e.g. `--upload-pack=foo`). `getBranchName` is supposed to
            // produce safe names, but we re-validate here so any future change to
            // the naming scheme can't accidentally bypass this guard.
            validateBranchName(workerBranch);
            const wtPath = getWorktreePath(config.repoRoot, config.teamName, workerName);
            let seedSha = persisted.lastShas[workerName] ?? '';
            if (!seedSha) {
                try {
                    seedSha = gitRevParseHead(config.repoRoot, workerBranch);
                }
                catch {
                    seedSha = '';
                }
            }
            workers.set(workerName, {
                workerName,
                workerBranch,
                workerWorktreePath: wtPath,
                lastObservedSha: seedSha,
                lastMergedSha: seedSha,
                consecutiveFailures: 0,
            });
            try {
                persistState();
            }
            catch {
                // best-effort
            }
        },
        async unregisterWorker(workerName) {
            workers.delete(workerName);
            pausedWorkers.delete(workerName);
            try {
                persistState();
            }
            catch {
                // best-effort
            }
        },
        async pollOnce() {
            await runPollOnce();
        },
        async drainAndStop() {
            stopped = true;
            clearInterval(interval);
            const start = Date.now();
            const unmerged = [];
            const candidates = Array.from(workers.values()).filter((w) => w.lastObservedSha && w.lastObservedSha !== w.lastMergedSha);
            for (const entry of candidates) {
                const remaining = drainTimeoutMs - (Date.now() - start);
                if (remaining <= 0) {
                    unmerged.push({ workerName: entry.workerName, reason: 'drain-timeout' });
                    continue;
                }
                const merged = await Promise.race([
                    (async () => {
                        try {
                            await attemptMergeForWorker(entry);
                            return true;
                        }
                        catch {
                            return false;
                        }
                    })(),
                    new Promise((resolve) => {
                        const t = setTimeout(() => resolve(false), remaining);
                        if (typeof t.unref === 'function')
                            t.unref();
                    }),
                ]);
                if (!merged || entry.lastMergedSha !== entry.lastObservedSha) {
                    unmerged.push({
                        workerName: entry.workerName,
                        reason: merged ? 'merge-conflict' : 'drain-timeout',
                    });
                }
            }
            // Audit any unmerged drain residue.
            if (unmerged.length > 0) {
                const auditPath = teardownAuditPath(config.repoRoot, config.teamName);
                await mkdir(dirname(auditPath), { recursive: true });
                for (const u of unmerged) {
                    const row = JSON.stringify({
                        type: 'unmerged_at_shutdown',
                        ts: new Date().toISOString(),
                        team: config.teamName,
                        worker: u.workerName,
                        reason: u.reason,
                    });
                    try {
                        await appendFile(auditPath, `${row}\n`, 'utf-8');
                    }
                    catch {
                        // best-effort
                    }
                }
                const message = `## Teardown audit: unmerged worker branches at shutdown\n\n${unmerged.map((u) => `- ${u.workerName}: ${u.reason}`).join('\n')}`;
                try {
                    await appendToLeaderInbox(config.teamName, message, config.cwd);
                }
                catch {
                    // best-effort
                }
            }
            return { unmerged };
        },
        getState() {
            return {
                workers: Array.from(workers.keys()),
                lastShas: Object.fromEntries(Array.from(workers.values()).map((w) => [w.workerName, w.lastObservedSha])),
                mergerWorktreePath: mergerPath,
            };
        },
    };
}
// ---------------------------------------------------------------------------
// recoverFromRestart (M6)
// ---------------------------------------------------------------------------
export async function recoverFromRestart(config) {
    // Load persisted SHA state.
    const persistedPath = persistedStatePath(config.repoRoot, config.teamName);
    let persistedShasLoaded = 0;
    if (existsSync(persistedPath)) {
        try {
            const { readFileSync } = await import('node:fs');
            const persisted = JSON.parse(readFileSync(persistedPath, 'utf-8'));
            persistedShasLoaded = Object.keys(persisted.lastShas ?? {}).length;
        }
        catch {
            persistedShasLoaded = 0;
        }
    }
    // Walk every known worker worktree (from worktrees.json metadata) and look
    // for orphaned gitdir-aware `rebase-merge` dirs.
    const orphanedRebases = [];
    let entries = [];
    try {
        entries = listTeamWorktrees(config.teamName, config.repoRoot).map((w) => ({
            workerName: w.workerName,
            path: w.path,
        }));
    }
    catch {
        entries = [];
    }
    for (const entry of entries) {
        if (!isRebaseInProgress(entry.path))
            continue;
        orphanedRebases.push(entry.workerName);
        const message = `### Runtime restart recovery — your branch is mid-rebase

Runtime restarted while your branch was mid-rebase onto \`${config.leaderBranch}\`.

**Worktree:** \`${entry.path}\`

Cadence remains paused. Resolve and \`git rebase --continue\`, or \`git rebase --abort\` to bail.
Cadence resumes once the git rebase state is gone.`;
        try {
            await appendToInbox(config.teamName, entry.workerName, message, config.cwd);
        }
        catch {
            // best-effort
        }
    }
    if (orphanedRebases.length > 0 || persistedShasLoaded > 0) {
        try {
            await appendEvent(config.repoRoot, config.teamName, {
                type: 'restart_recovery',
                data: { orphanedRebases, persistedShasLoaded },
            });
        }
        catch {
            // best-effort
        }
    }
    return { orphanedRebases, persistedShasLoaded };
}
//# sourceMappingURL=merge-orchestrator.js.map