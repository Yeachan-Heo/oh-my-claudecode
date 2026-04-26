// src/team/__tests__/helpers/git-fixture.ts
//
// Ephemeral bare-repo + N worker worktrees for integration tests.
// Uses real git via execFileSync. Each test gets its own fixture.
//
// Design notes:
//   - The "repo root" is a regular (non-bare) git repo at tmpDir/repo/
//   - Worker worktrees live at tmpDir/worktrees/{workerName}/
//   - Worker branches are omc-team/{teamName}/{workerName} (matching getBranchName)
//   - Leader branch must NOT be main/master (M3 hardening) — defaults to 'omc-team-test-leader'
//   - State dir (.omc/...) is created inside the repo root so orchestrator paths resolve
//   - simulateRuntimeRestart does NOT clean up the repo; it only kills the orchestrator
//     handle (if set externally) and can optionally create an orphan rebase-merge dir.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
function git(cwd, args) {
    return execFileSync('git', args, {
        cwd,
        encoding: 'utf-8',
        stdio: 'pipe',
        env: {
            ...process.env,
            // Disable GPG signing in tests
            GIT_COMMITTER_NAME: 'Test User',
            GIT_COMMITTER_EMAIL: 'test@example.com',
            GIT_AUTHOR_NAME: 'Test User',
            GIT_AUTHOR_EMAIL: 'test@example.com',
            GIT_CONFIG_GLOBAL: '/dev/null',
            GIT_CONFIG_SYSTEM: '/dev/null',
        },
    }).trim();
}
export async function createGitFixture(opts) {
    const { workerCount, leaderBranchName = 'omc-team-test-leader', teamName = 'test-team' } = opts;
    // Guard: never allow main/master as leader branch (M3)
    const normalized = leaderBranchName.toLowerCase();
    if (normalized === 'main' || normalized === 'master') {
        throw new Error(`git-fixture: leaderBranchName must not be main/master (M3 hardening)`);
    }
    // Create temp directory structure
    const tmpBase = mkdtempSync(join(tmpdir(), 'omc-test-'));
    const repoRoot = join(tmpBase, 'repo');
    mkdirSync(repoRoot, { recursive: true });
    // Init repo
    git(repoRoot, ['init', '-b', leaderBranchName]);
    git(repoRoot, ['config', 'user.email', 'test@example.com']);
    git(repoRoot, ['config', 'user.name', 'Test User']);
    git(repoRoot, ['config', 'commit.gpgsign', 'false']);
    git(repoRoot, ['config', 'merge.conflictstyle', 'diff3']);
    // Create an initial commit on the leader branch so it exists
    const readmePath = join(repoRoot, 'README.md');
    writeFileSync(readmePath, '# test repo\n', 'utf-8');
    git(repoRoot, ['add', 'README.md']);
    git(repoRoot, ['commit', '-m', 'chore: initial commit']);
    // Detach HEAD so the merger worktree can check out the leader branch without
    // hitting "already checked out" error (git refuses worktree add for a branch
    // that's currently checked out in the main worktree).
    git(repoRoot, ['checkout', '--detach']);
    // Create worker worktrees
    const workersDir = join(repoRoot, '.omc', 'team', teamName, 'worktrees');
    mkdirSync(workersDir, { recursive: true });
    const workers = [];
    for (let i = 0; i < workerCount; i++) {
        const workerName = `worker-${i + 1}`;
        const branch = `omc-team/${teamName}/${workerName}`;
        const wtPath = join(workersDir, workerName);
        // Create a new branch and worktree
        git(repoRoot, ['worktree', 'add', '-b', branch, wtPath, leaderBranchName]);
        git(wtPath, ['config', 'user.email', 'test@example.com']);
        git(wtPath, ['config', 'user.name', 'Test User']);
        git(wtPath, ['config', 'commit.gpgsign', 'false']);
        workers.push({ name: workerName, worktreePath: wtPath, branch });
    }
    // Write worktrees.json metadata (needed by listTeamWorktrees / recoverFromRestart)
    const worktreesMetaDir = join(repoRoot, '.omc', 'state', 'team', teamName);
    mkdirSync(worktreesMetaDir, { recursive: true });
    const worktreesMeta = workers.map((w) => ({
        path: w.worktreePath,
        branch: w.branch,
        workerName: w.name,
        teamName,
        createdAt: new Date().toISOString(),
        repoRoot,
    }));
    writeFileSync(join(worktreesMetaDir, 'worktrees.json'), JSON.stringify(worktreesMeta), 'utf-8');
    let attachedHandle = null;
    return {
        repoRoot,
        leaderBranch: leaderBranchName,
        teamName,
        workers,
        async commitFile(workerName, relPath, content) {
            const worker = workers.find((w) => w.name === workerName);
            if (!worker)
                throw new Error(`No worker named ${workerName}`);
            const filePath = join(worker.worktreePath, relPath);
            mkdirSync(join(worker.worktreePath, relPath.includes('/') ? relPath.split('/').slice(0, -1).join('/') : '.'), { recursive: true });
            writeFileSync(filePath, content, 'utf-8');
            git(worker.worktreePath, ['add', relPath]);
            git(worker.worktreePath, ['commit', '-m', `test: update ${relPath}`]);
            return git(worker.worktreePath, ['rev-parse', 'HEAD']);
        },
        getBranchSha(branch) {
            return git(repoRoot, ['rev-parse', `refs/heads/${branch}`]);
        },
        createRebaseState(workerName) {
            const worker = workers.find((w) => w.name === workerName);
            if (!worker)
                throw new Error(`No worker named ${workerName}`);
            const rebaseMergeDir = git(worker.worktreePath, ['rev-parse', '--git-path', 'rebase-merge']);
            mkdirSync(rebaseMergeDir, { recursive: true });
            writeFileSync(join(rebaseMergeDir, 'head-name'), `refs/heads/${worker.branch}\n`, 'utf-8');
            writeFileSync(join(rebaseMergeDir, 'onto'), 'deadbeef\n', 'utf-8');
            return rebaseMergeDir;
        },
        attachHandle(handle) {
            attachedHandle = handle;
        },
        async simulateRuntimeRestart(orphanWorkerName) {
            // Stop orchestrator without cleanup (simulating crash/restart)
            if (attachedHandle) {
                try {
                    await attachedHandle.drainAndStop();
                }
                catch {
                    // Ignore errors — we're simulating a crash
                }
                attachedHandle = null;
            }
            // Create orphan rebase state in the specified worker worktree's real
            // gitdir. Real git worktrees have a `.git` FILE that points at the
            // main repository metadata; `git rev-parse --git-path rebase-merge` is
            // the gitdir-aware way to locate the marker path.
            if (orphanWorkerName) {
                const worker = workers.find((w) => w.name === orphanWorkerName);
                if (!worker)
                    throw new Error(`No worker named ${orphanWorkerName}`);
                const rebaseMergeDir = git(worker.worktreePath, ['rev-parse', '--git-path', 'rebase-merge']);
                mkdirSync(rebaseMergeDir, { recursive: true });
                writeFileSync(join(rebaseMergeDir, 'head-name'), `refs/heads/${worker.branch}\n`, 'utf-8');
                writeFileSync(join(rebaseMergeDir, 'onto'), 'deadbeef\n', 'utf-8');
            }
        },
        async cleanup() {
            // Detach all worktrees first (best-effort)
            try {
                for (const w of workers) {
                    try {
                        git(repoRoot, ['worktree', 'remove', '--force', w.worktreePath]);
                    }
                    catch {
                        // ignore
                    }
                }
                // Remove merger worktree if it exists
                const mergerPath = join(repoRoot, '.omc', 'team', teamName, 'merger');
                if (existsSync(mergerPath)) {
                    try {
                        git(repoRoot, ['worktree', 'remove', '--force', mergerPath]);
                    }
                    catch {
                        // ignore
                    }
                }
            }
            catch {
                // ignore cleanup errors
            }
            // Use rm -rf via shell to avoid Node's multi-step recursive walk racing
            // with concurrent git object writes (ENOTEMPTY race under vitest threads).
            execFileSync('rm', ['-rf', tmpBase], { stdio: 'pipe' });
        },
    };
}
export async function waitForEventInLog(opts) {
    const { eventLogPath, eventType, count = 1, timeoutMs = 10000, worker } = opts;
    await new Promise((r) => setTimeout(r, 250));
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (existsSync(eventLogPath)) {
            try {
                const raw = readFileSync(eventLogPath, 'utf-8');
                if (raw.includes(eventType) && (worker === undefined || raw.includes(worker))) {
                    return;
                }
                const lines = raw
                    .split('\n')
                    .filter((l) => l.trim().length > 0);
                const events = lines.map((l) => {
                    try {
                        return JSON.parse(l);
                    }
                    catch {
                        return null;
                    }
                }).filter(Boolean);
                const matching = events.filter((e) => e.type === eventType && (worker === undefined || e.worker === worker));
                if (matching.length >= count)
                    return;
            }
            catch {
                // file being written — retry
            }
        }
        await new Promise((r) => setTimeout(r, 50));
    }
    // Provide helpful diagnostic on timeout
    let found = 0;
    if (existsSync(eventLogPath)) {
        try {
            const lines = readFileSync(eventLogPath, 'utf-8')
                .split('\n')
                .filter((l) => l.trim().length > 0);
            found = lines.filter((l) => l.includes(`"${eventType}"`)).length;
        }
        catch {
            // ignore
        }
    }
    throw new Error(`waitForEventInLog: timed out after ${timeoutMs}ms waiting for ${count}x "${eventType}"` +
        (worker ? ` (worker=${worker})` : '') +
        `. Found ${found}.`);
}
/** Read all events from the orchestrator event log. */
export function readEventLog(eventLogPath) {
    if (!existsSync(eventLogPath))
        return [];
    try {
        return readFileSync(eventLogPath, 'utf-8')
            .split('\n')
            .filter((l) => l.trim().length > 0)
            .map((l) => {
            try {
                return JSON.parse(l);
            }
            catch {
                return null;
            }
        })
            .filter(Boolean);
    }
    catch {
        return [];
    }
}
/** Build the event log path for a team. */
export function orchestratorEventLogPath(repoRoot, teamName) {
    return join(repoRoot, '.omc', 'state', 'team', teamName, 'orchestrator-events.jsonl');
}
//# sourceMappingURL=git-fixture.js.map