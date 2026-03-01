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
  isUnixLikeOnWindows,
  shouldLoadShellRc,
  validateCliBinaryPath,
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
  it('builds a POSIX startup command with rc sourcing', () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
    vi.stubEnv('SHELL', '/bin/zsh');
    vi.stubEnv('HOME', '/home/tester');

    const cmd = buildWorkerStartCommand({
      teamName: 't',
      workerName: 'w',
      envVars: { A: '1' },
      launchCmd: 'node app.js',
      cwd: '/tmp'
    });

    expect(cmd).toContain("env A='1' /bin/zsh -c");
    expect(cmd).toContain('[ -f "/home/tester/.zshrc" ] && source "/home/tester/.zshrc";');
  });

  it('builds a Windows startup command without POSIX constructs', () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    vi.stubEnv('COMSPEC', 'C:\\Windows\\System32\\cmd.exe');

    const cmd = buildWorkerStartCommand({
      teamName: 't',
      workerName: 'w',
      envVars: { A: '1' },
      launchCmd: 'node app.js',
      cwd: 'C:\\repo'
    });

    expect(cmd).toContain('C:\\Windows\\System32\\cmd.exe /d /s /c');
    expect(cmd).toContain(' /c "set "A=1" && node app.js"');
    expect(cmd).not.toContain('env ');
    expect(cmd).not.toContain('[ -f ');
    expect(cmd).not.toContain('source ');
  });

  it('builds a POSIX command on win32 when MSYSTEM is set (MSYS2)', () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    vi.stubEnv('MSYSTEM', 'MINGW64');
    vi.stubEnv('SHELL', '/usr/bin/bash');
    vi.stubEnv('HOME', '/home/tester');

    const cmd = buildWorkerStartCommand({
      teamName: 't',
      workerName: 'w',
      envVars: { A: '1' },
      launchCmd: 'node app.js',
      cwd: '/c/repo'
    });

    expect(cmd).toContain("env A='1' /usr/bin/bash -c");
    expect(cmd).not.toContain('cmd.exe');
    expect(cmd).not.toContain('/d /s /c');
  });

  it('uses basename-style shell name extraction for windows-style shell path', () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
    vi.stubEnv('SHELL', 'C:\\Program Files\\Git\\bin\\bash.exe');
    vi.stubEnv('HOME', '/home/tester');

    const cmd = buildWorkerStartCommand({
      teamName: 't',
      workerName: 'w',
      envVars: {},
      launchCmd: 'node app.js',
      cwd: '/tmp'
    });

    expect(cmd).toContain('/home/tester/.bashrc');
  });
});

describe('shouldLoadShellRc', () => {
  it('returns true by default (rc loading enabled)', () => {
    delete process.env.OMC_TEAM_NO_RC;
    expect(shouldLoadShellRc()).toBe(true);
  });

  it('returns false when OMC_TEAM_NO_RC=1', () => {
    vi.stubEnv('OMC_TEAM_NO_RC', '1');
    expect(shouldLoadShellRc()).toBe(false);
  });

  it('returns false when OMC_TEAM_NO_RC=true', () => {
    vi.stubEnv('OMC_TEAM_NO_RC', 'true');
    expect(shouldLoadShellRc()).toBe(false);
  });

  it('returns true for other OMC_TEAM_NO_RC values', () => {
    vi.stubEnv('OMC_TEAM_NO_RC', '0');
    expect(shouldLoadShellRc()).toBe(true);
    vi.stubEnv('OMC_TEAM_NO_RC', 'false');
    expect(shouldLoadShellRc()).toBe(true);
    vi.stubEnv('OMC_TEAM_NO_RC', 'yes');
    expect(shouldLoadShellRc()).toBe(true);
  });
});

describe('validateCliBinaryPath', () => {
  it('skips validation for unknown binaries', () => {
    const result = validateCliBinaryPath('unknown-tool');
    expect(result.isValid).toBe(true);
    expect(result.warnings).toHaveLength(0);
  });

  it('validates known CLI binaries (node should be available in test env)', () => {
    const result = validateCliBinaryPath('node');
    expect(result.isValid).toBe(true);
    expect(result.resolvedPath).toBeTruthy();
    expect(result.warnings).toHaveLength(0);
  });

  it('warns when binary is not found in PATH', () => {
    const result = validateCliBinaryPath('gemini');
    // gemini is unlikely to be installed in test env
    if (!result.resolvedPath) {
      expect(result.warnings).toContain("CLI binary 'gemini' not found in PATH");
    }
  });

  it('returns binary name in result', () => {
    const result = validateCliBinaryPath('node');
    expect(result.binary).toBe('node');
  });
});

describe('buildWorkerStartCommand with OMC_TEAM_NO_RC', () => {
  it('skips rc sourcing when OMC_TEAM_NO_RC=1 (launchCmd path)', () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
    vi.stubEnv('SHELL', '/bin/zsh');
    vi.stubEnv('HOME', '/home/tester');
    vi.stubEnv('OMC_TEAM_NO_RC', '1');

    const cmd = buildWorkerStartCommand({
      teamName: 'tt',
      workerName: 'ww',
      envVars: { A: '1' },
      launchCmd: 'node app.js',
      cwd: '/tmp'
    });

    expect(cmd).not.toContain('.zshrc');
    expect(cmd).not.toContain('source');
  });

  it('skips rc sourcing when OMC_TEAM_NO_RC=1 (launchBinary path)', () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
    vi.stubEnv('SHELL', '/bin/bash');
    vi.stubEnv('HOME', '/home/tester');
    vi.stubEnv('OMC_TEAM_NO_RC', '1');

    const cmd = buildWorkerStartCommand({
      teamName: 'tt',
      workerName: 'ww',
      envVars: { A: '1' },
      launchBinary: 'codex',
      launchArgs: ['--full-auto'],
      cwd: '/tmp'
    });

    expect(cmd).not.toContain('.bashrc');
    expect(cmd).toContain('exec "$@"');
  });

  it('includes binary resolution logging in launchBinary path', () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
    vi.stubEnv('SHELL', '/bin/bash');
    vi.stubEnv('HOME', '/home/tester');
    delete process.env.OMC_TEAM_NO_RC;

    const cmd = buildWorkerStartCommand({
      teamName: 'tt',
      workerName: 'ww',
      envVars: {},
      launchBinary: 'claude',
      cwd: '/tmp'
    });

    expect(cmd).toContain('command -v');
    expect(cmd).toContain('[omc-team]');
  });

  it('still sources rc when OMC_TEAM_NO_RC is not set', () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
    vi.stubEnv('SHELL', '/bin/zsh');
    vi.stubEnv('HOME', '/home/tester');
    delete process.env.OMC_TEAM_NO_RC;

    const cmd = buildWorkerStartCommand({
      teamName: 'tt',
      workerName: 'ww',
      envVars: { A: '1' },
      launchCmd: 'node app.js',
      cwd: '/tmp'
    });

    expect(cmd).toContain('.zshrc');
  });
});

describe('trust boundary source guards', () => {
  const source = readFileSync(join(__dirname, '..', 'tmux-session.ts'), 'utf-8');

  it('documents trust model in shouldLoadShellRc', () => {
    expect(source).toContain('Trust boundary: shell rc loading in worker contexts');
    expect(source).toContain('OMC_TEAM_NO_RC');
  });

  it('validates CLI binary path before spawning', () => {
    expect(source).toContain('Trust boundary: validate CLI binary path before spawning');
    expect(source).toContain('validateCliBinaryPath');
  });

  it('logs resolved binary path in generated shell script', () => {
    expect(source).toContain('command -v "$1"');
    expect(source).toContain('trust boundary audit trail');
  });

  it('checks for suspicious path prefixes', () => {
    expect(source).toContain('/tmp/');
    expect(source).toContain('/var/tmp/');
    expect(source).toContain('SUSPICIOUS_PATH_PREFIXES');
  });
});

describe('shouldAttemptAdaptiveRetry', () => {
  it('only enables adaptive retry for busy panes with visible unsent message', () => {
    delete process.env.OMX_TEAM_AUTO_INTERRUPT_RETRY;
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

  it('respects OMX_TEAM_AUTO_INTERRUPT_RETRY=0', () => {
    process.env.OMX_TEAM_AUTO_INTERRUPT_RETRY = '0';
    expect(shouldAttemptAdaptiveRetry({
      paneBusy: true,
      latestCapture: '❯ check-inbox',
      message: 'check-inbox',
      paneInCopyMode: false,
      retriesAttempted: 0,
    })).toBe(false);
    delete process.env.OMX_TEAM_AUTO_INTERRUPT_RETRY;
  });
});

describe('sendToWorker implementation guards', () => {
  const source = readFileSync(join(__dirname, '..', 'tmux-session.ts'), 'utf-8');

  it('checks and exits tmux copy-mode before injection', () => {
    expect(source).toContain('#{pane_in_mode}');
    expect(source).toContain('skip injection entirely');
  });

  it('supports env-gated adaptive interrupt retry', () => {
    expect(source).toContain('OMX_TEAM_AUTO_INTERRUPT_RETRY');
    expect(source).toContain("await sendKey('C-u')");
  });

  it('re-checks copy-mode before adaptive and fail-open fallback keys', () => {
    expect(source).toContain('Safety gate: copy-mode can turn on while we retry');
    expect(source).toContain('Before fallback control keys, re-check copy-mode');
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
