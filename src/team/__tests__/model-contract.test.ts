import { describe, it, expect, vi } from 'vitest';
import { spawnSync } from 'child_process';
import {
  getContract,
  buildLaunchArgs,
  buildWorkerArgv,
  getWorkerEnv,
  parseCliOutput,
  isPromptModeAgent,
  getPromptModeArgs,
  isHeadlessSupportedOnPlatform,
  validateCliAvailable,
  isCliAvailable,
  shouldLoadShellRc,
  resolveCliBinaryPath,
  clearResolvedPathCache,
  validateCliBinaryPath,
  resolveClaudeWorkerModel,
  shouldUseClaudeBareMode,
  _testInternals,
  buildValidatedWorkerLaunchDescriptor,
  validateWorkerLaunchDescriptor,
} from '../model-contract.js';

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return {
    ...actual,
    spawnSync: vi.fn(actual.spawnSync),
  };
});

function setProcessPlatform(platform: NodeJS.Platform): () => void {
  const originalPlatform = process.platform;
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
  return () => {
    Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
  };
}

function withAnthropicApiKey(value: string | undefined, fn: () => void): void {
  const original = process.env.ANTHROPIC_API_KEY;
  if (value === undefined) {
    delete process.env.ANTHROPIC_API_KEY;
  } else {
    process.env.ANTHROPIC_API_KEY = value;
  }
  try {
    fn();
  } finally {
    if (original === undefined) {
      delete process.env.ANTHROPIC_API_KEY;
    } else {
      process.env.ANTHROPIC_API_KEY = original;
    }
  }
}

function countArg(args: string[], expected: string): number {
  return args.filter(arg => arg === expected).length;
}

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

    it('isTrustedPrefix enforces directory boundaries (no sibling-prefix bypass)', () => {
      const origHome = process.env.HOME;
      process.env.HOME = '/home/tester';
      try {
        const { isTrustedPrefix } = _testInternals;
        // exact trusted dir + true descendants are trusted
        expect(isTrustedPrefix('/usr/bin')).toBe(true);
        expect(isTrustedPrefix('/usr/bin/codex')).toBe(true);
        expect(isTrustedPrefix('/usr/local/bin/claude')).toBe(true);
        expect(isTrustedPrefix('/opt/homebrew/bin/gemini')).toBe(true);
        expect(isTrustedPrefix('/home/tester/.local/bin/cli')).toBe(true);
        // siblings whose name merely begins with a trusted prefix are NOT trusted
        expect(isTrustedPrefix('/usr/bin-malicious/cli')).toBe(false);
        expect(isTrustedPrefix('/home/tester/.local/bin-evil/cli')).toBe(false);
        expect(isTrustedPrefix('/opt/homebrew-evil/x')).toBe(false);
        expect(isTrustedPrefix('/home/tester/Downloads/cli')).toBe(false);
        // custom trusted dirs (OMC_TRUSTED_CLI_DIRS) get the same boundary check
        const origCustom = process.env.OMC_TRUSTED_CLI_DIRS;
        process.env.OMC_TRUSTED_CLI_DIRS = '/opt/mybins';
        try {
          expect(isTrustedPrefix('/opt/mybins/grok')).toBe(true);
          expect(isTrustedPrefix('/opt/mybins-evil/grok')).toBe(false);
        } finally {
          if (origCustom === undefined) delete process.env.OMC_TRUSTED_CLI_DIRS;
          else process.env.OMC_TRUSTED_CLI_DIRS = origCustom;
        }
      } finally {
        if (origHome === undefined) delete process.env.HOME;
        else process.env.HOME = origHome;
      }
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
    it('returns contract for grok', () => {
      const c = getContract('grok');
      expect(c.agentType).toBe('grok');
      expect(c.binary).toBe('grok');
      expect(c.supportsPromptMode).toBe(true);
    });
    it('returns contract for antigravity', () => {
      const c = getContract('antigravity');
      expect(c.agentType).toBe('antigravity');
      expect(c.binary).toBe('agy');
      expect(c.supportsPromptMode).toBe(true);
      expect(c.promptModeFlag).toBe('-p');
      // Points to official install instructions, not a raw pipe-to-shell command.
      expect(c.installInstructions).toContain('antigravity.google');
      expect(c.installInstructions).not.toContain('| bash');
    });
    it('throws for unknown agent type', () => {
      expect(() => getContract('unknown' as any)).toThrow('Unknown agent type');
    });

    describe('antigravity Windows headless guard (omc team)', () => {
      it('reports antigravity headless unsupported on win32, supported elsewhere', () => {
        expect(isHeadlessSupportedOnPlatform('antigravity', 'win32')).toBe(false);
        expect(isHeadlessSupportedOnPlatform('antigravity', 'darwin')).toBe(true);
        expect(isHeadlessSupportedOnPlatform('antigravity', 'linux')).toBe(true);
        // Other prompt-mode providers stay supported on Windows.
        expect(isHeadlessSupportedOnPlatform('gemini', 'win32')).toBe(true);
        expect(isHeadlessSupportedOnPlatform('grok', 'win32')).toBe(true);
      });

      it('getPromptModeArgs throws for an antigravity team worker on Windows', () => {
        const restore = setProcessPlatform('win32');
        try {
          expect(() => getPromptModeArgs('antigravity', '/path/to/inbox.md')).toThrow(/not supported on Windows/);
          // Still works for gemini on Windows (uses its own stdin-safe handling elsewhere).
          expect(getPromptModeArgs('gemini', '/path/to/inbox.md')).toEqual(['-p', '/path/to/inbox.md']);
        } finally {
          restore();
        }
      });

      it('getPromptModeArgs builds antigravity args normally on non-Windows', () => {
        const restore = setProcessPlatform('darwin');
        try {
          expect(getPromptModeArgs('antigravity', '/path/to/inbox.md')).toEqual(['-p', '/path/to/inbox.md']);
        } finally {
          restore();
        }
      });

      it('validateCliAvailable refuses antigravity on Windows with a clear message', () => {
        const restore = setProcessPlatform('win32');
        try {
          expect(() => validateCliAvailable('antigravity')).toThrow(/not supported on Windows/);
        } finally {
          restore();
        }
      });
    });

    it('blocks codex when external LLM is disabled', async () => {
      const origSecurity = process.env.OMC_SECURITY;
      process.env.OMC_SECURITY = 'strict';
      try {
        const { clearSecurityConfigCache } = await import('../../lib/security-config.js');
        clearSecurityConfigCache();
        expect(() => getContract('codex')).toThrow('blocked by security policy');
      } finally {
        if (origSecurity === undefined) {
          delete process.env.OMC_SECURITY;
        } else {
          process.env.OMC_SECURITY = origSecurity;
        }
        const { clearSecurityConfigCache } = await import('../../lib/security-config.js');
        clearSecurityConfigCache();
      }
    });

    it('blocks gemini when external LLM is disabled', async () => {
      const origSecurity = process.env.OMC_SECURITY;
      process.env.OMC_SECURITY = 'strict';
      try {
        const { clearSecurityConfigCache } = await import('../../lib/security-config.js');
        clearSecurityConfigCache();
        expect(() => getContract('gemini')).toThrow('blocked by security policy');
      } finally {
        if (origSecurity === undefined) {
          delete process.env.OMC_SECURITY;
        } else {
          process.env.OMC_SECURITY = origSecurity;
        }
        const { clearSecurityConfigCache } = await import('../../lib/security-config.js');
        clearSecurityConfigCache();
      }
    });

    it('blocks grok when external LLM is disabled', async () => {
      const origSecurity = process.env.OMC_SECURITY;
      process.env.OMC_SECURITY = 'strict';
      try {
        const { clearSecurityConfigCache } = await import('../../lib/security-config.js');
        clearSecurityConfigCache();
        expect(() => getContract('grok')).toThrow('blocked by security policy');
      } finally {
        if (origSecurity === undefined) {
          delete process.env.OMC_SECURITY;
        } else {
          process.env.OMC_SECURITY = origSecurity;
        }
        const { clearSecurityConfigCache } = await import('../../lib/security-config.js');
        clearSecurityConfigCache();
      }
    });

    it('allows claude even when external LLM is disabled', async () => {
      const origSecurity = process.env.OMC_SECURITY;
      process.env.OMC_SECURITY = 'strict';
      try {
        const { clearSecurityConfigCache } = await import('../../lib/security-config.js');
        clearSecurityConfigCache();
        expect(() => getContract('claude')).not.toThrow();
      } finally {
        if (origSecurity === undefined) {
          delete process.env.OMC_SECURITY;
        } else {
          process.env.OMC_SECURITY = origSecurity;
        }
        const { clearSecurityConfigCache } = await import('../../lib/security-config.js');
        clearSecurityConfigCache();
      }
    });
  });

  describe('buildLaunchArgs', () => {
    it('claude includes --dangerously-skip-permissions', () => {
      const args = buildLaunchArgs('claude', { teamName: 't', workerName: 'w', cwd: '/tmp' });
      expect(args).toContain('--dangerously-skip-permissions');
    });
    it('detects Claude bare mode only for non-empty ANTHROPIC_API_KEY', () => {
      expect(shouldUseClaudeBareMode({ ANTHROPIC_API_KEY: 'sk-test' })).toBe(true);
      expect(shouldUseClaudeBareMode({ ANTHROPIC_API_KEY: '' })).toBe(false);
      expect(shouldUseClaudeBareMode({ ANTHROPIC_API_KEY: '   ' })).toBe(false);
      expect(shouldUseClaudeBareMode({})).toBe(false);
    });
    it('claude omits --bare when ANTHROPIC_API_KEY is absent, empty, or whitespace', () => {
      for (const value of [undefined, '', '   ']) {
        withAnthropicApiKey(value, () => {
          const args = buildLaunchArgs('claude', { teamName: 't', workerName: 'w', cwd: '/tmp' });
          expect(args).toContain('--dangerously-skip-permissions');
          expect(args).not.toContain('--bare');
        });
      }
    });
    it('claude includes --bare with API-key auth and dedupes exact extra flag', () => {
      withAnthropicApiKey('sk-test', () => {
        const args = buildLaunchArgs('claude', { teamName: 't', workerName: 'w', cwd: '/tmp' });
        expect(args).toContain('--dangerously-skip-permissions');
        expect(args).toContain('--bare');
        expect(countArg(args, '--bare')).toBe(1);

        const deduped = buildLaunchArgs('claude', {
          teamName: 't',
          workerName: 'w',
          cwd: '/tmp',
          extraFlags: ['--bare'],
        });
        expect(countArg(deduped, '--bare')).toBe(1);
      });
    });
    it('codex includes --dangerously-bypass-approvals-and-sandbox', () => {
      const args = buildLaunchArgs('codex', { teamName: 't', workerName: 'w', cwd: '/tmp' });
      expect(args).not.toContain('exec');
      expect(args).not.toContain('--full-auto');
      expect(args).toContain('--dangerously-bypass-approvals-and-sandbox');
    });
    it('gemini includes --approval-mode yolo', () => {
      const args = buildLaunchArgs('gemini', { teamName: 't', workerName: 'w', cwd: '/tmp' });
      expect(args).toContain('--approval-mode');
      expect(args).toContain('yolo');
      expect(args).not.toContain('-p');
    });
    it('antigravity leads with --dangerously-skip-permissions (no --print; -p is appended later by getPromptModeArgs)', () => {
      const noModel = buildLaunchArgs('antigravity', { teamName: 't', workerName: 'w', cwd: '/tmp' });
      expect(noModel).toEqual(['--dangerously-skip-permissions']);
      expect(noModel).not.toContain('--model');
      // -p is NOT in buildLaunchArgs: agy's -p takes the prompt as its value and
      // is appended (with the instruction) by getPromptModeArgs.
      expect(noModel).not.toContain('-p');
      expect(noModel).not.toContain('--print');

      const withModel = buildLaunchArgs('antigravity', { teamName: 't', workerName: 'w', cwd: '/tmp', model: 'Gemini 3.1 Pro (High)' });
      expect(withModel).toEqual(['--dangerously-skip-permissions', '--model', 'Gemini 3.1 Pro (High)']);
      // approval flag precedes --model
      expect(withModel.indexOf('--dangerously-skip-permissions')).toBeLessThan(withModel.indexOf('--model'));
    });
    it('antigravity appends extraFlags after the model flag', () => {
      const args = buildLaunchArgs('antigravity', { teamName: 't', workerName: 'w', cwd: '/tmp', model: 'm', extraFlags: ['--foo'] });
      expect(args).toEqual(['--dangerously-skip-permissions', '--model', 'm', '--foo']);
    });
    it('grok includes --always-approve with no model and appends --model <m> when given', () => {
      const noModel = buildLaunchArgs('grok', { teamName: 't', workerName: 'w', cwd: '/tmp' });
      expect(noModel).toEqual(['--always-approve']);
      expect(noModel).not.toContain('--model');

      const withModel = buildLaunchArgs('grok', { teamName: 't', workerName: 'w', cwd: '/tmp', model: 'grok-4-fast' });
      expect(withModel).toEqual(['--always-approve', '--model', 'grok-4-fast']);
    });
    it('passes model flag when specified', () => {
      const args = buildLaunchArgs('codex', { teamName: 't', workerName: 'w', cwd: '/tmp', model: 'gpt-4' });
      expect(args).toContain('--model');
      expect(args).toContain('gpt-4');
    });
    it('normalizes full Claude model ID to alias for claude agent (issue #1415)', () => {
      const args = buildLaunchArgs('claude', { teamName: 't', workerName: 'w', cwd: '/tmp', model: 'claude-sonnet-4-6' });
      expect(args).toContain('--model');
      expect(args).toContain('sonnet');
      expect(args).not.toContain('claude-sonnet-4-6');
    });
    it('passes Bedrock model ID through without normalization for claude agent (issue #1695)', () => {
      withAnthropicApiKey('sk-test', () => {
        const args = buildLaunchArgs('claude', { teamName: 't', workerName: 'w', cwd: '/tmp', model: 'us.anthropic.claude-opus-4-6-v1:0' });
        expect(args).toContain('--bare');
        expect(countArg(args, '--bare')).toBe(1);
        expect(args).toContain('--model');
        expect(args).toContain('us.anthropic.claude-opus-4-6-v1:0');
        expect(args).not.toContain('opus');
      });
    });
    it('passes Bedrock ARN model ID through without normalization (issue #1695)', () => {
      const arn = 'arn:aws:bedrock:us-east-2:123456789012:inference-profile/global.anthropic.claude-sonnet-4-6-v1:0';
      const args = buildLaunchArgs('claude', { teamName: 't', workerName: 'w', cwd: '/tmp', model: arn });
      expect(args).toContain('--model');
      expect(args).toContain(arn);
    });
    it('passes Vertex AI model ID through without normalization (issue #1695)', () => {
      const args = buildLaunchArgs('claude', { teamName: 't', workerName: 'w', cwd: '/tmp', model: 'vertex_ai/claude-sonnet-4-6@20250514' });
      expect(args).toContain('--model');
      expect(args).toContain('vertex_ai/claude-sonnet-4-6@20250514');
      expect(args).not.toContain('sonnet');
    });
    it('does not normalize non-Claude models for codex/gemini agents', () => {
      const args = buildLaunchArgs('codex', { teamName: 't', workerName: 'w', cwd: '/tmp', model: 'gpt-4o' });
      expect(args).toContain('gpt-4o');
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
    it('builds codex interactive worker argv without the exec subcommand', () => {
      const mockSpawnSync = vi.mocked(spawnSync);
      mockSpawnSync.mockReturnValueOnce({ status: 1, stdout: '', stderr: '', pid: 0, output: [], signal: null } as any);

      const argv = buildWorkerArgv('codex', { teamName: 'my-team', workerName: 'worker-1', cwd: '/tmp' });
      expect(argv).toEqual([
        'codex',
        '--dangerously-bypass-approvals-and-sandbox',
      ]);
      expect(argv).not.toContain('exec');
      expect(mockSpawnSync).toHaveBeenCalledWith('which', ['codex'], { timeout: 5000, encoding: 'utf8' });
      mockSpawnSync.mockRestore();
    });

    it('builds claude interactive worker argv without the exec subcommand', () => {
      const mockSpawnSync = vi.mocked(spawnSync);
      mockSpawnSync.mockReturnValueOnce({ status: 1, stdout: '', stderr: '', pid: 0, output: [], signal: null } as any);

      let argv: string[] = [];
      withAnthropicApiKey('sk-test', () => {
        argv = buildWorkerArgv('claude', { teamName: 'my-team', workerName: 'worker-1', cwd: '/tmp' });
      });

      expect(argv[0]).toBe('claude');
      expect(argv).toContain('--dangerously-skip-permissions');
      expect(argv).toContain('--bare');
      expect(countArg(argv, '--bare')).toBe(1);
      expect(argv).not.toContain('exec');
      expect(mockSpawnSync).toHaveBeenCalledWith('which', ['claude'], { timeout: 5000, encoding: 'utf8' });
      mockSpawnSync.mockRestore();
    });

    it('prefers resolved absolute binary path when available', () => {
      const mockSpawnSync = vi.mocked(spawnSync);
      mockSpawnSync.mockReturnValueOnce({ status: 0, stdout: '/usr/local/bin/codex\n', stderr: '', pid: 0, output: [], signal: null } as any);

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
      clearResolvedPathCache();
      mockSpawnSync
        .mockReturnValueOnce({ status: 1, stdout: '', stderr: '', pid: 0, output: [], signal: null } as any)
        .mockReturnValueOnce({ status: 0, stdout: '', stderr: '', pid: 0, output: [], signal: null } as any);

      isCliAvailable('codex');

      expect(mockSpawnSync).toHaveBeenNthCalledWith(1, 'which', ['codex'], { timeout: 5000, encoding: 'utf8' });
      expect(mockSpawnSync).toHaveBeenNthCalledWith(2, 'codex', ['--version'], { timeout: 5000, shell: false });
      clearResolvedPathCache();
      mockSpawnSync.mockRestore();
    });

    it('uses COMSPEC for .cmd binaries on win32', () => {
      const mockSpawnSync = vi.mocked(spawnSync);
      const restorePlatform = setProcessPlatform('win32');
      vi.stubEnv('COMSPEC', 'C:\\Windows\\System32\\cmd.exe');
      clearResolvedPathCache();

      mockSpawnSync
        .mockReturnValueOnce({ status: 0, stdout: 'C:\\Tools\\codex.cmd\n', stderr: '', pid: 0, output: [], signal: null } as any)
        .mockReturnValueOnce({ status: 0, stdout: '', stderr: '', pid: 0, output: [], signal: null } as any);

      isCliAvailable('codex');

      expect(mockSpawnSync).toHaveBeenNthCalledWith(1, 'where', ['codex'], { timeout: 5000, encoding: 'utf8' });
      expect(mockSpawnSync).toHaveBeenNthCalledWith(
        2,
        'C:\\Windows\\System32\\cmd.exe',
        ['/d', '/s', '/c', '"C:\\Tools\\codex.cmd" --version'],
        { timeout: 5000 }
      );
      restorePlatform();
      clearResolvedPathCache();
      mockSpawnSync.mockRestore();
      vi.unstubAllEnvs();
    });

    it('uses shell:true for unresolved binaries on win32', () => {
      const mockSpawnSync = vi.mocked(spawnSync);
      const restorePlatform = setProcessPlatform('win32');
      clearResolvedPathCache();

      mockSpawnSync
        .mockReturnValueOnce({ status: 1, stdout: '', stderr: '', pid: 0, output: [], signal: null } as any)
        .mockReturnValueOnce({ status: 0, stdout: '', stderr: '', pid: 0, output: [], signal: null } as any);

      isCliAvailable('gemini');

      expect(mockSpawnSync).toHaveBeenNthCalledWith(1, 'where', ['gemini'], { timeout: 5000, encoding: 'utf8' });
      expect(mockSpawnSync).toHaveBeenNthCalledWith(2, 'gemini', ['--version'], { timeout: 5000, shell: true });
      restorePlatform();
      clearResolvedPathCache();
      mockSpawnSync.mockRestore();
    });
  });

  describe('prompt mode (headless TUI bypass)', () => {
    it('gemini supports prompt mode', () => {
      expect(isPromptModeAgent('gemini')).toBe(true);
      const c = getContract('gemini');
      expect(c.supportsPromptMode).toBe(true);
      expect(c.promptModeFlag).toBe('-p');
    });

    it('claude does not support prompt mode', () => {
      expect(isPromptModeAgent('claude')).toBe(false);
    });

    it('codex launches as a persistent interactive worker, not prompt/exec mode', () => {
      expect(isPromptModeAgent('codex')).toBe(false);
      const c = getContract('codex');
      expect(c.supportsPromptMode).toBe(false);
      expect(c.promptModeFlag).toBeUndefined();
    });

    it('grok supports prompt mode', () => {
      expect(isPromptModeAgent('grok')).toBe(true);
      const c = getContract('grok');
      expect(c.supportsPromptMode).toBe(true);
      expect(c.promptModeFlag).toBe('-p');
    });

    it('antigravity supports prompt mode', () => {
      expect(isPromptModeAgent('antigravity')).toBe(true);
      const c = getContract('antigravity');
      expect(c.supportsPromptMode).toBe(true);
      expect(c.promptModeFlag).toBe('-p');
    });

    it('getPromptModeArgs returns flag + instruction for antigravity', () => {
      const args = getPromptModeArgs('antigravity', 'Read inbox');
      expect(args).toEqual(['-p', 'Read inbox']);
    });

    it('getPromptModeArgs returns flag + instruction for grok', () => {
      const args = getPromptModeArgs('grok', 'Read inbox');
      expect(args).toEqual(['-p', 'Read inbox']);
    });

    it('getPromptModeArgs returns flag + instruction for gemini', () => {
      const args = getPromptModeArgs('gemini', 'Read inbox');
      expect(args).toEqual(['-p', 'Read inbox']);
    });

    it('getPromptModeArgs returns empty array for interactive codex and claude workers', () => {
      expect(getPromptModeArgs('codex', 'Read inbox')).toEqual([]);
      expect(getPromptModeArgs('claude', 'Read inbox')).toEqual([]);
    });
  });

  describe('resolveClaudeWorkerModel (issue #1695)', () => {
    it('returns undefined when OMC_ROUTING_FORCE_INHERIT=true even if Bedrock model env vars are set', () => {
      vi.stubEnv('OMC_ROUTING_FORCE_INHERIT', 'true');
      vi.stubEnv('CLAUDE_CODE_USE_BEDROCK', '1');
      vi.stubEnv('ANTHROPIC_MODEL', 'us.anthropic.claude-sonnet-4-5-20250929-v1:0');
      vi.stubEnv('CLAUDE_MODEL', 'us.anthropic.claude-opus-4-6-v1:0');
      vi.stubEnv('CLAUDE_CODE_BEDROCK_SONNET_MODEL', 'us.anthropic.claude-sonnet-4-6-v1:0');
      vi.stubEnv('OMC_MODEL_MEDIUM', 'us.anthropic.claude-sonnet-4-5-20250929-v1:0');
      expect(resolveClaudeWorkerModel()).toBeUndefined();
      vi.unstubAllEnvs();
    });

    it('returns undefined when OMC_ROUTING_FORCE_INHERIT=true on Vertex', () => {
      vi.stubEnv('OMC_ROUTING_FORCE_INHERIT', 'true');
      vi.stubEnv('CLAUDE_CODE_USE_BEDROCK', '');
      vi.stubEnv('CLAUDE_CODE_USE_VERTEX', '1');
      vi.stubEnv('ANTHROPIC_MODEL', 'vertex_ai/claude-sonnet-4-6@20250514');
      expect(resolveClaudeWorkerModel()).toBeUndefined();
      vi.unstubAllEnvs();
    });

    it('returns undefined when not on Bedrock or Vertex', () => {
      vi.stubEnv('CLAUDE_CODE_USE_BEDROCK', '');
      vi.stubEnv('CLAUDE_CODE_USE_VERTEX', '');
      vi.stubEnv('ANTHROPIC_MODEL', '');
      vi.stubEnv('CLAUDE_MODEL', '');
      expect(resolveClaudeWorkerModel()).toBeUndefined();
      vi.unstubAllEnvs();
    });

    it('returns ANTHROPIC_MODEL on Bedrock when set', () => {
      vi.stubEnv('CLAUDE_CODE_USE_BEDROCK', '1');
      vi.stubEnv('ANTHROPIC_MODEL', 'us.anthropic.claude-sonnet-4-5-20250929-v1:0');
      vi.stubEnv('CLAUDE_MODEL', '');
      expect(resolveClaudeWorkerModel()).toBe('us.anthropic.claude-sonnet-4-5-20250929-v1:0');
      vi.unstubAllEnvs();
    });

    it('returns CLAUDE_MODEL on Bedrock when ANTHROPIC_MODEL is not set', () => {
      vi.stubEnv('CLAUDE_CODE_USE_BEDROCK', '1');
      vi.stubEnv('ANTHROPIC_MODEL', '');
      vi.stubEnv('CLAUDE_MODEL', 'us.anthropic.claude-opus-4-6-v1:0');
      expect(resolveClaudeWorkerModel()).toBe('us.anthropic.claude-opus-4-6-v1:0');
      vi.unstubAllEnvs();
    });

    it('falls back to CLAUDE_CODE_BEDROCK_SONNET_MODEL tier env var', () => {
      vi.stubEnv('CLAUDE_CODE_USE_BEDROCK', '1');
      vi.stubEnv('ANTHROPIC_MODEL', '');
      vi.stubEnv('CLAUDE_MODEL', '');
      vi.stubEnv('CLAUDE_CODE_BEDROCK_SONNET_MODEL', 'us.anthropic.claude-sonnet-4-6-v1:0');
      expect(resolveClaudeWorkerModel()).toBe('us.anthropic.claude-sonnet-4-6-v1:0');
      vi.unstubAllEnvs();
    });

    it('falls back to OMC_MODEL_MEDIUM tier env var', () => {
      vi.stubEnv('CLAUDE_CODE_USE_BEDROCK', '1');
      vi.stubEnv('ANTHROPIC_MODEL', '');
      vi.stubEnv('CLAUDE_MODEL', '');
      vi.stubEnv('CLAUDE_CODE_BEDROCK_SONNET_MODEL', '');
      vi.stubEnv('ANTHROPIC_DEFAULT_SONNET_MODEL', '');
      vi.stubEnv('OMC_MODEL_MEDIUM', 'us.anthropic.claude-sonnet-4-5-20250929-v1:0');
      expect(resolveClaudeWorkerModel()).toBe('us.anthropic.claude-sonnet-4-5-20250929-v1:0');
      vi.unstubAllEnvs();
    });

    it('returns ANTHROPIC_MODEL on Vertex when set', () => {
      vi.stubEnv('CLAUDE_CODE_USE_BEDROCK', '');
      vi.stubEnv('CLAUDE_CODE_USE_VERTEX', '1');
      vi.stubEnv('ANTHROPIC_MODEL', 'vertex_ai/claude-sonnet-4-6@20250514');
      expect(resolveClaudeWorkerModel()).toBe('vertex_ai/claude-sonnet-4-6@20250514');
      vi.unstubAllEnvs();
    });

    it('returns undefined on Bedrock when no model env vars are set', () => {
      vi.stubEnv('CLAUDE_CODE_USE_BEDROCK', '1');
      vi.stubEnv('ANTHROPIC_MODEL', '');
      vi.stubEnv('CLAUDE_MODEL', '');
      vi.stubEnv('CLAUDE_CODE_BEDROCK_SONNET_MODEL', '');
      vi.stubEnv('ANTHROPIC_DEFAULT_SONNET_MODEL', '');
      vi.stubEnv('OMC_MODEL_MEDIUM', '');
      expect(resolveClaudeWorkerModel()).toBeUndefined();
      vi.unstubAllEnvs();
    });

    it('detects Bedrock from model ID pattern even without CLAUDE_CODE_USE_BEDROCK', () => {
      vi.stubEnv('CLAUDE_CODE_USE_BEDROCK', '');
      vi.stubEnv('CLAUDE_CODE_USE_VERTEX', '');
      vi.stubEnv('ANTHROPIC_MODEL', 'us.anthropic.claude-sonnet-4-5-20250929-v1:0');
      vi.stubEnv('CLAUDE_MODEL', '');
      // isBedrock() detects Bedrock from the model ID pattern
      expect(resolveClaudeWorkerModel()).toBe('us.anthropic.claude-sonnet-4-5-20250929-v1:0');
      vi.unstubAllEnvs();
    });
  });
  describe('worker launch descriptors', () => {
    it('captures exact binary model and appended prompt argv', () => {
      const descriptor = buildValidatedWorkerLaunchDescriptor('gemini', {
        teamName: 'team', workerName: 'worker-1', cwd: '/tmp', model: 'gemini-2.5-pro',
        resolvedBinaryPath: '/usr/bin/gemini',
      }, ['-p', 'read inbox']);
      expect(descriptor).toEqual({ schema_version: 1, provider: 'gemini', model: 'gemini-2.5-pro',
        binary: '/usr/bin/gemini', args: ['--approval-mode', 'yolo', '--model', 'gemini-2.5-pro', '-p', 'read inbox'] });
    });

    it.each([
      { schema_version: 2, provider: 'claude', model: null, binary: '/usr/bin/claude', args: [] },
      { schema_version: 1, provider: 'unknown', model: null, binary: '/usr/bin/unknown', args: [] },
      { schema_version: 1, provider: 'claude', binary: '/usr/bin/claude', args: [] },
      { schema_version: 1, provider: 'claude', model: null, binary: 'claude', args: [] },
      { schema_version: 1, provider: 'claude', model: null, binary: '/usr/bin/claude\0x', args: [] },
      { schema_version: 1, provider: 'claude', model: null, binary: '/usr/bin/claude', args: ['ok\0bad'] },
    ])('rejects malformed persisted descriptor %#', value => {
      expect(() => validateWorkerLaunchDescriptor(value)).toThrow();
    });

    it('returns a defensive argv copy', () => {
      const source = { schema_version: 1 as const, provider: 'codex' as const, model: null,
        binary: '/usr/bin/codex', args: ['--flag'] };
      const validated = validateWorkerLaunchDescriptor(source);
      validated.args.push('--changed');
      expect(source.args).toEqual(['--flag']);
    });
  });

});
