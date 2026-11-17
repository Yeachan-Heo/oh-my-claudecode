import { execFileSync, spawn } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { provisionStandaloneStateLockBridge } from '../installer/index.js';
const NODE = process.execPath;
const REPO_ROOT = resolve(join(__dirname, '..', '..'));
const SCRIPT_PATH = join(REPO_ROOT, 'scripts', 'post-tool-use-failure.mjs');
const TEMPLATE_ROOT = mkdtempSync(join(tmpdir(), 'omc-post-tool-use-failure-template-'));
const TEMPLATE_HOOKS_ROOT = join(TEMPLATE_ROOT, 'hooks');
cpSync(join(REPO_ROOT, 'templates', 'hooks'), TEMPLATE_HOOKS_ROOT, { recursive: true });
provisionStandaloneStateLockBridge(REPO_ROOT, join(TEMPLATE_HOOKS_ROOT, 'lib', 'state-lock.mjs'));
const TEMPLATE_SCRIPT_PATH = join(TEMPLATE_HOOKS_ROOT, 'post-tool-use-failure.mjs');
const WINDOWS_SIMULATION = `
  import { createRequire } from 'node:module';
  import { pathToFileURL } from 'node:url';
  const require = createRequire(process.argv[1]);
  require('better-sqlite3');
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
  await import(pathToFileURL(process.argv[2]).href);
`;
const TEST_TMP_ROOT = join(REPO_ROOT, '.tmp-post-tool-use-failure-tests');
afterAll(() => {
    rmSync(TEMPLATE_ROOT, { recursive: true, force: true });
});
function runHook(input, extraEnv, scriptPath = SCRIPT_PATH) {
    const raw = execFileSync(NODE, [scriptPath], {
        input: JSON.stringify(input),
        encoding: 'utf-8',
        env: {
            ...process.env,
            CLAUDE_PLUGIN_ROOT: REPO_ROOT,
            NODE_ENV: 'test',
            ...extraEnv,
        },
        timeout: 15000,
    }).trim();
    return JSON.parse(raw);
}
describe('post-tool-use-failure.mjs', () => {
    const tempDirs = [];
    afterEach(() => {
        while (tempDirs.length > 0) {
            rmSync(tempDirs.pop(), { recursive: true, force: true });
        }
    });
    function makeRepoLocalTempDir() {
        mkdirSync(TEST_TMP_ROOT, { recursive: true });
        const cwd = mkdtempSync(join(TEST_TMP_ROOT, 'case-'));
        tempDirs.push(cwd);
        return cwd;
    }
    it('suppresses optional omx startup read method-not-found noise', () => {
        const cwd = makeRepoLocalTempDir();
        const errorPath = join(cwd, '.omc', 'state', 'last-tool-error.json');
        const result = runHook({
            tool_name: 'mcp__omx_state__state_read',
            tool_input: { mode: 'deep-interview' },
            error: 'Method not found',
            cwd,
        });
        expect(result).toEqual({ continue: true, suppressOutput: true });
        expect(existsSync(errorPath)).toBe(false);
    });
    it('preserves real failures for the same optional startup reads', () => {
        const cwd = makeRepoLocalTempDir();
        const errorPath = join(cwd, '.omc', 'state', 'last-tool-error.json');
        const result = runHook({
            tool_name: 'mcp__omx_state__state_read',
            tool_input: { mode: 'deep-interview' },
            error: 'Connection refused',
            cwd,
        });
        expect(result.continue).toBe(true);
        expect(result.suppressOutput).not.toBe(true);
        expect(result.hookSpecificOutput?.hookEventName).toBe('PostToolUseFailure');
        expect(result.hookSpecificOutput?.additionalContext).toContain('Tool "mcp__omx_state__state_read" failed.');
        expect(existsSync(errorPath)).toBe(true);
        const errorState = JSON.parse(readFileSync(errorPath, 'utf-8'));
        expect(errorState.tool_name).toBe('mcp__omx_state__state_read');
        expect(errorState.error).toBe('Tool execution failed (details omitted for privacy).');
        expect(errorState.retry_count).toBe(1);
    });
    it.each([
        ['plugin script', SCRIPT_PATH],
        ['installer template', TEMPLATE_SCRIPT_PATH],
    ])('does not persist tool input or error text that may contain secrets (%s)', (_surface, scriptPath) => {
        const cwd = makeRepoLocalTempDir();
        const inputSecret = 'issue-4278-input-password';
        const errorSecret = 'issue-4278-error-bearer-token';
        const errorPath = join(cwd, '.omc', 'state', 'last-tool-error.json');
        const result = runHook({
            tool_name: 'Bash',
            tool_input: { command: `psql postgres://user:${inputSecret}@database.example/app` },
            error: `Request failed: Authorization: Bearer ${errorSecret}`,
            cwd,
        }, undefined, scriptPath);
        const serializedState = readFileSync(errorPath, 'utf-8');
        const state = JSON.parse(serializedState);
        expect(serializedState).not.toContain(inputSecret);
        expect(serializedState).not.toContain(errorSecret);
        expect(state).toEqual({
            tool_name: 'Bash',
            error: 'Tool execution failed (details omitted for privacy).',
            timestamp: expect.any(String),
            retry_count: 1,
        });
        expect(JSON.stringify(result)).not.toContain(inputSecret);
        expect(JSON.stringify(result)).not.toContain(errorSecret);
    });
    it.each([
        ['plugin script', SCRIPT_PATH],
        ['installer template', TEMPLATE_SCRIPT_PATH],
    ])('continues retry tracking without retaining failure text (%s)', (_surface, scriptPath) => {
        const cwd = makeRepoLocalTempDir();
        const errorPath = join(cwd, '.omc', 'state', 'last-tool-error.json');
        for (const error of ['first failure', 'second failure']) {
            const result = runHook({
                tool_name: 'Bash',
                tool_input: { command: 'npm test' },
                error,
                cwd,
            }, undefined, scriptPath);
            expect(result.hookSpecificOutput?.additionalContext).toContain('Tool "Bash" failed.');
        }
        const state = JSON.parse(readFileSync(errorPath, 'utf-8'));
        expect(state.tool_name).toBe('Bash');
        expect(state.error).toBe('Tool execution failed (details omitted for privacy).');
        expect(Number.isFinite(Date.parse(state.timestamp))).toBe(true);
        expect(state.retry_count).toBe(2);
    });
    it.each([
        ['plugin script', SCRIPT_PATH],
        ['installer template', TEMPLATE_SCRIPT_PATH],
    ])('reclaims a stale fallback lock and advances retry guidance (%s)', (surface, scriptPath) => {
        const cwd = makeRepoLocalTempDir();
        const sessionId = `stale-fallback-${surface.replaceAll(' ', '-')}`;
        const sessionStateDir = join(cwd, '.omc', 'state', 'sessions', sessionId);
        const statePath = join(sessionStateDir, 'last-tool-error-state.json');
        const lockPath = `${statePath}.lock`;
        mkdirSync(sessionStateDir, { recursive: true });
        writeFileSync(statePath, JSON.stringify({
            tool_name: 'Bash',
            error: 'Tool execution failed (details omitted for privacy).',
            timestamp: new Date().toISOString(),
            retry_count: 4,
        }));
        writeFileSync(lockPath, JSON.stringify({ pid: 999999999, timestamp: Date.now() }));
        const result = runHook({
            tool_name: 'Bash',
            tool_input: { command: 'false' },
            error: 'exit code 1',
            cwd,
            session_id: sessionId,
        }, {
            OMC_STATE_DIR: '',
            OMC_TEST_BETTER_SQLITE3_LOAD_FAILURE: '1',
        }, scriptPath);
        const state = JSON.parse(readFileSync(statePath, 'utf8'));
        expect(result.hookSpecificOutput?.additionalContext).toContain('Tool "Bash" has failed 5 times. Stop retrying');
        expect(state).toEqual({
            tool_name: 'Bash',
            error: 'Tool execution failed (details omitted for privacy).',
            timestamp: expect.any(String),
            retry_count: 5,
        });
        expect(existsSync(lockPath)).toBe(false);
    });
    it.each([
        ['plugin script', SCRIPT_PATH],
        ['installer template', TEMPLATE_SCRIPT_PATH],
    ])('does not write failure state without the exclusive lock (%s)', (_surface, scriptPath) => {
        const cwd = makeRepoLocalTempDir();
        const stateDir = join(cwd, '.omc', 'state');
        const errorPath = join(stateDir, 'last-tool-error.json');
        mkdirSync(stateDir, { recursive: true });
        writeFileSync(`${errorPath}.lock`, JSON.stringify({ pid: process.pid, timestamp: Date.now() }));
        const result = runHook({
            tool_name: 'Bash',
            tool_input: { command: 'false' },
            error: 'exit code 1',
            cwd,
        }, undefined, scriptPath);
        expect(result.continue).toBe(true);
        expect(existsSync(errorPath)).toBe(false);
        expect(existsSync(`${errorPath}.lock`)).toBe(true);
    });
    it.skipIf(process.platform !== 'linux')('keeps failure guidance within budget for contended Windows locks', () => {
        for (const [surface, scriptPath] of [['plugin script', SCRIPT_PATH], ['installer template', TEMPLATE_SCRIPT_PATH]]) {
            const cwd = makeRepoLocalTempDir();
            const sessionId = `windows-contention-${surface.replaceAll(' ', '-')}`;
            const stateRoot = join(cwd, '.omc', 'state');
            const sessionStateDir = join(stateRoot, 'sessions', sessionId);
            mkdirSync(sessionStateDir, { recursive: true });
            const statePath = join(sessionStateDir, 'last-tool-error-state.json');
            const lockPath = `${statePath}.lock`;
            const databasePath = join(stateRoot, '.state-mutation-locks.db');
            const probeDirectory = join(cwd, 'fake-bin');
            const probeCountPath = join(probeDirectory, 'calls');
            const slowProbeMarkerPath = join(probeDirectory, 'slow-probe-started');
            mkdirSync(probeDirectory);
            const processStart = 'ticks:638933184000000001';
            const nonce = '123e4567-e89b-12d3-a456-426614174000';
            const setupScript = `
        import Database from 'better-sqlite3';
        import { writeFileSync } from 'node:fs';
        import { resolve } from 'node:path';
        const lockPath = process.argv[1];
        const databasePath = process.argv[2];
        const ownerPid = Number(process.argv[3]);
        const processStart = process.argv[4];
        const nonce = process.argv[5];
        const createdAt = new Date().toISOString();
        const database = new Database(databasePath);
        database.pragma('journal_mode = WAL');
        database.exec('CREATE TABLE IF NOT EXISTS state_mutation_locks (lock_key TEXT PRIMARY KEY, version INTEGER NOT NULL, pid INTEGER NOT NULL, process_start TEXT NOT NULL, created_at TEXT NOT NULL, nonce TEXT NOT NULL)');
        database.prepare('INSERT OR REPLACE INTO state_mutation_locks (lock_key, version, pid, process_start, created_at, nonce) VALUES (?, 1, ?, ?, ?, ?)')
          .run(resolve(lockPath), ownerPid, processStart, createdAt, nonce);
        writeFileSync(lockPath, JSON.stringify({ version: 1, pid: ownerPid, processStart, createdAt, nonce }));
        database.close();
      `;
            execFileSync(NODE, [
                '--input-type=module', '-e', setupScript, lockPath, databasePath, String(process.pid), processStart, nonce,
            ], { encoding: 'utf8', timeout: 10000 });
            const powershellPath = join(probeDirectory, 'powershell');
            writeFileSync(powershellPath, `#!/bin/sh
printf x >> '${probeCountPath}'
if [ ! -f '${slowProbeMarkerPath}' ]; then
  : > '${slowProbeMarkerPath}'
  printf '638933184000000001\\n'
else
  /usr/bin/sleep 3
  printf '638933184000000001\\n'
fi
`);
            chmodSync(powershellPath, 0o755);
            const startedAt = Date.now();
            const raw = execFileSync(NODE, [
                '--input-type=module', '-e', WINDOWS_SIMULATION, join(REPO_ROOT, 'package.json'), scriptPath,
            ], {
                cwd,
                input: JSON.stringify({
                    tool_name: 'Bash',
                    tool_input: { command: 'false' },
                    error: 'exit code 1',
                    cwd,
                    session_id: sessionId,
                }),
                encoding: 'utf8',
                env: {
                    ...process.env,
                    CLAUDE_PLUGIN_ROOT: REPO_ROOT,
                    NODE_ENV: 'test',
                    OMC_STATE_DIR: '',
                    OMC_TEST_FLOCK_AVAILABLE: '',
                    OMC_TEST_BETTER_SQLITE3_LOAD_FAILURE: '',
                    PATH: `${probeDirectory}${delimiter}${process.env.PATH ?? ''}`,
                },
                timeout: 2500,
            }).trim();
            const elapsedMs = Date.now() - startedAt;
            const result = JSON.parse(raw);
            expect(result.continue).toBe(true);
            expect(result.hookSpecificOutput?.hookEventName).toBe('PostToolUseFailure');
            expect(result.hookSpecificOutput?.additionalContext).toContain('Tool "Bash" failed.');
            expect(existsSync(statePath)).toBe(false);
            expect(readFileSync(probeCountPath, 'utf8')).toHaveLength(2);
            expect(elapsedMs).toBeLessThan(2200);
        }
    }, 15000);
    it.skipIf(process.platform !== 'linux')('keeps failure guidance within budget during SQLite writer contention', async () => {
        const cwd = makeRepoLocalTempDir();
        const sessionId = 'windows-contention-sqlite';
        const stateRoot = join(cwd, '.omc', 'state');
        const sessionStateDir = join(stateRoot, 'sessions', sessionId);
        mkdirSync(sessionStateDir, { recursive: true });
        const statePath = join(sessionStateDir, 'last-tool-error-state.json');
        const databasePath = join(stateRoot, '.state-mutation-locks.db');
        const createDatabaseScript = `
      import Database from 'better-sqlite3';
      const database = new Database(process.argv[1]);
      database.pragma('journal_mode = WAL');
      database.exec('CREATE TABLE IF NOT EXISTS state_mutation_locks (lock_key TEXT PRIMARY KEY, version INTEGER NOT NULL, pid INTEGER NOT NULL, process_start TEXT NOT NULL, created_at TEXT NOT NULL, nonce TEXT NOT NULL)');
      database.close();
    `;
        execFileSync(NODE, ['--input-type=module', '-e', createDatabaseScript, databasePath], {
            encoding: 'utf8',
            timeout: 10000,
        });
        const holderScript = `
      import Database from 'better-sqlite3';
      const database = new Database(process.argv[1]);
      database.pragma('journal_mode = WAL');
      database.exec('BEGIN IMMEDIATE');
      process.stdout.write('lock-acquired\\n');
      process.stdin.resume();
      process.stdin.once('end', () => {
        database.exec('ROLLBACK');
        database.close();
      });
    `;
        const holder = spawn(NODE, ['--input-type=module', '-e', holderScript, databasePath], {
            stdio: ['pipe', 'pipe', 'pipe'],
        });
        const holderExit = new Promise((resolve) => holder.once('exit', () => resolve()));
        try {
            await new Promise((resolve, reject) => {
                const timeout = setTimeout(() => reject(new Error('SQLite writer did not acquire its lock')), 5000);
                holder.once('error', (error) => {
                    clearTimeout(timeout);
                    reject(error);
                });
                holder.stdout.on('data', (data) => {
                    if (String(data).includes('lock-acquired')) {
                        clearTimeout(timeout);
                        resolve();
                    }
                });
            });
            const startedAt = Date.now();
            const raw = execFileSync(NODE, [
                '--input-type=module', '-e', WINDOWS_SIMULATION, join(REPO_ROOT, 'package.json'), SCRIPT_PATH,
            ], {
                cwd,
                input: JSON.stringify({
                    tool_name: 'Bash',
                    tool_input: { command: 'false' },
                    error: 'exit code 1',
                    cwd,
                    session_id: sessionId,
                }),
                encoding: 'utf8',
                env: {
                    ...process.env,
                    CLAUDE_PLUGIN_ROOT: REPO_ROOT,
                    NODE_ENV: 'test',
                    OMC_STATE_DIR: '',
                    OMC_TEST_FLOCK_AVAILABLE: '',
                    OMC_TEST_BETTER_SQLITE3_LOAD_FAILURE: '',
                },
                timeout: 2500,
            }).trim();
            const elapsedMs = Date.now() - startedAt;
            const result = JSON.parse(raw);
            expect(result.continue).toBe(true);
            expect(result.hookSpecificOutput?.hookEventName).toBe('PostToolUseFailure');
            expect(result.hookSpecificOutput?.additionalContext).toContain('Tool "Bash" failed.');
            expect(existsSync(statePath)).toBe(false);
            expect(elapsedMs).toBeLessThan(2200);
        }
        finally {
            holder.stdin.end();
            await holderExit;
        }
    }, 15000);
    it('suppresses broad AGENTS scan permission-denied noise for Bash', () => {
        const cwd = makeRepoLocalTempDir();
        const errorPath = join(cwd, '.omc', 'state', 'last-tool-error.json');
        const result = runHook({
            tool_name: 'Bash',
            tool_input: {
                command: 'pwd && find .. -name AGENTS.md -print',
            },
            error: [
                'find: ../systemd-private-123: Permission denied',
                'find: ../snap-private-tmp: Permission denied',
                'Command failed with exit code 1:',
            ].join('\n'),
            cwd,
        });
        expect(result).toEqual({ continue: true, suppressOutput: true });
        expect(existsSync(errorPath)).toBe(false);
    });
    it('does not suppress Bash permission-denied errors with actionable non-scan content', () => {
        const cwd = makeRepoLocalTempDir();
        const errorPath = join(cwd, '.omc', 'state', 'last-tool-error.json');
        const result = runHook({
            tool_name: 'Bash',
            tool_input: {
                command: 'find .. -name AGENTS.md -print',
            },
            error: [
                'find: ../systemd-private-123: Permission denied',
                'fatal: not a git repository (or any of the parent directories): .git',
            ].join('\n'),
            cwd,
        });
        expect(result.continue).toBe(true);
        expect(result.suppressOutput).not.toBe(true);
        expect(existsSync(errorPath)).toBe(true);
    });
    it('writes to session-scoped path when session_id is provided in payload', () => {
        const cwd = makeRepoLocalTempDir();
        const sessionId = 'abc';
        const sessionPath = join(cwd, '.omc', 'state', 'sessions', sessionId, 'last-tool-error-state.json');
        const legacyPath = join(cwd, '.omc', 'state', 'last-tool-error.json');
        const result = runHook({
            tool_name: 'Bash',
            tool_input: { command: 'false' },
            error: 'exit code 1',
            cwd,
            session_id: sessionId,
        });
        expect(result.continue).toBe(true);
        expect(result.hookSpecificOutput?.hookEventName).toBe('PostToolUseFailure');
        expect(existsSync(sessionPath)).toBe(true);
        expect(existsSync(legacyPath)).toBe(false);
        const state = JSON.parse(readFileSync(sessionPath, 'utf-8'));
        expect(state.tool_name).toBe('Bash');
        expect(state.retry_count).toBe(1);
    });
    it('writes to legacy path when no session_id is present (back-compat)', () => {
        const cwd = makeRepoLocalTempDir();
        const legacyPath = join(cwd, '.omc', 'state', 'last-tool-error.json');
        const result = runHook({
            tool_name: 'Bash',
            tool_input: { command: 'false' },
            error: 'exit code 1',
            cwd,
            // no session_id
        });
        expect(result.continue).toBe(true);
        expect(existsSync(legacyPath)).toBe(true);
        // session subdir should NOT be created
        expect(existsSync(join(cwd, '.omc', 'state', 'sessions'))).toBe(false);
    });
    it('uses OMC_SESSION_ID env var as fallback when payload has no session_id', () => {
        const cwd = makeRepoLocalTempDir();
        const sessionId = 'env-session-1';
        const sessionPath = join(cwd, '.omc', 'state', 'sessions', sessionId, 'last-tool-error-state.json');
        const legacyPath = join(cwd, '.omc', 'state', 'last-tool-error.json');
        runHook({
            tool_name: 'Bash',
            tool_input: { command: 'false' },
            error: 'exit code 1',
            cwd,
            // no session_id in payload
        }, { OMC_SESSION_ID: sessionId });
        expect(existsSync(sessionPath)).toBe(true);
        expect(existsSync(legacyPath)).toBe(false);
    });
    it('payload session_id takes priority over OMC_SESSION_ID env var', () => {
        const cwd = makeRepoLocalTempDir();
        const payloadSessionId = 'payload-session';
        const envSessionId = 'env-session';
        const payloadPath = join(cwd, '.omc', 'state', 'sessions', payloadSessionId, 'last-tool-error-state.json');
        const envPath = join(cwd, '.omc', 'state', 'sessions', envSessionId, 'last-tool-error-state.json');
        runHook({
            tool_name: 'Bash',
            tool_input: { command: 'false' },
            error: 'exit code 1',
            cwd,
            session_id: payloadSessionId,
        }, { OMC_SESSION_ID: envSessionId });
        expect(existsSync(payloadPath)).toBe(true);
        expect(existsSync(envPath)).toBe(false);
    });
    it('two consecutive invocations with different session_ids write to isolated files', () => {
        const cwd = makeRepoLocalTempDir();
        const sessionA = 'session-alpha';
        const sessionB = 'session-beta';
        const pathA = join(cwd, '.omc', 'state', 'sessions', sessionA, 'last-tool-error-state.json');
        const pathB = join(cwd, '.omc', 'state', 'sessions', sessionB, 'last-tool-error-state.json');
        // First invocation
        runHook({
            tool_name: 'Edit',
            tool_input: { file_path: '/tmp/x' },
            error: 'file not found',
            cwd,
            session_id: sessionA,
        });
        // Second invocation with different session
        runHook({
            tool_name: 'Bash',
            tool_input: { command: 'npm test' },
            error: 'command failed',
            cwd,
            session_id: sessionB,
        });
        expect(existsSync(pathA)).toBe(true);
        expect(existsSync(pathB)).toBe(true);
        const stateA = JSON.parse(readFileSync(pathA, 'utf-8'));
        const stateB = JSON.parse(readFileSync(pathB, 'utf-8'));
        expect(stateA.tool_name).toBe('Edit');
        expect(stateB.tool_name).toBe('Bash');
        // Files are independent — different paths, different content
        expect(pathA).not.toBe(pathB);
    });
    describe('skip guards (DISABLE_OMC / OMC_SKIP_HOOKS)', () => {
        const FAILING_INPUT = {
            tool_name: 'Bash',
            tool_input: { command: 'false' },
            error: 'exit code 1',
        };
        function expectSkipped(cwd, extraEnv) {
            const result = runHook({ ...FAILING_INPUT, cwd }, extraEnv);
            // Skipped hooks emit a bare continue with no guidance injected.
            expect(result).toEqual({ continue: true });
            // No state directory/file is created when the hook no-ops.
            expect(existsSync(join(cwd, '.omc', 'state'))).toBe(false);
        }
        it('no-ops when DISABLE_OMC=1', () => {
            expectSkipped(makeRepoLocalTempDir(), { DISABLE_OMC: '1', OMC_SKIP_HOOKS: '' });
        });
        it('no-ops when DISABLE_OMC=true', () => {
            expectSkipped(makeRepoLocalTempDir(), { DISABLE_OMC: 'true', OMC_SKIP_HOOKS: '' });
        });
        it('no-ops when OMC_SKIP_HOOKS contains post-tool-use-failure', () => {
            expectSkipped(makeRepoLocalTempDir(), {
                DISABLE_OMC: '',
                OMC_SKIP_HOOKS: 'post-tool-use-failure',
            });
        });
        it('no-ops when OMC_SKIP_HOOKS contains the post-tool-use compat token', () => {
            expectSkipped(makeRepoLocalTempDir(), {
                DISABLE_OMC: '',
                OMC_SKIP_HOOKS: 'post-tool-use',
            });
        });
        it('honors whitespace and commas in OMC_SKIP_HOOKS', () => {
            expectSkipped(makeRepoLocalTempDir(), {
                DISABLE_OMC: '',
                OMC_SKIP_HOOKS: ' keyword-detector , post-tool-use-failure ',
            });
        });
        it('injects guidance normally when skip vars are empty', () => {
            const cwd = makeRepoLocalTempDir();
            const legacyPath = join(cwd, '.omc', 'state', 'last-tool-error.json');
            const result = runHook({ ...FAILING_INPUT, cwd }, { DISABLE_OMC: '', OMC_SKIP_HOOKS: '' });
            expect(result.continue).toBe(true);
            expect(result.hookSpecificOutput?.hookEventName).toBe('PostToolUseFailure');
            expect(result.hookSpecificOutput?.additionalContext).toContain('Tool "Bash" failed.');
            expect(existsSync(legacyPath)).toBe(true);
        });
        it('processes normally when DISABLE_OMC=false', () => {
            const cwd = makeRepoLocalTempDir();
            const result = runHook({ ...FAILING_INPUT, cwd }, { DISABLE_OMC: 'false', OMC_SKIP_HOOKS: '' });
            expect(result.hookSpecificOutput?.hookEventName).toBe('PostToolUseFailure');
        });
        it('does not skip for an unrelated OMC_SKIP_HOOKS token', () => {
            const cwd = makeRepoLocalTempDir();
            const result = runHook({ ...FAILING_INPUT, cwd }, { DISABLE_OMC: '', OMC_SKIP_HOOKS: 'keyword-detector' });
            expect(result.hookSpecificOutput?.hookEventName).toBe('PostToolUseFailure');
        });
    });
});
//# sourceMappingURL=post-tool-use-failure.test.js.map