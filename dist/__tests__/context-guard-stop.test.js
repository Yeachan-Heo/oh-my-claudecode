import { execFileSync } from 'child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { delimiter, join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
const SCRIPT_PATH = join(process.cwd(), 'scripts', 'context-guard-stop.mjs');
function runContextGuardStop(input) {
    const stdout = execFileSync(process.execPath, [SCRIPT_PATH], {
        input: JSON.stringify(input),
        encoding: 'utf-8',
        timeout: 5000,
        env: { ...process.env, NODE_ENV: 'test' },
    });
    return JSON.parse(stdout.trim());
}
function runContextGuardStopWithEnv(input, env) {
    const stdout = execFileSync(process.execPath, [SCRIPT_PATH], {
        input: JSON.stringify(input),
        encoding: 'utf-8',
        timeout: 5000,
        env: { ...process.env, NODE_ENV: 'test', ...env },
    });
    return JSON.parse(stdout.trim());
}
function writeTranscriptWithContext(filePath, contextWindow, inputTokens) {
    const line = JSON.stringify({
        usage: { context_window: contextWindow, input_tokens: inputTokens },
        context_window: contextWindow,
        input_tokens: inputTokens,
    });
    writeFileSync(filePath, `${line}\n`, 'utf-8');
}
function writeTranscriptWithoutContext(filePath, inputTokens) {
    const line = JSON.stringify({
        message: {
            usage: {
                input_tokens: inputTokens,
                output_tokens: 10,
            },
        },
    });
    writeFileSync(filePath, `${line}\n`, 'utf-8');
}
describe('context-guard-stop safe recovery messaging (issue #1373)', () => {
    let tempDir;
    let transcriptPath;
    beforeEach(() => {
        tempDir = mkdtempSync(join(tmpdir(), 'context-guard-stop-'));
        transcriptPath = join(tempDir, 'transcript.jsonl');
    });
    afterEach(() => {
        rmSync(tempDir, { recursive: true, force: true });
    });
    it('blocks high-context stops with explicit compact-first recovery advice', () => {
        writeTranscriptWithContext(transcriptPath, 1000, 850); // 85%
        const out = runContextGuardStop({
            session_id: `session-${Date.now()}`,
            transcript_path: transcriptPath,
            cwd: tempDir,
            stop_reason: 'normal',
        });
        expect(out.decision).toBe('block');
        expect(String(out.reason)).toContain('Run /compact immediately');
        expect(String(out.reason)).toContain('.omc/state');
    });
    it('blocks using HUD cache when transcript and hook payload omit context_window', () => {
        const sessionId = `hud-stop-${Date.now()}`;
        writeTranscriptWithoutContext(transcriptPath, 10);
        const cacheDir = join(tempDir, '.omc', 'state', 'sessions', sessionId);
        mkdirSync(cacheDir, { recursive: true });
        writeFileSync(join(cacheDir, 'hud-stdin-cache.json'), JSON.stringify({
            cwd: tempDir,
            context_window: {
                used_percentage: 80,
                context_window_size: 1000,
                current_usage: {
                    input_tokens: 10,
                    cache_creation_input_tokens: 0,
                    cache_read_input_tokens: 0,
                },
            },
        }), 'utf-8');
        const out = runContextGuardStopWithEnv({
            session_id: sessionId,
            transcript_path: transcriptPath,
            cwd: tempDir,
            stop_reason: 'normal',
        }, {
            CLAUDE_PLUGIN_ROOT: process.cwd(),
            OMC_CONTEXT_GUARD_THRESHOLD: '75',
        });
        expect(out.continue).toBe(false);
        expect(out.decision).toBe('block');
        expect(String(out.reason)).toContain('Run /compact immediately');
    });
    it('fails open at critical context exhaustion to avoid stop-hook deadlock', () => {
        writeTranscriptWithContext(transcriptPath, 1000, 960); // 96%
        const out = runContextGuardStop({
            session_id: `session-${Date.now()}`,
            transcript_path: transcriptPath,
            cwd: tempDir,
            stop_reason: 'end_turn',
        });
        expect(out.continue).toBe(true);
        expect(out.decision).toBeUndefined();
    });
    it('ignores invalid session_id values when tracking block retries', () => {
        writeTranscriptWithContext(transcriptPath, 1000, 850); // 85%
        const invalidSessionId = '../../bad-session-id';
        const first = runContextGuardStop({
            session_id: invalidSessionId,
            transcript_path: transcriptPath,
            cwd: tempDir,
            stop_reason: 'normal',
        });
        const second = runContextGuardStop({
            session_id: invalidSessionId,
            transcript_path: transcriptPath,
            cwd: tempDir,
            stop_reason: 'normal',
        });
        expect(first.decision).toBe('block');
        expect(second.decision).toBe('block');
        expect(String(first.reason)).toContain('(Block 1/2)');
        expect(String(second.reason)).toContain('(Block 1/2)');
    });
    it('skips git worktree probing in non-git directories without a local .git marker', () => {
        const missingTranscriptPath = join(tempDir, 'missing-transcript.jsonl');
        const fakeBinDir = join(tempDir, 'fake-bin');
        mkdirSync(fakeBinDir, { recursive: true });
        const gitLogPath = join(tempDir, 'git-invocations.log');
        writeFileSync(join(fakeBinDir, 'git'), '#!/usr/bin/env node\n' +
            'require("fs").appendFileSync(process.env.OMC_FAKE_GIT_LOG, process.argv.slice(2).join(" ") + "\\n");\n' +
            'process.exit(1);\n', { mode: 0o755 });
        writeFileSync(join(fakeBinDir, 'git.cmd'), '@echo off\r\nnode "%~dp0\\git" %*\r\n');
        const out = runContextGuardStopWithEnv({
            session_id: `session-${Date.now()}`,
            transcript_path: missingTranscriptPath,
            cwd: tempDir,
            stop_reason: 'normal',
        }, {
            PATH: `${fakeBinDir}${delimiter}${process.env.PATH ?? ''}`,
            OMC_FAKE_GIT_LOG: gitLogPath,
        });
        expect(out).toEqual({ continue: true, suppressOutput: true });
        expect(() => readFileSync(gitLogPath, 'utf-8')).toThrow();
    });
});
//# sourceMappingURL=context-guard-stop.test.js.map