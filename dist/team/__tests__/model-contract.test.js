import { describe, it, expect, vi } from 'vitest';
import { spawnSync } from 'child_process';
import { getContract, buildLaunchArgs, buildWorkerArgv, getWorkerEnv, parseCliOutput, isPromptModeAgent, getPromptModeArgs, isCliAvailable, shouldLoadShellRc, resolveCliBinaryPath, clearResolvedPathCache, validateCliBinaryPath, _testInternals, } from '../model-contract.js';
vi.mock('child_process', async (importOriginal) => {
    const actual = await importOriginal();
    return {
        ...actual,
        spawnSync: vi.fn(actual.spawnSync),
    };
});
describe('model-contract', () => {
    describe('backward-compat API shims', () => {
        it('shouldLoadShellRc returns false for non-interactive compatibility mode', () => {
            expect(shouldLoadShellRc()).toBe(false);
        });
        it('resolveCliBinaryPath resolves and caches paths', () => {
            const mockSpawnSync = vi.mocked(spawnSync);
            mockSpawnSync.mockReturnValue({ status: 0, stdout: '/usr/local/bin/claude\n', stderr: '', pid: 0, output: [], signal: null });
            clearResolvedPathCache();
            expect(resolveCliBinaryPath('claude')).toBe('/usr/local/bin/claude');
            expect(resolveCliBinaryPath('claude')).toBe('/usr/local/bin/claude');
            expect(mockSpawnSync).toHaveBeenCalledTimes(1);
            clearResolvedPathCache();
        });
        it('resolveCliBinaryPath rejects unsafe names and paths', () => {
            const mockSpawnSync = vi.mocked(spawnSync);
            expect(() => resolveCliBinaryPath('../evil')).toThrow('Invalid CLI binary name');
            mockSpawnSync.mockReturnValue({ status: 0, stdout: '/tmp/evil/claude\n', stderr: '', pid: 0, output: [], signal: null });
            clearResolvedPathCache();
            expect(() => resolveCliBinaryPath('claude')).toThrow('untrusted location');
            clearResolvedPathCache();
            mockSpawnSync.mockRestore();
        });
        it('validateCliBinaryPath returns compatibility result object', () => {
            const mockSpawnSync = vi.mocked(spawnSync);
            mockSpawnSync.mockReturnValue({ status: 0, stdout: '/usr/local/bin/claude\n', stderr: '', pid: 0, output: [], signal: null });
            clearResolvedPathCache();
            expect(validateCliBinaryPath('claude')).toEqual({
                valid: true,
                binary: 'claude',
                resolvedPath: '/usr/local/bin/claude',
            });
            mockSpawnSync.mockReturnValue({ status: 1, stdout: '', stderr: 'not found', pid: 0, output: [], signal: null });
            clearResolvedPathCache();
            const invalid = validateCliBinaryPath('missing-cli');
            expect(invalid.valid).toBe(false);
            expect(invalid.binary).toBe('missing-cli');
            expect(invalid.reason).toContain('not found in PATH');
            clearResolvedPathCache();
            mockSpawnSync.mockRestore();
        });
        it('exposes compatibility test internals for path policy', () => {
            expect(_testInternals.UNTRUSTED_PATH_PATTERNS.some(p => p.test('/tmp/evil'))).toBe(true);
            expect(_testInternals.UNTRUSTED_PATH_PATTERNS.some(p => p.test('/usr/local/bin/claude'))).toBe(false);
            const prefixes = _testInternals.getTrustedPrefixes();
            expect(prefixes).toContain('/usr/local/bin');
            expect(prefixes).toContain('/usr/bin');
        });
    });
    describe('getContract', () => {
        it('returns contract for claude', () => {
            const c = getContract('claude');
            expect(c.agentType).toBe('claude');
            expect(c.binary).toBe('claude');
        });
        it('returns contract for codex', () => {
            const c = getContract('codex');
            expect(c.agentType).toBe('codex');
            expect(c.binary).toBe('codex');
        });
        it('returns contract for gemini', () => {
            const c = getContract('gemini');
            expect(c.agentType).toBe('gemini');
            expect(c.binary).toBe('gemini');
        });
        it('throws for unknown agent type', () => {
            expect(() => getContract('unknown')).toThrow('Unknown agent type');
        });
    });
    describe('buildLaunchArgs', () => {
        it('claude includes --dangerously-skip-permissions', () => {
            const args = buildLaunchArgs('claude', { teamName: 't', workerName: 'w', cwd: '/tmp' });
            expect(args).toContain('--dangerously-skip-permissions');
        });
        it('codex includes --dangerously-bypass-approvals-and-sandbox', () => {
            const args = buildLaunchArgs('codex', { teamName: 't', workerName: 'w', cwd: '/tmp' });
            expect(args).not.toContain('--full-auto');
            expect(args).toContain('--dangerously-bypass-approvals-and-sandbox');
        });
        it('gemini includes --approval-mode yolo', () => {
            const args = buildLaunchArgs('gemini', { teamName: 't', workerName: 'w', cwd: '/tmp' });
            expect(args).toContain('--approval-mode');
            expect(args).toContain('yolo');
            expect(args).not.toContain('-i');
        });
        it('passes model flag when specified', () => {
            const args = buildLaunchArgs('codex', { teamName: 't', workerName: 'w', cwd: '/tmp', model: 'gpt-4' });
            expect(args).toContain('--model');
            expect(args).toContain('gpt-4');
        });
    });
    describe('getWorkerEnv', () => {
        it('returns correct env vars', () => {
            const env = getWorkerEnv('my-team', 'worker-1', 'codex');
            expect(env.OMC_TEAM_WORKER).toBe('my-team/worker-1');
            expect(env.OMC_TEAM_NAME).toBe('my-team');
            expect(env.OMC_WORKER_AGENT_TYPE).toBe('codex');
        });
        it('propagates allowlisted model selection env vars into worker startup env', () => {
            const env = getWorkerEnv('my-team', 'worker-1', 'claude', {
                ANTHROPIC_MODEL: 'claude-opus-4-1',
                CLAUDE_MODEL: 'claude-sonnet-4-5',
                ANTHROPIC_BASE_URL: 'https://example-gateway.invalid',
                CLAUDE_CODE_USE_BEDROCK: '1',
                CLAUDE_CODE_BEDROCK_OPUS_MODEL: 'us.anthropic.claude-opus-4-6-v1:0',
                CLAUDE_CODE_BEDROCK_SONNET_MODEL: 'us.anthropic.claude-sonnet-4-6-v1:0',
                CLAUDE_CODE_BEDROCK_HAIKU_MODEL: 'us.anthropic.claude-haiku-4-5-v1:0',
                ANTHROPIC_DEFAULT_OPUS_MODEL: 'claude-opus-4-6-custom',
                ANTHROPIC_DEFAULT_SONNET_MODEL: 'claude-sonnet-4-6-custom',
                ANTHROPIC_DEFAULT_HAIKU_MODEL: 'claude-haiku-4-5-custom',
                OMC_MODEL_HIGH: 'claude-opus-4-6-override',
                OMC_MODEL_MEDIUM: 'claude-sonnet-4-6-override',
                OMC_MODEL_LOW: 'claude-haiku-4-5-override',
                OMC_EXTERNAL_MODELS_DEFAULT_CODEX_MODEL: 'gpt-5',
                OMC_GEMINI_DEFAULT_MODEL: 'gemini-2.5-pro',
                ANTHROPIC_API_KEY: 'should-not-be-forwarded',
            });
            expect(env.ANTHROPIC_MODEL).toBe('claude-opus-4-1');
            expect(env.CLAUDE_MODEL).toBe('claude-sonnet-4-5');
            expect(env.ANTHROPIC_BASE_URL).toBe('https://example-gateway.invalid');
            expect(env.CLAUDE_CODE_USE_BEDROCK).toBe('1');
            expect(env.CLAUDE_CODE_BEDROCK_OPUS_MODEL).toBe('us.anthropic.claude-opus-4-6-v1:0');
            expect(env.CLAUDE_CODE_BEDROCK_SONNET_MODEL).toBe('us.anthropic.claude-sonnet-4-6-v1:0');
            expect(env.CLAUDE_CODE_BEDROCK_HAIKU_MODEL).toBe('us.anthropic.claude-haiku-4-5-v1:0');
            expect(env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe('claude-opus-4-6-custom');
            expect(env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('claude-sonnet-4-6-custom');
            expect(env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe('claude-haiku-4-5-custom');
            expect(env.OMC_MODEL_HIGH).toBe('claude-opus-4-6-override');
            expect(env.OMC_MODEL_MEDIUM).toBe('claude-sonnet-4-6-override');
            expect(env.OMC_MODEL_LOW).toBe('claude-haiku-4-5-override');
            expect(env.OMC_EXTERNAL_MODELS_DEFAULT_CODEX_MODEL).toBe('gpt-5');
            expect(env.OMC_GEMINI_DEFAULT_MODEL).toBe('gemini-2.5-pro');
            expect(env.ANTHROPIC_API_KEY).toBeUndefined();
        });
        it('rejects invalid team names', () => {
            expect(() => getWorkerEnv('Bad-Team', 'worker-1', 'codex')).toThrow('Invalid team name');
        });
    });
    describe('buildWorkerArgv', () => {
        it('builds binary + args', () => {
            const mockSpawnSync = vi.mocked(spawnSync);
            mockSpawnSync.mockReturnValueOnce({ status: 1, stdout: '', stderr: '', pid: 0, output: [], signal: null });
            expect(buildWorkerArgv('codex', { teamName: 'my-team', workerName: 'worker-1', cwd: '/tmp' })).toEqual([
                'codex',
                '--dangerously-bypass-approvals-and-sandbox',
            ]);
            expect(mockSpawnSync).toHaveBeenCalledWith('which', ['codex'], { timeout: 5000, encoding: 'utf8' });
            mockSpawnSync.mockRestore();
        });
        it('prefers resolved absolute binary path when available', () => {
            const mockSpawnSync = vi.mocked(spawnSync);
            mockSpawnSync.mockReturnValueOnce({ status: 0, stdout: '/usr/local/bin/codex\n', stderr: '', pid: 0, output: [], signal: null });
            expect(buildWorkerArgv('codex', { teamName: 'my-team', workerName: 'worker-1', cwd: '/tmp' })[0]).toBe('/usr/local/bin/codex');
            mockSpawnSync.mockRestore();
        });
    });
    describe('parseCliOutput', () => {
        it('claude returns trimmed output', () => {
            expect(parseCliOutput('claude', '  hello  ')).toBe('hello');
        });
        it('codex extracts result from JSONL', () => {
            const jsonl = JSON.stringify({ type: 'result', output: 'the answer' });
            expect(parseCliOutput('codex', jsonl)).toBe('the answer');
        });
        it('codex falls back to raw output if no JSONL', () => {
            expect(parseCliOutput('codex', 'plain text')).toBe('plain text');
        });
    });
    describe('isCliAvailable', () => {
        it('checks version without shell:true for standard binaries', () => {
            const mockSpawnSync = vi.mocked(spawnSync);
            mockSpawnSync
                .mockReturnValueOnce({ status: 1, stdout: '', stderr: '', pid: 0, output: [], signal: null })
                .mockReturnValueOnce({ status: 0, stdout: '', stderr: '', pid: 0, output: [], signal: null });
            isCliAvailable('codex');
            expect(mockSpawnSync).toHaveBeenNthCalledWith(1, 'which', ['codex'], { timeout: 5000, encoding: 'utf8' });
            expect(mockSpawnSync).toHaveBeenNthCalledWith(2, 'codex', ['--version'], { timeout: 5000 });
            mockSpawnSync.mockRestore();
        });
        it('uses COMSPEC for .cmd binaries on win32', () => {
            const mockSpawnSync = vi.mocked(spawnSync);
            vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
            vi.stubEnv('COMSPEC', 'C:\\Windows\\System32\\cmd.exe');
            mockSpawnSync
                .mockReturnValueOnce({ status: 0, stdout: 'C:\\Tools\\codex.cmd\n', stderr: '', pid: 0, output: [], signal: null })
                .mockReturnValueOnce({ status: 0, stdout: '', stderr: '', pid: 0, output: [], signal: null });
            isCliAvailable('codex');
            expect(mockSpawnSync).toHaveBeenNthCalledWith(1, 'where', ['codex'], { timeout: 5000, encoding: 'utf8' });
            expect(mockSpawnSync).toHaveBeenNthCalledWith(2, 'C:\\Windows\\System32\\cmd.exe', ['/d', '/s', '/c', '"C:\\Tools\\codex.cmd" --version'], { timeout: 5000 });
            mockSpawnSync.mockRestore();
            vi.unstubAllEnvs();
        });
    });
    describe('prompt mode (headless TUI bypass)', () => {
        it('gemini supports prompt mode', () => {
            expect(isPromptModeAgent('gemini')).toBe(true);
            const c = getContract('gemini');
            expect(c.supportsPromptMode).toBe(true);
            expect(c.promptModeFlag).toBe('-i');
        });
        it('claude does not support prompt mode', () => {
            expect(isPromptModeAgent('claude')).toBe(false);
        });
        it('codex supports prompt mode (positional argument, no flag)', () => {
            expect(isPromptModeAgent('codex')).toBe(true);
            const c = getContract('codex');
            expect(c.supportsPromptMode).toBe(true);
            expect(c.promptModeFlag).toBeUndefined();
        });
        it('getPromptModeArgs returns flag + instruction for gemini', () => {
            const args = getPromptModeArgs('gemini', 'Read inbox');
            expect(args).toEqual(['-i', 'Read inbox']);
        });
        it('getPromptModeArgs returns instruction only (positional) for codex', () => {
            const args = getPromptModeArgs('codex', 'Read inbox');
            expect(args).toEqual(['Read inbox']);
        });
        it('getPromptModeArgs returns empty array for non-prompt-mode agents', () => {
            expect(getPromptModeArgs('claude', 'Read inbox')).toEqual([]);
        });
    });
});
//# sourceMappingURL=model-contract.test.js.map