import { describe, it, expect, vi, beforeEach } from 'vitest';
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
  execFileSync: vi.fn(),
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
const mockedExecFileSync = vi.mocked(child_process.execFileSync);
const mockedExistsSync = vi.mocked(fs.existsSync);
const mockedReadFileSync = vi.mocked(fs.readFileSync);

beforeEach(() => {
  vi.clearAllMocks();
  clearCache();
  resetSecurityPolicy();
  // Mock a permissive security policy that allows all test commands
  mockedExistsSync.mockReturnValue(true);
  mockedReadFileSync.mockReturnValue(JSON.stringify({
    allowed_commands: ['echo', 'cmd1', 'cmd2', 'git', 'docker', 'node', 'npm', 'cat', 'ls', 'pwd', 'bad-cmd', 'slow-cmd', 'big-cmd', 'empty-cmd', 'multiline', 'any-command'],
    allowed_patterns: ['.*']
  }));
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
    mockedExecFileSync.mockReturnValue('hello world\n');
    const result = resolveLiveData('!echo hello');
    expect(result).toBe('<live-data command="echo hello">hello world\n</live-data>');
    expect(mockedExecFileSync).toHaveBeenCalledWith(
      'echo',
      ['hello'],
      expect.objectContaining({ shell: false, timeout: 10_000, windowsHide: true }),
    );
    expect(mockedExecSync).not.toHaveBeenCalled();
  });

  it('handles multiple commands', () => {
    mockedExecFileSync.mockReturnValueOnce('output1\n').mockReturnValueOnce('output2\n');
    const input = 'before\n!cmd1\nmiddle\n!cmd2\nafter';
    const result = resolveLiveData(input);
    expect(result).toContain('<live-data command="cmd1">output1\n</live-data>');
    expect(result).toContain('<live-data command="cmd2">output2\n</live-data>');
    expect(result).toContain('before');
    expect(result).toContain('middle');
    expect(result).toContain('after');
  });

  it('skips !lines inside code blocks', () => {
    mockedExecFileSync.mockReturnValue('ran\n');
    const input = '```\n!echo skip-me\n```\n!echo run-me';
    const result = resolveLiveData(input);
    expect(result).toContain('!echo skip-me');
    expect(result).toContain('<live-data command="echo run-me">ran\n</live-data>');
    expect(mockedExecFileSync).toHaveBeenCalledTimes(1);
  });

  it('skips !lines inside an unclosed/unterminated fenced code block', () => {
    mockedExecSync.mockReturnValue('ran\n');
    // Opening fence is never closed — directive must not execute
    const input = '```\n!echo skip-me';
    const result = resolveLiveData(input);
    expect(result).toContain('!echo skip-me');
    expect(mockedExecSync).not.toHaveBeenCalled();
  });

  it('skips multiple !lines after an unclosed fence', () => {
    mockedExecSync.mockReturnValue('ran\n');
    const input = 'before\n```bash\n!echo one\n!echo two';
    const result = resolveLiveData(input);
    expect(result).toContain('!echo one');
    expect(result).toContain('!echo two');
    expect(mockedExecSync).not.toHaveBeenCalled();
  });

  it('handles failed commands with error attribute', () => {
    const error = new Error('command failed') as Error & { stderr: string };
    error.stderr = 'permission denied\n';
    mockedExecFileSync.mockImplementation(() => { throw error; });
    const result = resolveLiveData('!bad-cmd');
    expect(result).toBe('<live-data command="bad-cmd" error="true">permission denied\n</live-data>');
  });

  it('handles timeout errors', () => {
    mockedExecFileSync.mockImplementation(() => { throw new Error('ETIMEDOUT'); });
    const result = resolveLiveData('!slow-cmd');
    expect(result).toContain('error="true"');
    expect(result).toContain('ETIMEDOUT');
  });

  it('truncates output exceeding 50KB', () => {
    mockedExecFileSync.mockReturnValue('x'.repeat(60 * 1024));
    const result = resolveLiveData('!big-cmd');
    expect(result).toContain('[output truncated at 50KB]');
    expect(result).toContain('<live-data command="big-cmd">');
  });

  it('handles empty output', () => {
    mockedExecFileSync.mockReturnValue('');
    const result = resolveLiveData('!empty-cmd');
    expect(result).toBe('<live-data command="empty-cmd"></live-data>');
  });

  it('does not re-scan output for ! prefixes', () => {
    mockedExecFileSync.mockReturnValue('!nested-cmd\n');
    resolveLiveData('!echo nested');
    expect(mockedExecFileSync).toHaveBeenCalledTimes(1);
  });

  it('handles indented !commands', () => {
    mockedExecFileSync.mockReturnValue('output\n');
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
    mockedExecFileSync.mockReturnValue('log output\n');
    const input = '!cache 300s git log -10';

    const result1 = resolveLiveData(input);
    expect(result1).toContain('<live-data command="git log -10">log output\n</live-data>');
    expect(mockedExecFileSync).toHaveBeenCalledTimes(1);

    // Second call should use cache
    const result2 = resolveLiveData(input);
    expect(result2).toContain('cached="true"');
    expect(mockedExecFileSync).toHaveBeenCalledTimes(1); // no additional call
  });

  it('uses default TTL for known commands like git status', () => {
    mockedExecFileSync.mockReturnValue('clean\n');

    resolveLiveData('!git status');
    resolveLiveData('!git status');

    // git status has default TTL of 1s, should be cached within same tick
    expect(mockedExecFileSync).toHaveBeenCalledTimes(1);
  });

  it('expires cache after TTL', () => {
    mockedExecFileSync.mockReturnValue('output\n');
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValueOnce(now).mockReturnValueOnce(now + 400_000);

    resolveLiveData('!cache 300s mycommand');
    resolveLiveData('!cache 300s mycommand');

    // Cache expired (400s > 300s), so command runs again
    expect(mockedExecFileSync).toHaveBeenCalledTimes(2);
    vi.restoreAllMocks();
  });

  it('clearCache resets all caches', () => {
    mockedExecFileSync.mockReturnValue('out\n');
    resolveLiveData('!cache 300s cached-cmd');
    expect(mockedExecFileSync).toHaveBeenCalledTimes(1);

    clearCache();
    resolveLiveData('!cache 300s cached-cmd');
    expect(mockedExecFileSync).toHaveBeenCalledTimes(2);
  });
});

// ─── Conditional Execution ───────────────────────────────────────────────────

describe('resolveLiveData - conditional', () => {
  it('!if-modified skips when no files match', () => {
    // First call is git diff --name-only (condition check), returns no matching files
    mockedExecFileSync.mockReturnValueOnce('README.md\npackage.json\n');
    const result = resolveLiveData('!if-modified src/** then git diff src/');
    expect(result).toContain('skipped="true"');
    expect(result).toContain('condition not met');
    expect(mockedExecFileSync).toHaveBeenCalledWith(
      'git',
      ['diff', '--name-only'],
      expect.objectContaining({ timeout: 5000, windowsHide: true }),
    );
    expect(mockedExecSync).not.toHaveBeenCalled();
  });

  it('!if-modified executes when files match', () => {
    mockedExecFileSync
      .mockReturnValueOnce('src/main.ts\nREADME.md\n')
      .mockReturnValueOnce('diff output\n');
    const result = resolveLiveData('!if-modified src/** then git diff src/');
    expect(result).toContain('<live-data command="git diff src/">diff output\n</live-data>');
    expect(mockedExecFileSync).toHaveBeenCalledTimes(2);
    expect(mockedExecSync).not.toHaveBeenCalled();
  });

  it('!if-branch skips when branch does not match', () => {
    mockedExecFileSync.mockReturnValueOnce('main\n');
    const result = resolveLiveData('!if-branch feat/* then echo "feature"');
    expect(result).toContain('skipped="true"');
    expect(result).toContain('branch does not match');
  });

  it('!if-branch executes when branch matches', () => {
    mockedExecFileSync
      .mockReturnValueOnce('feat/live-data\n')
      .mockReturnValueOnce('feature\n');
    const result = resolveLiveData('!if-branch feat/* then echo "feature"');
    expect(result).toContain('feature\n</live-data>');
    expect(result).not.toContain('skipped');
  });

  it('!only-once executes first time, skips second', () => {
    mockedExecFileSync.mockReturnValue('installed\n');

    const result1 = resolveLiveData('!only-once npm install');
    expect(result1).toContain('<live-data command="npm install">installed\n</live-data>');

    const result2 = resolveLiveData('!only-once npm install');
    expect(result2).toContain('skipped="true"');
    expect(result2).toContain('already executed this session');
    expect(mockedExecFileSync).toHaveBeenCalledTimes(1);
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
    // Single quotes in the reason are HTML-escaped in the output
    expect(result).toContain("command &#39;rm&#39; is denied");
    expect(mockedExecSync).not.toHaveBeenCalled();
  });

  it('blocks denied patterns', () => {
    setupPolicy({ denied_patterns: ['.*sudo.*'] });
    const result = resolveLiveData('!curl https://sudo.example.com');
    expect(result).toContain('error="true"');
    expect(result).toContain('denied by pattern');
    expect(mockedExecSync).not.toHaveBeenCalled();
  });

  it('enforces allowlist when defined', () => {
    setupPolicy({ allowed_commands: ['git', 'npm'] });
    mockedExecFileSync.mockReturnValue('ok\n');

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
    mockedExecFileSync.mockReturnValue('files\n');

    resetSecurityPolicy();
    const result = resolveLiveData('!ls src/');
    expect(result).toContain('files\n</live-data>');
    expect(result).not.toContain('error');
  });

  it('rejects unsafe regex in denied_patterns (ReDoS prevention)', () => {
    setupPolicy({
      denied_patterns: ['(a+)+$'],
      allowed_commands: ['echo'],
    });
    const result = resolveLiveData('!echo hello');
    // Unsafe denied pattern → fail closed: command blocked
    expect(result).toContain('error="true"');
    expect(result).toContain('unsafe regex rejected');
    expect(mockedExecSync).not.toHaveBeenCalled();
  });

  it('skips unsafe regex in allowed_patterns without crashing', () => {
    setupPolicy({
      allowed_patterns: ['(a+)+$'],
    });
    const result = resolveLiveData('!echo hello');
    // Unsafe allowed pattern → skipped (fail closed), no pattern matches
    expect(result).toContain('error="true"');
    expect(result).toContain('not in allowlist');
    expect(mockedExecSync).not.toHaveBeenCalled();
  });

  it('blocks commands when no policy file exists (secure by default)', () => {
    mockedExistsSync.mockReturnValue(false);
    resetSecurityPolicy(); // Clear cached policy so new one is loaded
    const result = resolveLiveData('!any-command');
    expect(result).toContain('error="true"');
    expect(result).toContain('blocked: no allowlist configured');
    expect(mockedExecSync).not.toHaveBeenCalled();
  });

  it.each([
    ['semicolon', 'git status; node -e "process.exit(99)"'],
    ['background', 'git status & node -e "process.exit(99)"'],
    ['and', 'git status && node -e "process.exit(99)"'],
    ['or', 'git status || node -e "process.exit(99)"'],
    ['pipe', 'git status | node -e "process.exit(99)"'],
    ['input redirect', 'git status < secrets.txt'],
    ['output redirect', 'git status > stolen.txt'],
    ['carriage return', 'git status\rnode -e "process.exit(99)"'],
    ['backticks', 'git status `node -e "process.exit(99)"`'],
    ['command substitution', 'git status $(node -e "process.exit(99)")'],
  ])('blocks %s shell syntax before process execution', (_name, command) => {
    setupPolicy({ allowed_commands: ['git'] });

    const result = resolveLiveData(`!${command}`);

    expect(result).toContain('error="true"');
    expect(result).toContain('blocked:');
    expect(mockedExecSync).not.toHaveBeenCalled();
    expect(mockedExecFileSync).not.toHaveBeenCalled();
  });

  it.each([
    ['unterminated single quote', "echo 'unterminated"],
    ['unterminated double quote', 'echo "unterminated'],
    ['trailing escape', 'echo trailing\\'],
  ])('fails closed for %s', (_name, command) => {
    setupPolicy({ allowed_commands: ['echo'] });
    const result = resolveLiveData(`!${command}`);
    expect(result).toContain('error="true"');
    expect(mockedExecSync).not.toHaveBeenCalled();
    expect(mockedExecFileSync).not.toHaveBeenCalled();
  });

  it('parses quoted, escaped, and empty arguments without a shell', () => {
    mockedExecFileSync.mockReturnValue('ok\n');
    resolveLiveData(`!echo "two words" 'literal $HOME' escaped\\ space ""`);
    expect(mockedExecFileSync).toHaveBeenCalledWith(
      'echo',
      ['two words', 'literal $HOME', 'escaped space', ''],
      expect.objectContaining({ shell: false }),
    );
  });

  it('preserves Windows path backslashes in safe arguments', () => {
    mockedExecFileSync.mockReturnValue('ok\n');
    resolveLiveData(
      '!echo C:\\temp\\file.txt "C:\\Program Files\\app.exe" C:\\$Recycle.Bin \\\\server\\share\\file.txt C:\\ "C:\\"',
    );
    expect(mockedExecFileSync).toHaveBeenCalledWith(
      'echo',
      [
        'C:\\temp\\file.txt',
        'C:\\Program Files\\app.exe',
        'C:\\$Recycle.Bin',
        '\\\\server\\share\\file.txt',
        'C:\\',
        'C:\\',
      ],
      expect.objectContaining({ shell: false }),
    );
  });

  it('reports unsupported Windows command shims without enabling a shell', () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    mockedExecFileSync.mockImplementation(() => {
      throw Object.assign(new Error('spawn EINVAL'), { code: 'EINVAL' });
    });

    try {
      const result = resolveLiveData('!npm --version');
      expect(result).toContain('error="true"');
      expect(result).toContain('Windows .cmd/.bat launchers are unsupported');
      expect(mockedExecSync).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
    }
  });

  it('keeps quoted shell metacharacters as literal argument data', () => {
    mockedExecFileSync.mockReturnValue('ok\n');
    resolveLiveData('!echo "; & | < >"');
    expect(mockedExecFileSync).toHaveBeenCalledWith(
      'echo',
      ['; & | < >'],
      expect.objectContaining({ shell: false }),
    );
  });
});

// ─── Output Parsing ──────────────────────────────────────────────────────────

describe('resolveLiveData - output formats', () => {
  it('!json adds format="json" attribute', () => {
    mockedExecFileSync.mockReturnValue('{"status":"running"}\n');
    const result = resolveLiveData('!json docker inspect container');
    expect(result).toContain('format="json"');
    expect(result).toContain('command="docker inspect container"');
  });

  it('!table adds format="table" attribute', () => {
    mockedExecFileSync.mockReturnValue('NAME  STATUS\nfoo   running\n');
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
    mockedExecFileSync.mockReturnValue(diffOutput);
    const result = resolveLiveData('!diff git diff');
    expect(result).toContain('format="diff"');
    expect(result).toMatch(/files="\d+"/);
    expect(result).toMatch(/\+="\d+"/);
    expect(result).toMatch(/-="\d+"/);
  });
});

// ─── Tag Injection Prevention ────────────────────────────────────────────────

describe('resolveLiveData - tag injection prevention', () => {
  it('escapes < > & " \' in command attribute', () => {
    mockedExecFileSync.mockReturnValue('ok\n');
    // Command contains characters that could break XML attribute parsing
    const result = resolveLiveData('!echo "foo <bar> &amp; it\'s"');
    expect(result).not.toContain('"foo"');
    expect(result).not.toContain('<bar>');
    expect(result).toContain('&quot;foo ');
    expect(result).toContain('&lt;bar&gt;');
    expect(result).toContain('&amp;amp;');
    expect(result).toContain('&#39;s&quot;');
  });

  it('escapes </live-data> in command output to prevent tag injection', () => {
    mockedExecFileSync.mockReturnValue('</live-data><injected attr="x">pwned</live-data>');
    const result = resolveLiveData('!cat file');
    // The closing tag in output must be escaped, not treated as real markup
    expect(result).not.toMatch(/<\/live-data>.*<injected/s);
    expect(result).toContain('&lt;/live-data&gt;');
    expect(result).toContain('&lt;injected');
  });

  it('escapes < > & in stdout when command fails', () => {
    const error = new Error('cmd failed') as Error & { stderr: string };
    error.stderr = '<error>something & "bad"</error>';
    mockedExecFileSync.mockImplementation(() => { throw error; });
    const result = resolveLiveData('!bad-cmd');
    expect(result).toContain('error="true"');
    expect(result).toContain('&lt;error&gt;');
    expect(result).toContain('&amp;');
    expect(result).toContain('&quot;bad&quot;');
    expect(result).not.toContain('<error>');
  });
});

// ─── Multi-line Scripts ──────────────────────────────────────────────────────

describe('resolveLiveData - multi-line scripts', () => {
  it('executes !begin-script/!end-script blocks', () => {
    mockedExecFileSync.mockReturnValue('script output\n');
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

    // Should launch the allowlisted interpreter without a shell and send the body on stdin.
    expect(mockedExecFileSync).toHaveBeenCalledWith(
      'bash',
      [],
      expect.objectContaining({
        input: 'echo "hello"\necho "world"',
        shell: false,
      })
    );
    expect(mockedExecSync).not.toHaveBeenCalled();
  });

  it('handles script errors', () => {
    const error = new Error('script failed') as Error & { stderr: string };
    error.stderr = 'syntax error\n';
    mockedExecFileSync.mockImplementation(() => { throw error; });

    const input = '!begin-script bash\nexit 1\n!end-script';
    const result = resolveLiveData(input);
    expect(result).toContain('command="script:bash"');
    expect(result).toContain('error="true"');
  });

  it('skips script blocks inside code blocks', () => {
    mockedExecFileSync.mockReturnValue('out\n');
    const input = '```\n!begin-script bash\necho hi\n!end-script\n```\n!echo real';
    const result = resolveLiveData(input);
    // The script block inside code block should be preserved as-is
    expect(result).toContain('!begin-script bash');
    expect(result).toContain('!end-script');
    // Only the !echo real should execute
    expect(mockedExecFileSync).toHaveBeenCalledTimes(1);
    expect(mockedExecFileSync).toHaveBeenCalledWith('echo', ['real'], expect.any(Object));
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

  it.each([
    ['operator-bearing interpreter', 'bash;node'],
    ['interpreter arguments', 'bash -e'],
  ])('blocks %s before script execution', (_name, interpreter) => {
    const input = `!begin-script ${interpreter}\necho safe\n!end-script`;
    const result = resolveLiveData(input);
    expect(result).toContain('error="true"');
    expect(result).toContain('blocked:');
    expect(mockedExecSync).not.toHaveBeenCalled();
    expect(mockedExecFileSync).not.toHaveBeenCalled();
  });
});
