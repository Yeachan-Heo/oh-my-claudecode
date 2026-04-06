import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  sanitizeName,
  sessionName,
  createSession,
  killSession,
  shouldAttemptAdaptiveRetry,
  getDefaultShell,
  buildWorkerStartCommand,
} from '../tmux-session.js';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('sanitizeName', () => {
  it('passes alphanumeric names', () => {
    expect(sanitizeName('worker1')).toBe('worker1');
  });

  it('removes invalid characters', () => {
    expect(sanitizeName('worker@1!')).toBe('worker1');
  });

  it('allows hyphens', () => {
    expect(sanitizeName('my-worker')).toBe('my-worker');
  });

  it('truncates to 50 chars', () => {
    const long = 'a'.repeat(100);
    expect(sanitizeName(long).length).toBe(50);
  });

  it('throws for all-invalid names', () => {
    expect(() => sanitizeName('!!!@@@')).toThrow('no valid characters');
  });

  it('rejects 1-char result after sanitization', () => {
    expect(() => sanitizeName('a')).toThrow('too short');
  });

  it('accepts 2-char result after sanitization', () => {
    expect(sanitizeName('ab')).toBe('ab');
  });
});

describe('sessionName', () => {
  it('builds correct session name', () => {
    expect(sessionName('myteam', 'codex1')).toBe('omc-team-myteam-codex1');
  });

  it('sanitizes both parts', () => {
    expect(sessionName('my team!', 'work@er')).toBe('omc-team-myteam-worker');
  });
});

describe('getDefaultShell', () => {
  it('uses COMSPEC on win32', () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    vi.stubEnv('COMSPEC', 'C:\\Windows\\System32\\cmd.exe');
    expect(getDefaultShell()).toBe('C:\\Windows\\System32\\cmd.exe');
  });

  it('uses SHELL on non-win32', () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
    vi.stubEnv('SHELL', '/bin/zsh');
    expect(getDefaultShell()).toBe('/bin/zsh');
  });

  it('uses SHELL instead of COMSPEC on win32 when MSYSTEM is set (MSYS2)', () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    vi.stubEnv('MSYSTEM', 'MINGW64');
    vi.stubEnv('SHELL', '/usr/bin/bash');
    vi.stubEnv('COMSPEC', 'C:\\Windows\\System32\\cmd.exe');
    expect(getDefaultShell()).toBe('/usr/bin/bash');
  });

  it('uses SHELL instead of COMSPEC on win32 when MINGW_PREFIX is set', () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    vi.stubEnv('MINGW_PREFIX', '/mingw64');
    vi.stubEnv('SHELL', '/usr/bin/bash');
    vi.stubEnv('COMSPEC', 'C:\\Windows\\System32\\cmd.exe');
    expect(getDefaultShell()).toBe('/usr/bin/bash');
  });
});

describe('buildWorkerStartCommand', () => {
  it('throws when deprecated launchCmd is used (security: C2)', () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
    vi.stubEnv('SHELL', '/bin/zsh');
    vi.stubEnv('HOME', '/home/tester');

    expect(() => buildWorkerStartCommand({
      teamName: 't',
      workerName: 'w',
      envVars: { A: '1' },
      launchCmd: 'node app.js',
      cwd: '/tmp'
    })).toThrow('launchCmd is deprecated');
  });

  it('throws when neither launchBinary nor launchCmd is provided', () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
    vi.stubEnv('SHELL', '/bin/zsh');

    expect(() => buildWorkerStartCommand({
      teamName: 't',
      workerName: 'w',
      envVars: {},
      cwd: '/tmp'
    })).toThrow('Missing worker launch command');
  });

  it('accepts absolute Windows launchBinary paths with spaces', () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    vi.stubEnv('COMSPEC', 'C:\\Windows\\System32\\cmd.exe');

    expect(() => buildWorkerStartCommand({
      teamName: 't',
      workerName: 'w',
      envVars: { OMC_TEAM_WORKER: 't/w' },
      launchBinary: 'C:\\Program Files\\OpenAI\\Codex\\codex.exe',
      launchArgs: ['--full-auto'],
      cwd: 'C:\\repo'
    })).not.toThrow();
  });

  it('uses exec \"$@\" for launchBinary with non-fish shells', () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
    vi.stubEnv('SHELL', '/bin/zsh');
    vi.stubEnv('HOME', '/home/tester');

    const cmd = buildWorkerStartCommand({
      teamName: 't',
      workerName: 'w',
      envVars: { OMC_TEAM_WORKER: 't/w' },
      launchBinary: 'codex',
      launchArgs: ['--full-auto'],
      cwd: '/tmp'
    });

    expect(cmd).toContain("exec \"$@\"");
    expect(cmd).toContain("'--' 'codex' '--full-auto'");
  });

  it('uses exec $argv for launchBinary with fish shell', () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
    vi.stubEnv('SHELL', '/usr/bin/fish');
    vi.stubEnv('HOME', '/home/tester');

    const cmd = buildWorkerStartCommand({
      teamName: 't',
      workerName: 'w',
      envVars: { OMC_TEAM_WORKER: 't/w' },
      launchBinary: 'codex',
      launchArgs: ['--full-auto'],
      cwd: '/tmp'
    });

    expect(cmd).toContain('exec $argv');
    expect(cmd).not.toContain('exec "$@"');
    expect(cmd).toContain("'--' 'codex' '--full-auto'");
    // Fish uses separate -l -c flags (not combined -lc)
    expect(cmd).toContain("'-l' '-c'");
    expect(cmd).not.toContain("'-lc'");
    // Fish sources ~/.config/fish/config.fish, not ~/.fishrc
    expect(cmd).toContain('.config/fish/config.fish');
    expect(cmd).not.toContain('.fishrc');
    // Fish uses test/and syntax, not [ ] && .
    expect(cmd).toContain('test -f');
    expect(cmd).toContain('; and source');
  });

  it('does not double-escape env vars in launchBinary mode (issue #1415)', () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
    vi.stubEnv('SHELL', '/bin/zsh');
    vi.stubEnv('HOME', '/home/tester');

    const cmd = buildWorkerStartCommand({
      teamName: 't',
      workerName: 'w',
      envVars: {
        ANTHROPIC_MODEL: 'us.anthropic.claude-sonnet-4-6-v1[1m]',
        CLAUDE_CODE_USE_BEDROCK: '1',
      },
      launchBinary: '/usr/local/bin/claude',
      launchArgs: ['--dangerously-skip-permissions'],
      cwd: '/tmp'
    });

    // env assignments must appear WITHOUT extra wrapping quotes.
    // Correct:   ANTHROPIC_MODEL='us.anthropic.claude-sonnet-4-6-v1[1m]'
    // Wrong:     'ANTHROPIC_MODEL='"'"'us.anthropic...'"'"''  (double-escaped)
    expect(cmd).toContain("ANTHROPIC_MODEL='us.anthropic.claude-sonnet-4-6-v1[1m]'");
    expect(cmd).toContain("CLAUDE_CODE_USE_BEDROCK='1'");

    // The env keyword and other args should still be shell-escaped
    expect(cmd).toMatch(/^'env'/);
    expect(cmd).toContain("'/usr/local/bin/claude'");
    expect(cmd).toContain("'--dangerously-skip-permissions'");
  });

  it('env vars with special characters survive single escaping correctly', () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
    vi.stubEnv('SHELL', '/bin/bash');
    vi.stubEnv('HOME', '/home/tester');

    const cmd = buildWorkerStartCommand({
      teamName: 't',
      workerName: 'w',
      envVars: {
        OMC_TEAM_WORKER: 'my-team/worker-1',
        ANTHROPIC_DEFAULT_SONNET_MODEL: 'global.anthropic.claude-sonnet-4-6[1m]',
      },
      launchBinary: '/usr/local/bin/claude',
      launchArgs: [],
      cwd: '/tmp'
    });

    // Values with / and [] must be preserved without extra quoting
    expect(cmd).toContain("OMC_TEAM_WORKER='my-team/worker-1'");
    expect(cmd).toContain("ANTHROPIC_DEFAULT_SONNET_MODEL='global.anthropic.claude-sonnet-4-6[1m]'");
  });

  it('rejects relative launchBinary containing spaces', () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');

    expect(() => buildWorkerStartCommand({
      teamName: 't',
      workerName: 'w',
      envVars: {},
      launchBinary: 'Program Files/codex',
      cwd: '/tmp'
    })).toThrow('Invalid launchBinary: paths with spaces must be absolute');
  });

  it('rejects dangerous shell metacharacters in launchBinary', () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');

    expect(() => buildWorkerStartCommand({
      teamName: 't',
      workerName: 'w',
      envVars: {},
      launchBinary: '/usr/bin/codex;touch /tmp/pwn',
      cwd: '/tmp'
    })).toThrow('Invalid launchBinary: contains dangerous shell metacharacters');
  });
});

describe('shouldAttemptAdaptiveRetry', () => {
  it('only enables adaptive retry for busy panes with visible unsent message', () => {
    delete process.env.OMC_TEAM_AUTO_INTERRUPT_RETRY;
    expect(shouldAttemptAdaptiveRetry({
      paneBusy: false,
      latestCapture: '❯ check-inbox',
      message: 'check-inbox',
      paneInCopyMode: false,
      retriesAttempted: 0,
    })).toBe(false);
    expect(shouldAttemptAdaptiveRetry({
      paneBusy: true,
      latestCapture: '❯ ready prompt',
      message: 'check-inbox',
      paneInCopyMode: false,
      retriesAttempted: 0,
    })).toBe(false);
    expect(shouldAttemptAdaptiveRetry({
      paneBusy: true,
      latestCapture: '❯ check-inbox',
      message: 'check-inbox',
      paneInCopyMode: true,
      retriesAttempted: 0,
    })).toBe(false);
    expect(shouldAttemptAdaptiveRetry({
      paneBusy: true,
      latestCapture: '❯ check-inbox',
      message: 'check-inbox',
      paneInCopyMode: false,
      retriesAttempted: 1,
    })).toBe(false);
    expect(shouldAttemptAdaptiveRetry({
      paneBusy: true,
      latestCapture: '❯ check-inbox\ngpt-5.3-codex high · 80% left',
      message: 'check-inbox',
      paneInCopyMode: false,
      retriesAttempted: 0,
    })).toBe(true);
  });

  it('respects OMC_TEAM_AUTO_INTERRUPT_RETRY=0', () => {
    process.env.OMC_TEAM_AUTO_INTERRUPT_RETRY = '0';
    expect(shouldAttemptAdaptiveRetry({
      paneBusy: true,
      latestCapture: '❯ check-inbox',
      message: 'check-inbox',
      paneInCopyMode: false,
      retriesAttempted: 0,
    })).toBe(false);
    delete process.env.OMC_TEAM_AUTO_INTERRUPT_RETRY;
  });
});

describe('sendToWorker implementation guards', () => {
  const source = readFileSync(join(__dirname, '..', 'tmux-session.ts'), 'utf-8');

  it('uses a longer default readiness timeout for worker startup', () => {
    expect(source).toContain('OMC_SHELL_READY_TIMEOUT_MS');
    expect(source).toContain('30_000');
  });

  it('checks and exits tmux copy-mode before injection', () => {
    expect(source).toContain('#{pane_in_mode}');
    expect(source).toContain('skip injection entirely');
  });

  it('supports env-gated adaptive interrupt retry', () => {
    expect(source).toContain('OMC_TEAM_AUTO_INTERRUPT_RETRY');
    expect(source).toContain("await sendKey('C-u')");
  });

  it('re-checks copy-mode before adaptive and final fallback keys', () => {
    expect(source).toContain('Safety gate: copy-mode can turn on while we retry');
    expect(source).toContain('Before fallback control keys, re-check copy-mode');
    expect(source).toContain('Fail-closed: one final submit attempt');
  });
});

// NOTE: createSession, killSession require tmux to be installed.
// Gate with: describe.skipIf(!hasTmux)('tmux integration', () => { ... })

function hasTmux(): boolean {
  try {
    const { execSync } = require('child_process');
    execSync('tmux -V', { stdio: 'pipe', timeout: 3000 });
    return true;
  } catch { return false; }
}

describe.skipIf(!hasTmux())('createSession with workingDirectory', () => {

  it('accepts optional workingDirectory param', () => {
    // Should not throw — workingDirectory is optional
    const name = createSession('tmuxtest', 'wdtest', '/tmp');
    expect(name).toBe('omc-team-tmuxtest-wdtest');
    killSession('tmuxtest', 'wdtest');
  });

  it('works without workingDirectory param', () => {
    const name = createSession('tmuxtest', 'nowd');
    expect(name).toBe('omc-team-tmuxtest-nowd');
    killSession('tmuxtest', 'nowd');
  });
});
