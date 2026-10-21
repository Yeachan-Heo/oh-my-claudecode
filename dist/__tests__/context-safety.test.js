import { execFileSync } from 'child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
const SCRIPT_PATH = join(process.cwd(), 'scripts', 'context-safety.mjs');
const HOOKS_PATH = join(process.cwd(), 'hooks', 'hooks.json');
const tempDirs = [];
function makeTempDir() {
    const dir = mkdtempSync(join(tmpdir(), 'omc-context-safety-'));
    tempDirs.push(dir);
    return dir;
}
function writeTranscript(dir, inputTokens, contextWindow) {
    const transcriptPath = join(dir, 'transcript.jsonl');
    writeFileSync(transcriptPath, `${JSON.stringify({ message: { usage: { input_tokens: inputTokens, context_window: contextWindow } } })}\n`, 'utf-8');
    return transcriptPath;
}
function runContextSafety(input, env = {}) {
    try {
        const stdout = execFileSync('node', [SCRIPT_PATH], {
            input: JSON.stringify(input),
            encoding: 'utf-8',
            stdio: ['pipe', 'pipe', 'pipe'],
            timeout: 5000,
            env: { ...process.env, NODE_ENV: 'test', ...env },
        });
        return { stdout: stdout.trim(), stderr: '', exitCode: 0 };
    }
    catch (err) {
        const e = err;
        return {
            stdout: (e.stdout ?? '').trim(),
            stderr: (e.stderr ?? '').trim(),
            exitCode: e.status ?? 1,
        };
    }
}
afterEach(() => {
    while (tempDirs.length > 0) {
        const dir = tempDirs.pop();
        if (dir)
            rmSync(dir, { recursive: true, force: true });
    }
});
describe('context-safety hook (issues #1006, #1597)', () => {
    it('does NOT block TeamCreate — removed from BLOCKED_TOOLS', () => {
        const result = runContextSafety({
            tool_name: 'TeamCreate',
            toolInput: { team_name: 'test-team', description: 'Test team' },
            session_id: 'session-1006',
            cwd: process.cwd(),
        });
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toBe('');
    });
    it('does NOT block ExitPlanMode even when transcript shows high context', () => {
        const dir = makeTempDir();
        const transcriptPath = writeTranscript(dir, 700, 1000);
        const result = runContextSafety({
            tool_name: 'ExitPlanMode',
            toolInput: {},
            transcript_path: transcriptPath,
            session_id: 'session-1597',
            cwd: dir,
        }, { OMC_CONTEXT_SAFETY_THRESHOLD: '55' });
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toBe('');
    });
    it('allows unknown tools through without blocking', () => {
        const result = runContextSafety({
            tool_name: 'Bash',
            toolInput: { command: 'echo hi' },
            session_id: 'session-1006',
            cwd: process.cwd(),
        });
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toBe('');
    });
});
describe('context-safety hook matcher', () => {
    it('does not register a dedicated ExitPlanMode context-safety matcher', () => {
        const hooksJson = JSON.parse(readFileSync(HOOKS_PATH, 'utf-8'));
        const contextSafetyHook = hooksJson.hooks.PreToolUse.find(entry => entry.hooks.some(hook => hook.command.includes('scripts/context-safety.mjs')));
        expect(contextSafetyHook).toBeUndefined();
    });
});
//# sourceMappingURL=context-safety.test.js.map