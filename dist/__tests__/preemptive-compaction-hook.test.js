import { execFileSync } from 'child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
const SCRIPT_PATH = join(process.cwd(), 'scripts', 'post-tool-verifier.mjs');
const HOOKS_PATH = join(process.cwd(), 'hooks', 'hooks.json');
const tempDirs = [];
function makeTempDir() {
    const dir = mkdtempSync(join(tmpdir(), 'omc-preemptive-hook-'));
    tempDirs.push(dir);
    return dir;
}
function writeTranscript(dir, inputTokens, contextWindow) {
    const transcriptPath = join(dir, 'transcript.jsonl');
    writeFileSync(transcriptPath, `${JSON.stringify({
        message: {
            usage: {
                input_tokens: inputTokens,
                context_window: contextWindow,
            },
        },
    })}\n`, 'utf-8');
    return transcriptPath;
}
function writeTranscriptWithoutContextWindow(dir, inputTokens) {
    const transcriptPath = join(dir, 'transcript.jsonl');
    writeFileSync(transcriptPath, `${JSON.stringify({
        message: {
            usage: {
                input_tokens: inputTokens,
                output_tokens: 10,
            },
        },
    })}\n`, 'utf-8');
    return transcriptPath;
}
function runPostToolVerifier(input, env = {}) {
    const stdout = execFileSync('node', [SCRIPT_PATH], {
        input: JSON.stringify(input),
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 5000,
        env: { ...process.env, NODE_ENV: 'test', ...env },
    });
    return JSON.parse(stdout.trim());
}
afterEach(() => {
    while (tempDirs.length > 0) {
        const dir = tempDirs.pop();
        if (dir)
            rmSync(dir, { recursive: true, force: true });
    }
});
describe('post-tool-verifier preemptive compaction warnings', () => {
    it('keeps preemptive compaction on the existing PostToolUse runtime instead of a standalone script', () => {
        const hooksJson = JSON.parse(readFileSync(HOOKS_PATH, 'utf-8'));
        const commands = hooksJson.hooks.PostToolUse.flatMap(entry => entry.hooks.map(hook => hook.command));
        expect(commands).not.toContain('node "$CLAUDE_PLUGIN_ROOT"/scripts/run.cjs "$CLAUDE_PLUGIN_ROOT"/scripts/preemptive-compaction.mjs');
        expect(commands.some(command => command.includes('"$CLAUDE_PLUGIN_ROOT"/scripts/run.cjs') &&
            command.includes('"$CLAUDE_PLUGIN_ROOT"/scripts/post-tool-verifier.mjs'))).toBe(true);
        expect(commands.some(command => command.includes('"$CLAUDE_PLUGIN_ROOT"/scripts/preemptive-compaction.mjs'))).toBe(false);
    });
    it('warns when transcript usage crosses the configured threshold', () => {
        const dir = makeTempDir();
        const transcriptPath = writeTranscript(dir, 72, 100);
        const result = runPostToolVerifier({
            cwd: dir,
            transcript_path: transcriptPath,
            tool_name: 'Read',
            session_id: 'preemptive-warning-test',
            tool_response: 'read output',
        }, {
            OMC_QUIET: '2',
            OMC_PREEMPTIVE_COMPACTION_WARNING_PERCENT: '70',
            OMC_PREEMPTIVE_COMPACTION_CRITICAL_PERCENT: '90',
        });
        expect(result).toEqual({
            continue: true,
            hookSpecificOutput: {
                hookEventName: 'PostToolUse',
                additionalContext: '[OMC WARNING] Context at 72% (warning threshold: 70%). Plan a /compact soon to preserve room for the next large tool output.',
            },
        });
    });
    it('uses file-backed cooldown across separate hook processes', () => {
        const dir = makeTempDir();
        const transcriptPath = writeTranscript(dir, 75, 100);
        const env = {
            OMC_QUIET: '2',
            OMC_PREEMPTIVE_COMPACTION_WARNING_PERCENT: '70',
            OMC_PREEMPTIVE_COMPACTION_CRITICAL_PERCENT: '90',
            OMC_PREEMPTIVE_COMPACTION_COOLDOWN_MS: '60000',
        };
        const first = runPostToolVerifier({
            cwd: dir,
            transcript_path: transcriptPath,
            tool_name: 'Read',
            session_id: 'preemptive-cooldown-test',
            tool_response: 'read output',
        }, env);
        const second = runPostToolVerifier({
            cwd: dir,
            transcript_path: transcriptPath,
            tool_name: 'Read',
            session_id: 'preemptive-cooldown-test',
            tool_response: 'read output',
        }, env);
        expect(first.hookSpecificOutput).toBeDefined();
        expect(second).toEqual({ continue: true, suppressOutput: true });
    });
    it('does not let one session suppress another session in the same repo', () => {
        const dir = makeTempDir();
        const transcriptPath = writeTranscript(dir, 75, 100);
        const env = {
            OMC_QUIET: '2',
            OMC_PREEMPTIVE_COMPACTION_WARNING_PERCENT: '70',
            OMC_PREEMPTIVE_COMPACTION_CRITICAL_PERCENT: '90',
            OMC_PREEMPTIVE_COMPACTION_COOLDOWN_MS: '60000',
        };
        const first = runPostToolVerifier({
            cwd: dir,
            transcript_path: transcriptPath,
            tool_name: 'Read',
            session_id: 'preemptive-session-a',
            tool_response: 'read output',
        }, env);
        const second = runPostToolVerifier({
            cwd: dir,
            transcript_path: transcriptPath,
            tool_name: 'Read',
            session_id: 'preemptive-session-b',
            tool_response: 'read output',
        }, env);
        expect(first.hookSpecificOutput).toBeDefined();
        expect(second.hookSpecificOutput).toBeDefined();
    });
    it('escalates to a critical warning even when a warning cooldown is active', () => {
        const dir = makeTempDir();
        const firstTranscriptPath = writeTranscript(dir, 72, 100);
        runPostToolVerifier({
            cwd: dir,
            transcript_path: firstTranscriptPath,
            tool_name: 'Read',
            session_id: 'preemptive-escalation-test',
            tool_response: 'read output',
        }, {
            OMC_QUIET: '2',
            OMC_PREEMPTIVE_COMPACTION_WARNING_PERCENT: '70',
            OMC_PREEMPTIVE_COMPACTION_CRITICAL_PERCENT: '90',
            OMC_PREEMPTIVE_COMPACTION_COOLDOWN_MS: '60000',
        });
        const escalatedTranscriptPath = writeTranscript(dir, 91, 100);
        const escalated = runPostToolVerifier({
            cwd: dir,
            transcript_path: escalatedTranscriptPath,
            tool_name: 'Read',
            session_id: 'preemptive-escalation-test',
            tool_response: 'read output',
        }, {
            OMC_QUIET: '2',
            OMC_PREEMPTIVE_COMPACTION_WARNING_PERCENT: '70',
            OMC_PREEMPTIVE_COMPACTION_CRITICAL_PERCENT: '90',
            OMC_PREEMPTIVE_COMPACTION_COOLDOWN_MS: '60000',
        });
        expect(escalated).toEqual({
            continue: true,
            hookSpecificOutput: {
                hookEventName: 'PostToolUse',
                additionalContext: '[OMC CRITICAL] Context at 91% (critical threshold: 90%). Run /compact now before continuing with more tools or agent fan-out.',
            },
        });
    });
    it('falls back to hook input context_window when transcript lacks context_window fields', () => {
        const dir = makeTempDir();
        const transcriptPath = writeTranscriptWithoutContextWindow(dir, 10);
        const result = runPostToolVerifier({
            cwd: dir,
            transcript_path: transcriptPath,
            tool_name: 'Read',
            session_id: 'preemptive-fallback-used-percent-test',
            tool_response: 'read output',
            context_window: {
                used_percentage: 72,
            },
        }, {
            OMC_QUIET: '2',
            OMC_PREEMPTIVE_COMPACTION_WARNING_PERCENT: '70',
            OMC_PREEMPTIVE_COMPACTION_CRITICAL_PERCENT: '90',
        });
        expect(result).toEqual({
            continue: true,
            hookSpecificOutput: {
                hookEventName: 'PostToolUse',
                additionalContext: '[OMC WARNING] Context at 72% (warning threshold: 70%). Plan a /compact soon to preserve room for the next large tool output.',
            },
        });
    });
    it('calculates fallback context percent from context_window.current_usage when used_percentage is absent', () => {
        const dir = makeTempDir();
        const transcriptPath = writeTranscriptWithoutContextWindow(dir, 10);
        const result = runPostToolVerifier({
            cwd: dir,
            transcript_path: transcriptPath,
            tool_name: 'Read',
            session_id: 'preemptive-fallback-current-usage-test',
            tool_response: 'read output',
            context_window: {
                context_window_size: 100,
                current_usage: {
                    input_tokens: 60,
                    cache_creation_input_tokens: 5,
                    cache_read_input_tokens: 7,
                },
            },
        }, {
            OMC_QUIET: '2',
            OMC_PREEMPTIVE_COMPACTION_WARNING_PERCENT: '70',
            OMC_PREEMPTIVE_COMPACTION_CRITICAL_PERCENT: '90',
        });
        expect(result).toEqual({
            continue: true,
            hookSpecificOutput: {
                hookEventName: 'PostToolUse',
                additionalContext: '[OMC WARNING] Context at 72% (warning threshold: 70%). Plan a /compact soon to preserve room for the next large tool output.',
            },
        });
    });
});
describe('post-tool-verifier Write/Edit response envelopes', () => {
    const longFailureProse = [
        'The following fixture text documents prior failures and must not be treated as the tool status.',
        'x'.repeat(430),
        'error: fixture prose only',
        'no such file: fixture prose only',
        'permission denied: fixture prose only',
    ].join('\n');
    it('trusts Write success markers extracted from object response fields before JSON stringify analysis', () => {
        const result = runPostToolVerifier({
            cwd: makeTempDir(),
            tool_name: 'Write',
            session_id: 'write-object-success-envelope-test',
            tool_response: {
                result: 'File written successfully at: /tmp/example.txt',
                content: longFailureProse,
            },
        }, { OMC_QUIET: '2' });
        expect(result).toEqual({ continue: true, suppressOutput: true });
    });
    it('trusts Edit success markers extracted from object response message before JSON stringify analysis', () => {
        const result = runPostToolVerifier({
            cwd: makeTempDir(),
            tool_name: 'Edit',
            session_id: 'edit-object-success-envelope-test',
            tool_response: {
                message: 'The file /tmp/example.txt has been updated successfully.',
                content: longFailureProse,
            },
        }, { OMC_QUIET: '2' });
        expect(result).toEqual({ continue: true, suppressOutput: true });
    });
    it('keeps real plain string Write failures failing', () => {
        const result = runPostToolVerifier({
            cwd: makeTempDir(),
            tool_name: 'Write',
            session_id: 'write-string-failure-test',
            tool_response: 'Error: failed to write file',
        }, { OMC_QUIET: '2' });
        expect(result).toEqual({
            continue: true,
            hookSpecificOutput: {
                hookEventName: 'PostToolUse',
                additionalContext: 'Write operation failed. Check file permissions and directory existence.',
            },
        });
    });
    it('keeps real plain string Edit failures failing', () => {
        const result = runPostToolVerifier({
            cwd: makeTempDir(),
            tool_name: 'Edit',
            session_id: 'edit-string-failure-test',
            tool_response: 'Error: failed to edit file',
        }, { OMC_QUIET: '2' });
        expect(result).toEqual({
            continue: true,
            hookSpecificOutput: {
                hookEventName: 'PostToolUse',
                additionalContext: 'Edit operation failed. Verify file exists and content matches exactly.',
            },
        });
    });
});
//# sourceMappingURL=preemptive-compaction-hook.test.js.map