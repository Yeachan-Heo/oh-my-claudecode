import { execSync } from 'child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
const SCRIPT_PATH = join(process.cwd(), 'scripts', 'pre-tool-enforcer.mjs');
function runPreToolEnforcer(input) {
    const stdout = execSync(`node "${SCRIPT_PATH}"`, {
        input: JSON.stringify(input),
        encoding: 'utf-8',
        timeout: 5000,
        env: { ...process.env, NODE_ENV: 'test' },
    });
    return JSON.parse(stdout.trim());
}
function writeJson(filePath, data) {
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, JSON.stringify(data, null, 2));
}
describe('pre-tool-enforcer fallback gating (issue #970)', () => {
    let tempDir;
    beforeEach(() => {
        tempDir = mkdtempSync(join(tmpdir(), 'pre-tool-enforcer-'));
    });
    afterEach(() => {
        rmSync(tempDir, { recursive: true, force: true });
    });
    it('suppresses unknown-tool fallback when no active mode exists', () => {
        const output = runPreToolEnforcer({
            tool_name: 'ToolSearch',
            cwd: tempDir,
            session_id: 'session-970',
        });
        expect(output).toEqual({ continue: true, suppressOutput: true });
    });
    it('emits boulder fallback for unknown tools when session-scoped mode is active', () => {
        const sessionId = 'session-970';
        writeJson(join(tempDir, '.omc', 'state', 'sessions', sessionId, 'ralph-state.json'), {
            active: true,
            session_id: sessionId,
        });
        const output = runPreToolEnforcer({
            tool_name: 'ToolSearch',
            cwd: tempDir,
            session_id: sessionId,
        });
        const hookSpecificOutput = output.hookSpecificOutput;
        expect(output.continue).toBe(true);
        expect(hookSpecificOutput.hookEventName).toBe('PreToolUse');
        expect(hookSpecificOutput.additionalContext).toContain('The boulder never stops');
    });
    it('does not fall back to legacy mode files when a valid session_id is provided', () => {
        writeJson(join(tempDir, '.omc', 'state', 'ralph-state.json'), {
            active: true,
        });
        const output = runPreToolEnforcer({
            tool_name: 'mcp__omx_state__state_read',
            cwd: tempDir,
            session_id: 'session-970',
        });
        expect(output).toEqual({ continue: true, suppressOutput: true });
    });
    it('uses legacy mode files when session_id is not provided', () => {
        writeJson(join(tempDir, '.omc', 'state', 'ultrawork-state.json'), {
            active: true,
        });
        const output = runPreToolEnforcer({
            tool_name: 'mcp__omx_state__state_read',
            cwd: tempDir,
        });
        const hookSpecificOutput = output.hookSpecificOutput;
        expect(output.continue).toBe(true);
        expect(hookSpecificOutput.additionalContext).toContain('The boulder never stops');
    });
    it('keeps known tool messages unchanged (Bash, Read)', () => {
        const bash = runPreToolEnforcer({
            tool_name: 'Bash',
            cwd: tempDir,
        });
        const bashOutput = bash.hookSpecificOutput;
        expect(bashOutput.additionalContext).toBe('Use parallel execution for independent tasks. Use run_in_background for long operations (npm install, builds, tests).');
        const read = runPreToolEnforcer({
            tool_name: 'Read',
            cwd: tempDir,
        });
        const readOutput = read.hookSpecificOutput;
        expect(readOutput.additionalContext).toBe('Read multiple files in parallel when possible for faster analysis.');
    });
});
//# sourceMappingURL=pre-tool-enforcer.test.js.map