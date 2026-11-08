import { afterAll, describe, expect, it, beforeEach, afterEach } from 'vitest';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, cpSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync, symlinkSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { provisionStandaloneStateLockBridge } from '../index.js';
// @ts-expect-error Standalone hook runtime source is intentionally JavaScript-only.
import { publishCacheOccupancy } from '../../../scripts/lib/cache-occupancy.mjs';
const REPO_ROOT = resolve(join(__dirname, '..', '..', '..'));
const TEMPLATE_ROOT = mkdtempSync(join(tmpdir(), 'omc-session-start-template-'));
const TEMPLATE_HOOKS_ROOT = join(TEMPLATE_ROOT, 'hooks');
cpSync(join(REPO_ROOT, 'templates', 'hooks'), TEMPLATE_HOOKS_ROOT, { recursive: true });
copyFileSync(join(REPO_ROOT, 'package.json'), join(TEMPLATE_ROOT, 'package.json'));
const STATE_LOCK_PATH = join(TEMPLATE_HOOKS_ROOT, 'lib', 'state-lock.mjs');
provisionStandaloneStateLockBridge(REPO_ROOT, STATE_LOCK_PATH);
const SCRIPT_PATH = join(TEMPLATE_HOOKS_ROOT, 'session-start.mjs');
const NODE = process.execPath;
afterAll(() => {
    rmSync(TEMPLATE_ROOT, { recursive: true, force: true });
});
function startPostToolFailureLockHolder(statePath) {
    const source = `import { openSync, writeSync, closeSync, unlinkSync, constants } from 'node:fs';
const lockPath = process.argv[1] + '.lock';
const fd = openSync(lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
writeSync(fd, JSON.stringify({ pid: process.pid, timestamp: Date.now() }), null, 'utf-8');
process.stdout.write('LOCKED\\n');
process.stdin.once('data', () => {
  try { closeSync(fd); unlinkSync(lockPath); process.exitCode = 0; }
  catch { process.exitCode = 1; }
});`;
    const child = spawn(NODE, ['--input-type=module', '-e', source, statePath], { stdio: ['pipe', 'pipe', 'pipe'] });
    let readyOutput = '';
    let exitResult = null;
    const exited = new Promise((resolve) => {
        child.once('exit', (code, signal) => {
            exitResult = { code, signal };
            resolve(exitResult);
        });
    });
    const ready = new Promise((resolve, reject) => {
        let settled = false;
        const timeout = setTimeout(() => finish(new Error(`Timed out waiting for lock holder: ${readyOutput}`)), 5000);
        const finish = (error) => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timeout);
            child.stdout.off('data', onStdout);
            child.stderr.off('data', onStderr);
            child.off('exit', onExit);
            child.off('error', onError);
            if (error)
                reject(error);
            else
                resolve();
        };
        const onStdout = (chunk) => {
            readyOutput += chunk.toString();
            if (readyOutput.includes('LOCKED\n'))
                finish();
        };
        const onStderr = (chunk) => { readyOutput += chunk.toString(); };
        const onExit = (code, signal) => {
            finish(new Error(`Lock holder exited before acquisition (${code ?? signal}): ${readyOutput}`));
        };
        const onError = (error) => finish(error);
        child.stdout.on('data', onStdout);
        child.stderr.on('data', onStderr);
        child.once('exit', onExit);
        child.once('error', onError);
    });
    const waitForExit = async (timeoutMs) => {
        if (exitResult)
            return exitResult;
        let timeout;
        const timedOut = new Promise((resolve) => {
            timeout = setTimeout(() => resolve(null), timeoutMs);
        });
        const result = await Promise.race([exited, timedOut]);
        if (timeout)
            clearTimeout(timeout);
        return result;
    };
    return {
        ready,
        async release() {
            if (!exitResult && child.stdin.writable && !child.stdin.writableEnded)
                child.stdin.end('release');
            let result = await waitForExit(5000);
            if (!result) {
                child.kill();
                result = await waitForExit(1000);
            }
            return result;
        },
    };
}
function startSessionStartProcess(scriptPath, fakeHome, input, extraEnv = {}) {
    const child = spawn(NODE, [scriptPath], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, HOME: fakeHome, USERPROFILE: fakeHome, ...extraEnv },
    });
    let stdout = '';
    let stderr = '';
    const output = new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            child.kill();
            reject(new Error(`SessionStart timed out: ${stderr}`));
        }, 30_000);
        child.stdout.on('data', chunk => { stdout += chunk.toString(); });
        child.stderr.on('data', chunk => { stderr += chunk.toString(); });
        child.once('error', error => {
            clearTimeout(timeout);
            reject(error);
        });
        child.once('exit', (code, signal) => {
            clearTimeout(timeout);
            if (code === 0)
                resolve(stdout.trim());
            else
                reject(new Error(`SessionStart exited (${code ?? signal}): ${stderr}`));
        });
    });
    child.stdin.end(JSON.stringify(input));
    return { child, output };
}
async function waitForFilesToDisappear(paths, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (paths.every(path => !existsSync(path)))
            return true;
        await new Promise(resolve => setTimeout(resolve, 25));
    }
    return paths.every(path => !existsSync(path));
}
async function waitForFilesToAppear(paths, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (paths.every(path => existsSync(path)))
            return true;
        await new Promise(resolve => setTimeout(resolve, 25));
    }
    return paths.every(path => existsSync(path));
}
describe('session-start template retired-state handling', () => {
    let tempDir;
    let fakeHome;
    let fakeProject;
    beforeEach(() => {
        tempDir = mkdtempSync(join(tmpdir(), 'omc-session-start-template-'));
        fakeHome = join(tempDir, 'home');
        fakeProject = join(tempDir, 'project');
        mkdirSync(join(fakeProject, '.omc', 'state'), { recursive: true });
        // Add .git so validateCwd accepts this directory as a valid workspace anchor
        mkdirSync(join(fakeProject, '.git'), { recursive: true });
    });
    afterEach(() => {
        rmSync(tempDir, { recursive: true, force: true });
    });
    function runSessionStart(input, extraEnv = {}) {
        const raw = execFileSync(NODE, [SCRIPT_PATH], {
            input: JSON.stringify(input),
            encoding: 'utf-8',
            env: {
                ...process.env,
                HOME: fakeHome,
                USERPROFILE: fakeHome,
                ...extraEnv,
            },
            timeout: 15000,
        }).trim();
        return JSON.parse(raw);
    }
    it('ignores retired ultrawork state from a different active session', () => {
        const now = new Date().toISOString();
        writeFileSync(join(fakeProject, '.omc', 'state', 'ultrawork-state.json'), JSON.stringify({
            active: true,
            session_id: 'session-a',
            started_at: now,
            last_checked_at: now,
            original_prompt: 'Old task that should not bleed into session-b',
        }));
        const output = runSessionStart({
            hook_event_name: 'SessionStart',
            session_id: 'session-b',
            cwd: fakeProject,
        });
        const context = output.hookSpecificOutput?.additionalContext || '';
        expect(output.continue).toBe(true);
        expect(context).not.toContain('[PARALLEL SESSION WARNING]');
        expect(context).not.toContain('[ULTRAWORK MODE RESTORED]');
        expect(context).not.toContain('Old task that should not bleed into session-b');
    });
    it('purges legacy tool-failure state without disturbing unrelated inactive-session state', () => {
        const stateDir = join(fakeProject, '.omc', 'state');
        const oldSessionDir = join(stateDir, 'sessions', 'session-old-without-marker');
        mkdirSync(oldSessionDir, { recursive: true });
        const legacyRootError = join(stateDir, 'last-tool-error.json');
        const legacySessionError = join(oldSessionDir, 'last-tool-error-state.json');
        const unrelatedState = join(oldSessionDir, 'unrelated-state.json');
        writeFileSync(legacyRootError, JSON.stringify({ tool_input_preview: 'legacy input secret', error: 'legacy raw error' }));
        writeFileSync(legacySessionError, JSON.stringify({ tool_input_preview: 'legacy input secret', error: 'legacy raw error' }));
        writeFileSync(unrelatedState, 'preserve this state');
        const output = runSessionStart({
            hook_event_name: 'SessionStart',
            session_id: 'session-current',
            cwd: fakeProject,
        }, { CLAUDE_PLUGIN_ROOT: '', OMC_STATE_DIR: '' });
        expect(output.continue).toBe(true);
        expect(existsSync(legacyRootError)).toBe(false);
        expect(existsSync(legacySessionError)).toBe(false);
        expect(existsSync(join(oldSessionDir, 'session-started.json'))).toBe(false);
        expect(readFileSync(unrelatedState, 'utf-8')).toBe('preserve this state');
    });
    it('preserves sanitized canonical tool-failure records and their retry counts', () => {
        const stateDir = join(fakeProject, '.omc', 'state');
        const sessionDir = join(stateDir, 'sessions', 'session-retry-state');
        mkdirSync(sessionDir, { recursive: true });
        const rootPath = join(stateDir, 'last-tool-error.json');
        const sessionPath = join(sessionDir, 'last-tool-error-state.json');
        const rootState = {
            tool_name: 'Bash',
            error: 'Tool execution failed (details omitted for privacy).',
            timestamp: new Date().toISOString(),
            retry_count: 4,
        };
        const sessionState = { ...rootState, retry_count: 7 };
        writeFileSync(rootPath, JSON.stringify(rootState));
        writeFileSync(sessionPath, JSON.stringify(sessionState));
        const output = runSessionStart({
            hook_event_name: 'SessionStart',
            session_id: 'session-current',
            cwd: fakeProject,
        }, { CLAUDE_PLUGIN_ROOT: '', OMC_STATE_DIR: '' });
        expect(output.continue).toBe(true);
        expect(JSON.parse(readFileSync(rootPath, 'utf-8'))).toEqual(rootState);
        expect(JSON.parse(readFileSync(sessionPath, 'utf-8'))).toEqual(sessionState);
    });
    it('purges legacy atomic temp files but preserves a fresh sanitized temp', () => {
        const stateDir = join(fakeProject, '.omc', 'state');
        const sessionDir = join(stateDir, 'sessions', 'session-temp-files');
        mkdirSync(sessionDir, { recursive: true });
        const legacyPaths = [
            join(stateDir, `.last-tool-error.json.tmp.${randomUUID()}`),
            join(stateDir, `.last-tool-error-state.json.tmp.${randomUUID()}`),
            join(sessionDir, `.last-tool-error.json.tmp.${randomUUID()}`),
            join(sessionDir, `.last-tool-error-state.json.tmp.${randomUUID()}`),
        ];
        for (const path of legacyPaths)
            writeFileSync(path, JSON.stringify({ tool_input_preview: 'legacy temp secret', error: 'legacy raw error' }));
        const freshPath = join(stateDir, `.last-tool-error.json.tmp.${randomUUID()}`);
        const unrelatedTempPath = join(stateDir, '.last-tool-error.json.tmp.not-a-uuid');
        writeFileSync(freshPath, JSON.stringify({
            tool_name: 'Bash',
            error: 'Tool execution failed (details omitted for privacy).',
            timestamp: new Date().toISOString(),
            retry_count: 4,
        }));
        writeFileSync(unrelatedTempPath, 'not an atomic temp name');
        const output = runSessionStart({
            hook_event_name: 'SessionStart',
            session_id: 'session-current',
            cwd: fakeProject,
        }, { CLAUDE_PLUGIN_ROOT: '', OMC_STATE_DIR: '' });
        expect(output.continue).toBe(true);
        for (const path of legacyPaths)
            expect(existsSync(path)).toBe(false);
        expect(existsSync(freshPath)).toBe(true);
        expect(existsSync(unrelatedTempPath)).toBe(true);
    });
    it('preserves an in-flight legacy temp until the PostToolUseFailure lock is released', async () => {
        const stateDir = join(fakeProject, '.omc', 'state');
        const canonicalPath = join(stateDir, 'last-tool-error.json');
        const tempPath = join(stateDir, `.last-tool-error.json.tmp.${randomUUID()}`);
        const holder = startPostToolFailureLockHolder(canonicalPath);
        let sessionStart;
        try {
            await holder.ready;
            writeFileSync(tempPath, '{"tool_input_preview":"in-flight legacy payload"');
            expect(existsSync(tempPath)).toBe(true);
            sessionStart = startSessionStartProcess(SCRIPT_PATH, fakeHome, {
                hook_event_name: 'SessionStart',
                session_id: 'session-current',
                cwd: fakeProject,
            }, {
                CLAUDE_PLUGIN_ROOT: '',
                OMC_STATE_DIR: '',
                OMC_TEST_TOOL_FAILURE_LOCK_WAIT_MS: '100',
            });
            const output = JSON.parse(await sessionStart.output);
            expect(output.continue).toBe(true);
            expect(existsSync(tempPath)).toBe(true);
            expect(await holder.release()).toEqual({ code: 0, signal: null });
            expect(await waitForFilesToDisappear([tempPath], 15_000)).toBe(true);
        }
        finally {
            await holder.release();
            if (sessionStart)
                await sessionStart.output.catch(() => '');
        }
    });
    it('defers cleanup for locked root and session state until the locks are released', async () => {
        const stateDir = join(fakeProject, '.omc', 'state');
        const sessionDir = join(stateDir, 'sessions', 'session-locked');
        mkdirSync(sessionDir, { recursive: true });
        const rootPath = join(stateDir, 'last-tool-error.json');
        const sessionPath = join(sessionDir, 'last-tool-error-state.json');
        const rootTemp = join(stateDir, `.last-tool-error.json.tmp.${randomUUID()}`);
        const sessionTemp = join(sessionDir, `.last-tool-error-state.json.tmp.${randomUUID()}`);
        const cleanupPaths = [rootPath, rootTemp, sessionPath, sessionTemp];
        const rootHolder = startPostToolFailureLockHolder(rootPath);
        const sessionHolder = startPostToolFailureLockHolder(sessionPath);
        let sessionStart;
        try {
            await Promise.all([rootHolder.ready, sessionHolder.ready]);
            writeFileSync(rootPath, JSON.stringify({ tool_input_preview: 'root legacy payload', error: 'legacy root error' }));
            writeFileSync(rootTemp, '{"tool_input_preview":"root legacy temp"');
            writeFileSync(sessionPath, JSON.stringify({ tool_input_preview: 'session legacy payload', error: 'legacy session error' }));
            writeFileSync(sessionTemp, '{"tool_input_preview":"session legacy payload"');
            sessionStart = startSessionStartProcess(SCRIPT_PATH, fakeHome, {
                hook_event_name: 'SessionStart',
                session_id: 'session-current',
                cwd: fakeProject,
            }, {
                CLAUDE_PLUGIN_ROOT: '',
                OMC_STATE_DIR: '',
                OMC_HOOK_BACKGROUND_CHILD: '0',
                OMC_TEST_TOOL_FAILURE_LOCK_WAIT_MS: '100',
            });
            const output = JSON.parse(await sessionStart.output);
            expect(output.continue).toBe(true);
            expect(cleanupPaths.every(path => existsSync(path))).toBe(true);
            expect(await rootHolder.release()).toEqual({ code: 0, signal: null });
            expect(await sessionHolder.release()).toEqual({ code: 0, signal: null });
            expect(await waitForFilesToDisappear(cleanupPaths, 15_000)).toBe(true);
        }
        finally {
            await Promise.all([rootHolder.release(), sessionHolder.release()]);
            if (sessionStart)
                await sessionStart.output.catch(() => '');
        }
    });
    it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('continues when failure-state lock creation is denied', async () => {
        const stateDir = join(fakeProject, '.omc', 'state');
        const legacyPath = join(stateDir, 'last-tool-error.json');
        writeFileSync(legacyPath, JSON.stringify({ tool_input_preview: 'read-only legacy secret' }));
        chmodSync(stateDir, 0o555);
        let sessionStart;
        try {
            sessionStart = startSessionStartProcess(SCRIPT_PATH, fakeHome, {
                hook_event_name: 'SessionStart',
                session_id: 'session-current',
                cwd: fakeProject,
            }, {
                CLAUDE_PLUGIN_ROOT: '',
                OMC_STATE_DIR: '',
                OMC_HOOK_BACKGROUND_CHILD: '0',
                OMC_TEST_TOOL_FAILURE_LOCK_WAIT_MS: '100',
            });
            const output = JSON.parse(await sessionStart.output);
            expect(output.continue).toBe(true);
            expect(existsSync(legacyPath)).toBe(true);
        }
        finally {
            chmodSync(stateDir, 0o755);
            if (sessionStart)
                await sessionStart.output.catch(() => '');
        }
    });
    it('retries deferred cleanup after its own lock wait expires', async () => {
        const stateDir = join(fakeProject, '.omc', 'state');
        const legacyPath = join(stateDir, 'last-tool-error.json');
        const deferredCleanupReadyPath = join(tempDir, 'deferred-cleanup-ready');
        const holder = startPostToolFailureLockHolder(legacyPath);
        try {
            await holder.ready;
            writeFileSync(legacyPath, JSON.stringify({ tool_input_preview: 'deferred legacy secret' }));
            const cleanup = spawnSync(NODE, [SCRIPT_PATH, '--purge-legacy-tool-failure-state', join(fakeProject, '.omc'), '100'], {
                encoding: 'utf-8',
                timeout: 30_000,
                env: {
                    ...process.env,
                    OMC_HOOK_BACKGROUND_CHILD: '1',
                    OMC_TEST_TOOL_FAILURE_DEFERRED_CLEANUP_READY_PATH: deferredCleanupReadyPath,
                },
            });
            expect(cleanup.error).toBeUndefined();
            expect(cleanup.status).toBe(0);
            expect(await waitForFilesToAppear([deferredCleanupReadyPath], 15_000)).toBe(true);
            expect(existsSync(legacyPath)).toBe(true);
            expect(await holder.release()).toEqual({ code: 0, signal: null });
            expect(await waitForFilesToDisappear([legacyPath], 15_000)).toBe(true);
        }
        finally {
            await holder.release();
        }
    });
    it('rescans root and newly created session records after the startup snapshot', async () => {
        const stateDir = join(fakeProject, '.omc', 'state');
        const rootPath = join(stateDir, 'last-tool-error.json');
        const lateSessionDir = join(stateDir, 'sessions', 'session-created-after-start');
        const lateSessionPath = join(lateSessionDir, 'last-tool-error-state.json');
        const workerLockPath = join(stateDir, '.legacy-tool-failure-cleanup-worker.lock');
        const initialScanReadyPath = join(tempDir, 'initial-scan-ready');
        const initialScanReleasePath = join(tempDir, 'initial-scan-release');
        const sessionStart = startSessionStartProcess(SCRIPT_PATH, fakeHome, {
            hook_event_name: 'SessionStart',
            session_id: 'session-current',
            cwd: fakeProject,
        }, {
            CLAUDE_PLUGIN_ROOT: '',
            OMC_STATE_DIR: '',
            OMC_HOOK_BACKGROUND_CHILD: '0',
            OMC_TEST_TOOL_FAILURE_STABILIZATION_MS: '1500',
            OMC_TEST_TOOL_FAILURE_INITIAL_SCAN_READY_PATH: initialScanReadyPath,
            OMC_TEST_TOOL_FAILURE_INITIAL_SCAN_RELEASE_PATH: initialScanReleasePath,
        });
        try {
            expect(JSON.parse(await sessionStart.output).continue).toBe(true);
            expect(await waitForFilesToAppear([workerLockPath, initialScanReadyPath], 10_000)).toBe(true);
            mkdirSync(lateSessionDir, { recursive: true });
            writeFileSync(rootPath, JSON.stringify({ tool_input_preview: 'late root legacy secret' }));
            writeFileSync(lateSessionPath, JSON.stringify({ tool_input_preview: 'late session legacy secret' }));
            writeFileSync(initialScanReleasePath, 'continue');
            expect(await waitForFilesToDisappear([rootPath, lateSessionPath], 15_000)).toBe(true);
            expect(await waitForFilesToDisappear([workerLockPath], 15_000)).toBe(true);
        }
        finally {
            writeFileSync(initialScanReleasePath, 'continue');
            await sessionStart.output.catch(() => '');
        }
    });
    it('purges artifacts published between the last periodic scan and final scan', async () => {
        const stateDir = join(fakeProject, '.omc', 'state');
        const legacyPath = join(stateDir, 'last-tool-error.json');
        const workerLockPath = join(stateDir, '.legacy-tool-failure-cleanup-worker.lock');
        const finalScanReadyPath = join(tempDir, 'final-scan-ready');
        const finalScanReleasePath = join(tempDir, 'final-scan-release');
        const sessionStart = startSessionStartProcess(SCRIPT_PATH, fakeHome, {
            hook_event_name: 'SessionStart',
            session_id: 'session-current',
            cwd: fakeProject,
        }, {
            CLAUDE_PLUGIN_ROOT: '',
            OMC_STATE_DIR: '',
            OMC_HOOK_BACKGROUND_CHILD: '0',
            OMC_TEST_TOOL_FAILURE_STABILIZATION_MS: '1000',
            OMC_TEST_TOOL_FAILURE_FINAL_SCAN_READY_PATH: finalScanReadyPath,
            OMC_TEST_TOOL_FAILURE_FINAL_SCAN_RELEASE_PATH: finalScanReleasePath,
        });
        try {
            expect(JSON.parse(await sessionStart.output).continue).toBe(true);
            expect(await waitForFilesToAppear([workerLockPath, finalScanReadyPath], 10_000)).toBe(true);
            writeFileSync(legacyPath, JSON.stringify({ tool_input_preview: 'last-window legacy secret' }));
            writeFileSync(finalScanReleasePath, 'continue');
            expect(await waitForFilesToDisappear([legacyPath], 15_000)).toBe(true);
            expect(await waitForFilesToDisappear([workerLockPath], 15_000)).toBe(true);
        }
        finally {
            writeFileSync(finalScanReleasePath, 'continue');
            await sessionStart.output.catch(() => '');
        }
    });
    it('releases stabilization workers after unverifiable lock metadata', async () => {
        const stateDir = join(fakeProject, '.omc', 'state');
        const legacyPath = join(stateDir, 'last-tool-error.json');
        const workerLockPath = join(stateDir, '.legacy-tool-failure-cleanup-worker.lock');
        const initialScanReadyPath = join(tempDir, 'initial-scan-ready');
        const initialScanReleasePath = join(tempDir, 'initial-scan-release');
        writeFileSync(legacyPath, JSON.stringify({ tool_input_preview: 'unverifiable legacy secret' }));
        writeFileSync(`${legacyPath}.lock`, 'malformed lock metadata');
        const sessionStart = startSessionStartProcess(SCRIPT_PATH, fakeHome, {
            hook_event_name: 'SessionStart',
            session_id: 'session-current',
            cwd: fakeProject,
        }, {
            CLAUDE_PLUGIN_ROOT: '',
            OMC_STATE_DIR: '',
            OMC_HOOK_BACKGROUND_CHILD: '0',
            OMC_TEST_TOOL_FAILURE_STABILIZATION_MS: '1500',
            OMC_TEST_TOOL_FAILURE_INITIAL_SCAN_READY_PATH: initialScanReadyPath,
            OMC_TEST_TOOL_FAILURE_INITIAL_SCAN_RELEASE_PATH: initialScanReleasePath,
        });
        try {
            expect(JSON.parse(await sessionStart.output).continue).toBe(true);
            expect(await waitForFilesToAppear([workerLockPath, initialScanReadyPath], 10_000)).toBe(true);
            expect(existsSync(legacyPath)).toBe(true);
            expect(readFileSync(`${legacyPath}.lock`, 'utf-8')).toBe('malformed lock metadata');
            writeFileSync(initialScanReleasePath, 'continue');
            expect(await waitForFilesToDisappear([workerLockPath], 15_000)).toBe(true);
        }
        finally {
            writeFileSync(initialScanReleasePath, 'continue');
            await sessionStart.output.catch(() => '');
        }
    });
    it('stops waiting for the cleanup worker lock once the worker reaches its hard lifetime', async () => {
        const omcRoot = join(fakeProject, '.omc');
        const stateDir = join(omcRoot, 'state');
        const workerLockPath = join(stateDir, '.legacy-tool-failure-cleanup-worker.lock');
        const holder = startPostToolFailureLockHolder(join(stateDir, '.legacy-tool-failure-cleanup-worker'));
        let worker;
        let workerExit;
        try {
            await holder.ready;
            worker = spawn(NODE, [SCRIPT_PATH, '--stabilize-legacy-tool-failure-state', omcRoot, '50', '200'], {
                stdio: 'ignore',
                env: {
                    ...process.env,
                    HOME: fakeHome,
                    USERPROFILE: fakeHome,
                    CLAUDE_CONFIG_DIR: join(fakeHome, '.claude'),
                    CLAUDE_PLUGIN_ROOT: join(tempDir, 'plugin-cache', 'oh-my-claudecode', 'current'),
                    OMC_HOOK_BACKGROUND_CHILD: '1',
                },
            });
            const child = worker;
            workerExit = new Promise((resolve, reject) => {
                child.once('error', reject);
                child.once('exit', code => resolve({ code, at: Date.now() }));
            });
            // Free the lock long after the 200 ms lifetime but before the worker's own lock wait (about 3 s) could run out.
            await new Promise(resolve => setTimeout(resolve, 2500));
            const releasedAt = Date.now();
            expect(await holder.release()).toEqual({ code: 0, signal: null });
            const exit = await Promise.race([
                workerExit,
                new Promise(resolve => setTimeout(() => resolve(undefined), 5000)),
            ]);
            expect(exit?.code).toBe(0);
            // The worker left at its deadline while the lock was still held, not once the lock freed up.
            expect(exit.at).toBeLessThan(releasedAt);
            expect(existsSync(workerLockPath)).toBe(false);
        }
        finally {
            await holder.release();
            if (worker && worker.exitCode === null)
                worker.kill();
            await workerExit?.catch(() => undefined);
        }
    });
    it.skipIf(process.platform === 'win32')('bounds the plugin occupancy probe after the worker lock by the hard lifetime', async () => {
        const configDir = join(fakeHome, '.claude');
        const pluginParent = join(tempDir, 'plugin-cache', 'oh-my-claudecode');
        const omcRoot = join(fakeProject, '.omc');
        const stateDir = join(omcRoot, 'state');
        const legacyPath = join(stateDir, 'last-tool-error.json');
        const workerLockPath = join(stateDir, '.legacy-tool-failure-cleanup-worker.lock');
        const fakeBin = join(tempDir, 'fake-bin');
        const psLog = join(tempDir, 'ps.log');
        const slowMarker = join(tempDir, 'ps-slow-started');
        const platformPreload = join(tempDir, 'darwin-platform.mjs');
        const lstart = 'Tue Jan  6 09:00:00 2026';
        mkdirSync(fakeBin, { recursive: true });
        writeFileSync(platformPreload, "Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });\n");
        // The batched occupancy ps hangs once the worker lock exists; every other call answers at once.
        const ps = join(fakeBin, 'ps');
        writeFileSync(ps, [
            '#!/bin/sh',
            'echo "$@" >> "$PS_LOG"',
            'case "$4" in',
            '  pid=,lstart=)',
            '    if [ -e "$WORKER_LOCK" ]; then : > "$PS_SLOW_MARKER"; exec sleep 10; fi',
            '    IFS=,; for id in $2; do printf \'%5s %s\\n\' "$id" "$PS_LSTART"; done',
            '    ;;',
            '  *) echo "$PS_LSTART" ;;',
            'esac',
            '',
        ].join('\n'));
        chmodSync(ps, 0o755);
        const psEnv = { PATH: `${fakeBin}:${process.env.PATH}`, PS_LOG: psLog, PS_SLOW_MARKER: slowMarker, PS_LSTART: lstart, WORKER_LOCK: workerLockPath };
        // The first exec of a new script can take seconds on a loaded host, longer than the probe cap.
        spawnSync(ps, ['warmup'], { env: { ...psEnv, PS_LOG: '/dev/null' }, timeout: 30000 });
        // An older plugin version whose live session the fake ps confirms.
        expect(publishCacheOccupancy(join(pluginParent, 'older'), configDir, process.pid, String(new Date(lstart).getTime()))).toBe(true);
        writeFileSync(legacyPath, JSON.stringify({ tool_input_preview: 'legacy payload that outlives the worker' }));
        const worker = spawn(NODE, ['--import', platformPreload, SCRIPT_PATH, '--stabilize-legacy-tool-failure-state', omcRoot, '50', '400'], {
            stdio: 'ignore',
            env: {
                ...process.env,
                ...psEnv,
                HOME: fakeHome,
                USERPROFILE: fakeHome,
                CLAUDE_CONFIG_DIR: configDir,
                CLAUDE_PLUGIN_ROOT: join(pluginParent, 'current'),
                OMC_HOOK_BACKGROUND_CHILD: '1',
            },
        });
        const workerExit = new Promise((resolve, reject) => {
            worker.once('error', reject);
            worker.once('exit', code => resolve({ code, at: Date.now() }));
        });
        try {
            expect(await waitForFilesToAppear([slowMarker], 5000)).toBe(true);
            const probeStartedAt = Date.now();
            const exit = await Promise.race([
                workerExit,
                new Promise(resolve => setTimeout(() => resolve(undefined), 6000)),
            ]);
            expect(exit?.code).toBe(0);
            // The probe is cut off by the 400 ms lifetime, not by the 2 s darwin ps timeout.
            expect(exit.at - probeStartedAt).toBeLessThan(1200);
            expect(existsSync(workerLockPath)).toBe(false);
            expect(existsSync(legacyPath)).toBe(true);
            // One batched ps per scan: before the worker lock and after it.
            const batchedCalls = readFileSync(psLog, 'utf8').split('\n').filter(line => line.endsWith('-o pid=,lstart='));
            expect(batchedCalls).toHaveLength(2);
        }
        finally {
            if (worker.exitCode === null)
                worker.kill();
            await workerExit.catch(() => undefined);
        }
    });
    it('lets stabilization workers exit while sanitized failure records remain', async () => {
        const stateDir = join(fakeProject, '.omc', 'state');
        const legacyPath = join(stateDir, 'last-tool-error.json');
        const workerLockPath = join(stateDir, '.legacy-tool-failure-cleanup-worker.lock');
        const initialScanReadyPath = join(tempDir, 'initial-scan-ready');
        const initialScanReleasePath = join(tempDir, 'initial-scan-release');
        const sanitizedState = {
            tool_name: 'Bash',
            error: 'Tool execution failed (details omitted for privacy).',
            timestamp: new Date().toISOString(),
            retry_count: 1,
        };
        writeFileSync(legacyPath, JSON.stringify(sanitizedState));
        const sessionStart = startSessionStartProcess(SCRIPT_PATH, fakeHome, {
            hook_event_name: 'SessionStart',
            session_id: 'session-current',
            cwd: fakeProject,
        }, {
            CLAUDE_PLUGIN_ROOT: '',
            OMC_STATE_DIR: '',
            OMC_HOOK_BACKGROUND_CHILD: '0',
            OMC_TEST_TOOL_FAILURE_STABILIZATION_MS: '1500',
            OMC_TEST_TOOL_FAILURE_INITIAL_SCAN_READY_PATH: initialScanReadyPath,
            OMC_TEST_TOOL_FAILURE_INITIAL_SCAN_RELEASE_PATH: initialScanReleasePath,
        });
        try {
            expect(JSON.parse(await sessionStart.output).continue).toBe(true);
            expect(await waitForFilesToAppear([workerLockPath, initialScanReadyPath], 10_000)).toBe(true);
            writeFileSync(initialScanReleasePath, 'continue');
            expect(await waitForFilesToDisappear([workerLockPath], 15_000)).toBe(true);
            expect(JSON.parse(readFileSync(legacyPath, 'utf-8'))).toEqual(sanitizedState);
        }
        finally {
            writeFileSync(initialScanReleasePath, 'continue');
            await sessionStart.output.catch(() => '');
        }
    });
    it('keeps stabilization active while an older plugin root is occupied', async () => {
        const configDir = join(fakeHome, '.claude');
        const pluginParent = join(tempDir, 'plugin-cache', 'oh-my-claudecode');
        const currentPluginRoot = join(pluginParent, 'current');
        const olderPluginRoot = join(pluginParent, 'older');
        const registryDir = join(configDir, '.omc', 'cache-occupancy');
        const workerLockPath = join(fakeProject, '.omc', 'state', '.legacy-tool-failure-cleanup-worker.lock');
        const initialScanReadyPath = join(tempDir, 'initial-scan-ready');
        const initialScanReleasePath = join(tempDir, 'initial-scan-release');
        const sessionStart = startSessionStartProcess(SCRIPT_PATH, fakeHome, {
            hook_event_name: 'SessionStart',
            session_id: 'session-current',
            cwd: fakeProject,
        }, {
            CLAUDE_CONFIG_DIR: configDir,
            CLAUDE_PLUGIN_ROOT: currentPluginRoot,
            OMC_STATE_DIR: '',
            OMC_HOOK_BACKGROUND_CHILD: '0',
            OMC_TEST_TOOL_FAILURE_STABILIZATION_MS: '5000',
            OMC_TEST_TOOL_FAILURE_INITIAL_SCAN_READY_PATH: initialScanReadyPath,
            OMC_TEST_TOOL_FAILURE_INITIAL_SCAN_RELEASE_PATH: initialScanReleasePath,
        });
        try {
            expect(JSON.parse(await sessionStart.output).continue).toBe(true);
            expect(await waitForFilesToAppear([workerLockPath, initialScanReadyPath], 30_000)).toBe(true);
            expect(publishCacheOccupancy(olderPluginRoot, configDir, process.pid)).toBe(true);
            writeFileSync(initialScanReleasePath, 'continue');
            await new Promise(resolve => setTimeout(resolve, 5200));
            expect(existsSync(workerLockPath)).toBe(true);
            rmSync(registryDir, { recursive: true, force: true });
            expect(await waitForFilesToDisappear([workerLockPath], 15_000)).toBe(true);
        }
        finally {
            writeFileSync(initialScanReleasePath, 'continue');
            rmSync(registryDir, { recursive: true, force: true });
            await sessionStart.output.catch(() => '');
        }
    });
    it('stops waiting for other plugin versions once the worker reaches its hard lifetime', async () => {
        const configDir = join(fakeHome, '.claude');
        const pluginParent = join(tempDir, 'plugin-cache', 'oh-my-claudecode');
        const currentPluginRoot = join(pluginParent, 'current');
        const olderPluginRoot = join(pluginParent, 'older');
        const registryDir = join(configDir, '.omc', 'cache-occupancy');
        const omcRoot = join(fakeProject, '.omc');
        const workerLockPath = join(omcRoot, 'state', '.legacy-tool-failure-cleanup-worker.lock');
        expect(publishCacheOccupancy(olderPluginRoot, configDir, process.pid)).toBe(true);
        const startedAt = Date.now();
        const worker = spawn(NODE, [SCRIPT_PATH, '--stabilize-legacy-tool-failure-state', omcRoot, '500', '3000'], {
            stdio: 'ignore',
            env: {
                ...process.env,
                HOME: fakeHome,
                USERPROFILE: fakeHome,
                CLAUDE_CONFIG_DIR: configDir,
                CLAUDE_PLUGIN_ROOT: currentPluginRoot,
                OMC_HOOK_BACKGROUND_CHILD: '1',
            },
        });
        const workerExit = new Promise((resolve, reject) => {
            worker.once('error', reject);
            worker.once('exit', code => resolve(code));
        });
        try {
            expect(await waitForFilesToAppear([workerLockPath], 5000)).toBe(true);
            // Past the 500 ms stabilization window the older version still holds the worker.
            await new Promise(resolve => setTimeout(resolve, 1000));
            expect(worker.exitCode).toBeNull();
            const exitCode = await Promise.race([
                workerExit,
                new Promise(resolve => setTimeout(() => resolve(undefined), 7000)),
            ]);
            expect(exitCode).toBe(0);
            expect(Date.now() - startedAt).toBeGreaterThanOrEqual(3000);
            expect(existsSync(workerLockPath)).toBe(false);
            // The older version never exited: the worker gave up waiting for it.
            expect(readdirSync(registryDir)).toHaveLength(1);
        }
        finally {
            rmSync(registryDir, { recursive: true, force: true });
            if (worker.exitCode === null)
                worker.kill();
            await workerExit.catch(() => undefined);
        }
    });
    it('stops waiting for the state directory once the worker reaches its hard lifetime', async () => {
        const configDir = join(fakeHome, '.claude');
        const pluginParent = join(tempDir, 'plugin-cache', 'oh-my-claudecode');
        const currentPluginRoot = join(pluginParent, 'current');
        const olderPluginRoot = join(pluginParent, 'older');
        const registryDir = join(configDir, '.omc', 'cache-occupancy');
        const omcRoot = join(fakeProject, '.omc');
        const stateDir = join(omcRoot, 'state');
        rmSync(stateDir, { recursive: true, force: true });
        expect(publishCacheOccupancy(olderPluginRoot, configDir, process.pid)).toBe(true);
        const startedAt = Date.now();
        const worker = spawn(NODE, [SCRIPT_PATH, '--stabilize-legacy-tool-failure-state', omcRoot, '500', '2000'], {
            stdio: 'ignore',
            env: {
                ...process.env,
                HOME: fakeHome,
                USERPROFILE: fakeHome,
                CLAUDE_CONFIG_DIR: configDir,
                CLAUDE_PLUGIN_ROOT: currentPluginRoot,
                OMC_HOOK_BACKGROUND_CHILD: '1',
            },
        });
        const workerExit = new Promise((resolve, reject) => {
            worker.once('error', reject);
            worker.once('exit', code => resolve(code));
        });
        try {
            // Past the 500 ms window the older version still keeps the worker waiting.
            await new Promise(resolve => setTimeout(resolve, 500));
            expect(worker.exitCode).toBeNull();
            const exitCode = await Promise.race([
                workerExit,
                new Promise(resolve => setTimeout(() => resolve(undefined), 6000)),
            ]);
            expect(exitCode).toBe(0);
            expect(Date.now() - startedAt).toBeGreaterThanOrEqual(2000);
            expect(existsSync(stateDir)).toBe(false);
            // The older version never exited: the worker gave up waiting for it.
            expect(readdirSync(registryDir)).toHaveLength(1);
        }
        finally {
            rmSync(registryDir, { recursive: true, force: true });
            if (worker.exitCode === null)
                worker.kill();
            await workerExit.catch(() => undefined);
        }
    });
    it('leaves legacy artifacts in place when the cleanup lock frees up after the hard lifetime', async () => {
        const omcRoot = join(fakeProject, '.omc');
        const stateDir = join(omcRoot, 'state');
        const legacyPath = join(stateDir, 'last-tool-error.json');
        const workerLockPath = join(stateDir, '.legacy-tool-failure-cleanup-worker.lock');
        writeFileSync(legacyPath, JSON.stringify({ tool_input_preview: 'legacy payload that outlives the worker' }));
        const holder = startPostToolFailureLockHolder(legacyPath);
        let worker;
        let workerExit;
        try {
            await holder.ready;
            worker = spawn(NODE, [SCRIPT_PATH, '--stabilize-legacy-tool-failure-state', omcRoot, '500', '1000'], {
                stdio: 'ignore',
                env: {
                    ...process.env,
                    HOME: fakeHome,
                    USERPROFILE: fakeHome,
                    CLAUDE_CONFIG_DIR: join(fakeHome, '.claude'),
                    CLAUDE_PLUGIN_ROOT: join(tempDir, 'plugin-cache', 'oh-my-claudecode', 'current'),
                    OMC_HOOK_BACKGROUND_CHILD: '1',
                },
            });
            const child = worker;
            workerExit = new Promise((resolve, reject) => {
                child.once('error', reject);
                child.once('exit', code => resolve({ code, at: Date.now() }));
            });
            expect(await waitForFilesToAppear([workerLockPath], 5000)).toBe(true);
            // Free the lock after the 1000 ms lifetime but before the 2500 ms cleanup wait runs out.
            await new Promise(resolve => setTimeout(resolve, 1700));
            const releasedAt = Date.now();
            expect(await holder.release()).toEqual({ code: 0, signal: null });
            const exit = await Promise.race([
                workerExit,
                new Promise(resolve => setTimeout(() => resolve(undefined), 5000)),
            ]);
            expect(exit?.code).toBe(0);
            expect(existsSync(legacyPath)).toBe(true);
            // The worker left at its deadline while the lock was still held, not once the lock freed up.
            expect(exit.at).toBeLessThan(releasedAt);
            expect(existsSync(workerLockPath)).toBe(false);
        }
        finally {
            await holder.release();
            if (worker && worker.exitCode === null)
                worker.kill();
            await workerExit?.catch(() => undefined);
        }
    });
    it('keeps stabilization active while plugin occupancy is unavailable', async () => {
        const configDir = join(fakeHome, '.claude');
        const pluginParent = join(tempDir, 'plugin-cache', 'oh-my-claudecode');
        const currentPluginRoot = join(pluginParent, 'current');
        const registryDir = join(configDir, '.omc', 'cache-occupancy');
        const workerLockPath = join(fakeProject, '.omc', 'state', '.legacy-tool-failure-cleanup-worker.lock');
        mkdirSync(join(configDir, '.omc'), { recursive: true });
        writeFileSync(registryDir, 'temporarily unavailable');
        const sessionStart = startSessionStartProcess(SCRIPT_PATH, fakeHome, {
            hook_event_name: 'SessionStart',
            session_id: 'session-current',
            cwd: fakeProject,
        }, {
            CLAUDE_CONFIG_DIR: configDir,
            CLAUDE_PLUGIN_ROOT: currentPluginRoot,
            OMC_STATE_DIR: '',
            OMC_HOOK_BACKGROUND_CHILD: '0',
            OMC_TEST_TOOL_FAILURE_STABILIZATION_MS: '500',
        });
        try {
            expect(JSON.parse(await sessionStart.output).continue).toBe(true);
            expect(await waitForFilesToAppear([workerLockPath], 5000)).toBe(true);
            await new Promise(resolve => setTimeout(resolve, 750));
            expect(existsSync(workerLockPath)).toBe(true);
            rmSync(registryDir, { force: true });
            mkdirSync(registryDir, { recursive: true });
            expect(await waitForFilesToDisappear([workerLockPath], 7000)).toBe(true);
        }
        finally {
            rmSync(registryDir, { recursive: true, force: true });
            await sessionStart.output.catch(() => '');
        }
    });
    it('waits for state-directory creation while an older plugin root is occupied', async () => {
        const configDir = join(fakeHome, '.claude');
        const pluginParent = join(tempDir, 'plugin-cache', 'oh-my-claudecode');
        const currentPluginRoot = join(pluginParent, 'current');
        const olderPluginRoot = join(pluginParent, 'older');
        const registryDir = join(configDir, '.omc', 'cache-occupancy');
        const omcRoot = join(fakeProject, '.omc');
        const stateDir = join(omcRoot, 'state');
        const legacyPath = join(stateDir, 'last-tool-error.json');
        rmSync(stateDir, { recursive: true, force: true });
        expect(publishCacheOccupancy(olderPluginRoot, configDir, process.pid)).toBe(true);
        const worker = spawn(NODE, [SCRIPT_PATH, '--stabilize-legacy-tool-failure-state', omcRoot, '500'], {
            stdio: 'ignore',
            env: {
                ...process.env,
                HOME: fakeHome,
                USERPROFILE: fakeHome,
                CLAUDE_CONFIG_DIR: configDir,
                CLAUDE_PLUGIN_ROOT: currentPluginRoot,
                OMC_HOOK_BACKGROUND_CHILD: '1',
                OMC_TEST_TOOL_FAILURE_STABILIZATION_MS: '500',
            },
        });
        const workerExit = new Promise((resolve, reject) => {
            worker.once('error', reject);
            worker.once('exit', code => resolve(code));
        });
        try {
            await new Promise(resolve => setTimeout(resolve, 100));
            expect(worker.exitCode).toBeNull();
            mkdirSync(stateDir, { recursive: true });
            writeFileSync(legacyPath, JSON.stringify({ tool_input_preview: 'late legacy secret' }));
            expect(await waitForFilesToDisappear([legacyPath], 5000)).toBe(true);
            rmSync(registryDir, { recursive: true, force: true });
            const exitCode = await Promise.race([
                workerExit,
                new Promise(resolve => setTimeout(() => resolve(undefined), 7000)),
            ]);
            expect(exitCode).toBe(0);
        }
        finally {
            rmSync(registryDir, { recursive: true, force: true });
            if (worker.exitCode === null)
                worker.kill();
            await workerExit.catch(() => undefined);
        }
    });
    it('purges legacy tool-failure state from the home root on no-workspace startup', () => {
        const homeStateDir = join(fakeHome, '.omc', 'state');
        const homeSessionDir = join(homeStateDir, 'sessions', 'session-old-home');
        const otherWorkspaceRecord = join(fakeProject, '.omc', 'state', 'last-tool-error.json');
        mkdirSync(homeSessionDir, { recursive: true });
        const homeRootRecord = join(homeStateDir, 'last-tool-error.json');
        const homeSessionRecord = join(homeSessionDir, 'last-tool-error-state.json');
        writeFileSync(homeRootRecord, JSON.stringify({ tool_input_preview: 'legacy home secret' }));
        writeFileSync(homeSessionRecord, JSON.stringify({ tool_input_preview: 'legacy home session secret' }));
        writeFileSync(otherWorkspaceRecord, JSON.stringify({ tool_input_preview: 'unrelated workspace secret' }));
        const output = runSessionStart({
            hook_event_name: 'SessionStart',
            session_id: 'session-no-workspace',
            cwd: tempDir,
        }, { CLAUDE_PLUGIN_ROOT: '', OMC_STATE_DIR: '' });
        expect(output.continue).toBe(true);
        expect(existsSync(homeRootRecord)).toBe(false);
        expect(existsSync(homeSessionRecord)).toBe(false);
        expect(existsSync(otherWorkspaceRecord)).toBe(true);
        const customRoot = join(tempDir, 'custom-state');
        const customStateDir = join(customRoot, 'non-git', 'state');
        const customSessionDir = join(customStateDir, 'sessions', 'session-old-custom');
        mkdirSync(customSessionDir, { recursive: true });
        const customRootRecord = join(customStateDir, 'last-tool-error.json');
        const customSessionRecord = join(customSessionDir, 'last-tool-error-state.json');
        writeFileSync(customRootRecord, JSON.stringify({ tool_input_preview: 'legacy custom-root secret' }));
        writeFileSync(customSessionRecord, JSON.stringify({ tool_input_preview: 'legacy custom-session secret' }));
        const customOutput = runSessionStart({
            hook_event_name: 'SessionStart',
            session_id: 'session-no-workspace-custom',
            cwd: tempDir,
        }, { CLAUDE_PLUGIN_ROOT: '', OMC_STATE_DIR: customRoot });
        expect(customOutput.continue).toBe(true);
        expect(existsSync(customRootRecord)).toBe(false);
        expect(existsSync(customSessionRecord)).toBe(false);
        expect(existsSync(otherWorkspaceRecord)).toBe(true);
    });
    it('publishes plugin occupancy before deferring no-workspace cleanup', () => {
        const pluginRoot = join(tempDir, 'plugins', 'cache', 'omc', 'current');
        const configDir = join(tempDir, 'claude-config');
        const registryDir = join(configDir, '.omc', 'cache-occupancy');
        mkdirSync(pluginRoot, { recursive: true });
        const output = runSessionStart({
            hook_event_name: 'SessionStart',
            session_id: 'session-no-workspace-plugin',
            cwd: tempDir,
        }, {
            CLAUDE_CONFIG_DIR: configDir,
            CLAUDE_PLUGIN_ROOT: pluginRoot,
            OMC_SESSION_OWNER_PID: String(process.pid),
            OMC_STATE_DIR: '',
            OMC_TEST_TOOL_FAILURE_STABILIZATION_MS: '0',
            NODE_ENV: 'test',
        });
        expect(output.continue).toBe(true);
        const records = readdirSync(registryDir).map(name => JSON.parse(readFileSync(join(registryDir, name), 'utf-8')));
        expect(records).toHaveLength(1);
        expect(records[0]).toMatchObject({ pid: process.pid, pluginRoot });
        expect(records[0].processStartIdentity).toEqual(expect.any(String));
    });
    it.skipIf(process.platform === 'win32')('does not follow symlinked session directories or state files', () => {
        const sessionsDir = join(fakeProject, '.omc', 'state', 'sessions');
        mkdirSync(sessionsDir, { recursive: true });
        const externalSessionDir = join(tempDir, 'external-session');
        mkdirSync(externalSessionDir, { recursive: true });
        const externalDirectoryState = join(externalSessionDir, 'last-tool-error-state.json');
        writeFileSync(externalDirectoryState, 'preserve through directory symlink');
        const directoryLink = join(sessionsDir, 'session-directory-link');
        symlinkSync(externalSessionDir, directoryLink, 'dir');
        const fileSessionDir = join(sessionsDir, 'session-file-link');
        mkdirSync(fileSessionDir, { recursive: true });
        const externalFileState = join(tempDir, 'external-state.json');
        writeFileSync(externalFileState, 'preserve through file symlink');
        const fileLink = join(fileSessionDir, 'last-tool-error-state.json');
        symlinkSync(externalFileState, fileLink, 'file');
        runSessionStart({
            hook_event_name: 'SessionStart',
            session_id: 'session-current',
            cwd: fakeProject,
        }, { CLAUDE_PLUGIN_ROOT: '', OMC_STATE_DIR: '' });
        expect(existsSync(directoryLink)).toBe(true);
        expect(existsSync(externalDirectoryState)).toBe(true);
        expect(existsSync(fileLink)).toBe(true);
        expect(existsSync(externalFileState)).toBe(true);
    });
    it('keeps template session-start under budget when only a tiny omission remainder remains', () => {
        writeFileSync(join(fakeProject, '.omc', 'state', 'ultrawork-state.json'), JSON.stringify({
            active: true,
            session_id: 'session-budget-owner',
            started_at: '2026-04-23T00:00:00.000Z',
            last_checked_at: '2026-04-23T00:05:00.000Z',
            original_prompt: 'budget '.repeat(520),
        }));
        writeFileSync(join(fakeProject, 'AGENTS.md'), `# oh-my-claudecode - Intelligent Multi-Agent Orchestration

<guidance_schema_contract>schema</guidance_schema_contract>

<operating_principles>
${'- preserve this startup guidance\n'.repeat(400)}
</operating_principles>`);
        const output = runSessionStart({
            hook_event_name: 'SessionStart',
            session_id: 'session-budget-owner',
            cwd: fakeProject,
        });
        const context = output.hookSpecificOutput?.additionalContext || '';
        expect(output.continue).toBe(true);
        expect(context.length).toBeLessThanOrEqual(6000);
    });
    it('compacts large OMC AGENTS guidance and caps aggregate session context', () => {
        mkdirSync(fakeProject, { recursive: true });
        const largeAgents = [
            '# oh-my-claudecode - Intelligent Multi-Agent Orchestration',
            '<guidance_schema_contract>schema details</guidance_schema_contract>',
            '<operating_principles>keep this high value section</operating_principles>',
            '<agent_catalog>' + 'agent '.repeat(5000) + '</agent_catalog>',
            '<skills>' + 'skill '.repeat(5000) + '</skills>',
            '<team_compositions>' + 'team '.repeat(5000) + '</team_compositions>',
            '<verification>verify before claiming completion</verification>',
        ].join('\n\n');
        writeFileSync(join(fakeProject, 'AGENTS.md'), largeAgents);
        const output = runSessionStart({
            hook_event_name: 'SessionStart',
            session_id: 'session-large-agents',
            cwd: fakeProject,
        });
        const context = output.hookSpecificOutput?.additionalContext || '';
        expect(output.continue).toBe(true);
        expect(context).toContain('[ROOT AGENTS.md LOADED]');
        expect(context).toContain('<operating_principles>keep this high value section</operating_principles>');
        expect(context).toContain('<verification>verify before claiming completion</verification>');
        expect(context).not.toContain('<agent_catalog>');
        expect(context).not.toContain('<skills>');
        expect(context.length).toBeLessThanOrEqual(6000);
    });
    it('does not restore retired ultrawork for the owning session', () => {
        writeFileSync(join(fakeProject, '.omc', 'state', 'ultrawork-state.json'), JSON.stringify({
            active: true,
            session_id: 'session-owner',
            started_at: '2026-03-19T00:00:00.000Z',
            last_checked_at: '2026-03-19T00:05:00.000Z',
            original_prompt: 'Resume me',
        }));
        const output = runSessionStart({
            hook_event_name: 'SessionStart',
            session_id: 'session-owner',
            cwd: fakeProject,
        });
        const context = output.hookSpecificOutput?.additionalContext || '';
        expect(output.continue).toBe(true);
        expect(context).not.toContain('[ULTRAWORK MODE RESTORED]');
        expect(context).not.toContain('Resume me');
        expect(context).not.toContain('[PARALLEL SESSION WARNING]');
    });
    it('does not warn for global fallback state from a different normalized project path', () => {
        mkdirSync(join(fakeHome, '.omc', 'state'), { recursive: true });
        writeFileSync(join(fakeHome, '.omc', 'state', 'ultrawork-state.json'), JSON.stringify({
            active: true,
            session_id: 'session-a',
            started_at: '2026-03-19T00:00:00.000Z',
            last_checked_at: '2026-03-19T00:05:00.000Z',
            original_prompt: 'Different project task',
            project_path: join(tempDir, 'other-project'),
        }));
        const output = runSessionStart({
            hook_event_name: 'SessionStart',
            session_id: 'session-b',
            cwd: fakeProject,
        });
        expect(output.continue).toBe(true);
        const context = output.hookSpecificOutput?.additionalContext || '';
        expect(context).not.toContain('[PARALLEL SESSION WARNING]');
        expect(context).not.toContain('[ULTRAWORK MODE RESTORED]');
    });
    it('keeps model routing override under budget for non-standard providers', () => {
        writeFileSync(join(fakeProject, 'AGENTS.md'), `# oh-my-claudecode - Intelligent Multi-Agent Orchestration

<guidance_schema_contract>schema</guidance_schema_contract>

<operating_principles>
${'- oversized startup guidance\n'.repeat(700)}
</operating_principles>`);
        const output = runSessionStart({
            hook_event_name: 'SessionStart',
            session_id: 'session-bedrock-template',
            cwd: fakeProject,
        }, {
            CLAUDE_CODE_USE_BEDROCK: '1',
        });
        const context = output.hookSpecificOutput?.additionalContext || '';
        expect(output.continue).toBe(true);
        expect(context).toContain('[MODEL ROUTING OVERRIDE');
        expect(context).toContain('tier alias');
        expect(context).toMatch(/\b(sonnet|opus|haiku)\b/);
        expect(context).not.toContain('Do NOT pass the `model` parameter');
        expect(context).not.toContain('Omit it entirely');
        expect(context.length).toBeLessThanOrEqual(6000);
    });
    it('surfaces update notices through systemMessage without injecting them into additionalContext', () => {
        const omcDir = join(fakeHome, '.claude', '.omc');
        mkdirSync(omcDir, { recursive: true });
        writeFileSync(join(omcDir, 'update-check.json'), JSON.stringify({
            timestamp: Date.now(),
            latestVersion: '999.0.0',
            currentVersion: '1.0.0',
            updateAvailable: true,
        }));
        const result = spawnSync(NODE, [SCRIPT_PATH], {
            input: JSON.stringify({
                hook_event_name: 'SessionStart',
                session_id: 'session-update-visible',
                cwd: fakeProject,
            }),
            encoding: 'utf-8',
            env: {
                ...process.env,
                HOME: fakeHome,
                USERPROFILE: fakeHome,
                CLAUDE_CONFIG_DIR: join(fakeHome, '.claude'),
            },
            timeout: 15000,
        });
        expect(result.status).toBe(0);
        expect(result.stderr).toBe('');
        const output = JSON.parse(result.stdout);
        expect(output.continue).toBe(true);
        expect(output.systemMessage).toContain('[OMC UPDATE AVAILABLE]');
        expect(output.systemMessage).toContain('v999.0.0');
        expect(output.systemMessage).toContain('/update');
        expect(output.hookSpecificOutput?.additionalContext ?? '').not.toContain('[OMC UPDATE AVAILABLE]');
        expect(output.hookSpecificOutput?.additionalContext ?? '').not.toContain('999.0.0');
    });
    it('honors autoUpgradePrompt=false with passive systemMessage wording', () => {
        const omcDir = join(fakeHome, '.claude', '.omc');
        mkdirSync(omcDir, { recursive: true });
        writeFileSync(join(fakeHome, '.claude', '.omc-config.json'), JSON.stringify({ autoUpgradePrompt: false }));
        writeFileSync(join(omcDir, 'update-check.json'), JSON.stringify({
            timestamp: Date.now(),
            latestVersion: '999.0.0',
            currentVersion: '1.0.0',
            updateAvailable: true,
        }));
        const result = spawnSync(NODE, [SCRIPT_PATH], {
            input: JSON.stringify({
                hook_event_name: 'SessionStart',
                session_id: 'session-update-passive',
                cwd: fakeProject,
            }),
            encoding: 'utf-8',
            env: {
                ...process.env,
                HOME: fakeHome,
                USERPROFILE: fakeHome,
                CLAUDE_CONFIG_DIR: join(fakeHome, '.claude'),
            },
            timeout: 15000,
        });
        const output = JSON.parse(result.stdout);
        expect(output.systemMessage).toContain('To update later, run: omc update');
        expect(output.systemMessage).not.toContain('Run /update to upgrade now');
    });
});
// ==========================================================================
// E.2 — PID-aware liveness in session-start template (Wave E)
// ==========================================================================
describe('session-start template cwd validation (Wave B1)', () => {
    let tempDir;
    let fakeHome;
    let emptyCwd;
    beforeEach(() => {
        tempDir = mkdtempSync(join(tmpdir(), 'omc-session-start-cwdval-'));
        fakeHome = join(tempDir, 'home');
        mkdirSync(fakeHome, { recursive: true });
        // A truly empty directory with no .omc-workspace or .git marker.
        // Keep it under fakeHome so validateCwd stops before ambient /tmp markers.
        emptyCwd = mkdtempSync(join(fakeHome, 'omc-empty-cwd-'));
    });
    afterEach(() => {
        rmSync(tempDir, { recursive: true, force: true });
        rmSync(emptyCwd, { recursive: true, force: true });
    });
    function runSessionStartRaw(input, extraEnv = {}) {
        const result = spawnSync(process.execPath, [SCRIPT_PATH], {
            input: JSON.stringify(input),
            encoding: 'utf-8',
            env: {
                ...process.env,
                HOME: fakeHome,
                USERPROFILE: fakeHome,
                ...extraEnv,
            },
            timeout: 15000,
        });
        return {
            stdout: result.stdout?.trim() ?? '',
            stderr: result.stderr?.trim() ?? '',
            status: result.status,
        };
    }
    it('emits warning to stderr and outputs no-op JSON when cwd has no .omc-workspace or .git marker', () => {
        // emptyCwd is a real temp dir with no markers — cross-platform guaranteed
        const { stdout, stderr } = runSessionStartRaw({
            hook_event_name: 'SessionStart',
            session_id: 'session-empty-cwd',
            cwd: emptyCwd,
        });
        // Must warn on stderr
        expect(stderr).toContain('[OMC] session-start: refusing to use cwd');
        expect(stderr).toContain('no .omc-workspace or .git marker');
        // Output must be a valid JSON with continue:true and no hookSpecificOutput with state writes
        const parsed = JSON.parse(stdout);
        expect(parsed.continue).toBe(true);
        expect(parsed.hookSpecificOutput).toBeUndefined();
        // Must NOT have written any state files into the empty dir
        expect(existsSync(join(emptyCwd, '.omc'))).toBe(false);
    });
    it('does NOT warn or skip when cwd contains a .git directory', () => {
        const gitProject = mkdtempSync(join(tmpdir(), 'omc-git-project-'));
        try {
            mkdirSync(join(gitProject, '.git'), { recursive: true });
            mkdirSync(join(gitProject, '.omc', 'state'), { recursive: true });
            const { stderr, stdout } = runSessionStartRaw({
                hook_event_name: 'SessionStart',
                session_id: 'session-git-cwd',
                cwd: gitProject,
            });
            // Should NOT emit the warning
            expect(stderr).not.toContain('[OMC] session-start: refusing to use cwd');
            // Should produce normal hook output (continue: true)
            const parsed = JSON.parse(stdout);
            expect(parsed.continue).toBe(true);
        }
        finally {
            rmSync(gitProject, { recursive: true, force: true });
        }
    });
    it('does NOT warn or skip when cwd contains a .omc-workspace marker', () => {
        const wsProject = mkdtempSync(join(tmpdir(), 'omc-ws-project-'));
        try {
            writeFileSync(join(wsProject, '.omc-workspace'), '{}');
            mkdirSync(join(wsProject, '.omc', 'state'), { recursive: true });
            const { stderr, stdout } = runSessionStartRaw({
                hook_event_name: 'SessionStart',
                session_id: 'session-ws-cwd',
                cwd: wsProject,
            });
            expect(stderr).not.toContain('[OMC] session-start: refusing to use cwd');
            const parsed = JSON.parse(stdout);
            expect(parsed.continue).toBe(true);
        }
        finally {
            rmSync(wsProject, { recursive: true, force: true });
        }
    });
    it('does NOT warn or skip when cwd is a SUBDIRECTORY of a .git repo (walks up)', () => {
        const gitProject = mkdtempSync(join(tmpdir(), 'omc-git-subdir-'));
        try {
            mkdirSync(join(gitProject, '.git'), { recursive: true });
            mkdirSync(join(gitProject, '.omc', 'state'), { recursive: true });
            const nested = join(gitProject, 'packages', 'app', 'src');
            mkdirSync(nested, { recursive: true });
            const { stderr, stdout } = runSessionStartRaw({
                hook_event_name: 'SessionStart',
                session_id: 'session-git-subdir',
                cwd: nested,
            });
            // A subdirectory of a real repo must be accepted, not rejected.
            expect(stderr).not.toContain('[OMC] session-start: refusing to use cwd');
            const parsed = JSON.parse(stdout);
            expect(parsed.continue).toBe(true);
        }
        finally {
            rmSync(gitProject, { recursive: true, force: true });
        }
    });
    it('does NOT warn or skip when cwd is a nested SUBDIR whose only anchor is a .omc-workspace at an ancestor (no .git anywhere)', () => {
        const wsRoot = mkdtempSync(join(tmpdir(), 'omc-ws-ancestor-'));
        try {
            // Place .omc-workspace at the ancestor root (no .git anywhere)
            writeFileSync(join(wsRoot, '.omc-workspace'), '{}');
            // cwd is a deeply nested subdirectory — no .git, no .omc-workspace at this level
            const nested = join(wsRoot, 'packages', 'app', 'src');
            mkdirSync(nested, { recursive: true });
            const { stderr, stdout } = runSessionStartRaw({
                hook_event_name: 'SessionStart',
                session_id: 'session-ws-ancestor-subdir',
                cwd: nested,
            }, { HOME: fakeHome, USERPROFILE: fakeHome });
            // validateCwd must walk up, find .omc-workspace at wsRoot, and accept
            expect(stderr).not.toContain('[OMC] session-start: refusing to use cwd');
            const parsed = JSON.parse(stdout);
            expect(parsed.continue).toBe(true);
        }
        finally {
            rmSync(wsRoot, { recursive: true, force: true });
        }
    });
});
//# sourceMappingURL=session-start-template.test.js.map