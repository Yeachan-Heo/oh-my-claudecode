import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  sanitizeName,
  sessionName,
  shouldAttemptAdaptiveRetry,
  getDefaultShell,
  buildWorkerStartCommand,
  paneLooksReady,
  paneHasActiveTask,
  paneHasTrustPrompt,
  verifyTeamTargetOwnership,
  TeamSessionCreationError,
  normalizeDetachedSessionTarget,
  buildDetachedTmuxServerKeepaliveArgs,
  buildPrivateTmuxSocketPath,
  captureTmuxServerIdentity,
  observeTmuxServerIdentity,
  runTmuxServerIdentityGuard,
  type TmuxServerIdentityObservation,
  type WorkerPaneLiveness,
} from '../tmux-session.js';
import { isValidTmuxServerIdentity, type TmuxServerIdentity } from '../types.js';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const testProcessStartedAt = process.platform === 'linux'
  ? 'linux:test-boot:1'
  : process.platform === 'darwin'
    ? 'darwin:1:1'
    : process.platform === 'win32'
      ? 'win32:1'
      : 'unsupported:identity';

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

describe('detached session target normalization', () => {
  it('normalizes only the explicit zero-window response form', () => {
    expect(normalizeDetachedSessionTarget('worker-detached-session:0')).toBe('worker-detached-session');
    expect(normalizeDetachedSessionTarget('worker-detached-session:1')).toBeNull();
    expect(normalizeDetachedSessionTarget('worker-detached-session:workers')).toBeNull();
    expect(normalizeDetachedSessionTarget('worker-detached-session')).toBe('worker-detached-session');
  });
});

describe('tmux creation allocation evidence', () => {
  it('retains typed evidence when creation cleanup is unknown', () => {
    const error = new TeamSessionCreationError(
      'tmux_creation_cleanup_unverified',
      {
        sessionName: 'team:0',
        leaderPaneId: '%1',
        workerPaneIds: [],
        sessionMode: 'split-pane',
        tmuxServerIdentity: {
          socket_path: '/tmp/team.sock',
          server_pid: 7,
          process_started_at: testProcessStartedAt,
        },
      },
      {
        provider: 'tmux',
        operation: 'split-window',
        rawOutput: 'unexpected output',
        stderr: '',
      },
    );
    expect(error.cleanupStatus).toBe('unknown');
    expect(error.creationEvidence?.rawOutput).toBe('unexpected output');
    expect(error.partialSession.workerPaneIds).toEqual([]);
  });
});

describe('verifyTeamTargetOwnership tmux target kinds', () => {
  const processStartedAt = process.platform === 'linux'
    ? 'linux:test-boot:1'
    : process.platform === 'darwin'
      ? 'darwin:1:1'
      : 'unsupported:identity';
  const serverIdentity: TmuxServerIdentity = {
    socket_path: '/tmp/omc-tmux-membership.sock',
    server_pid: 42,
    process_started_at: processStartedAt,
  };
  const dependenciesFor = (
    tmuxExec: (args: string[]) => Promise<{ stdout: string; stderr: string }>,
  ) => ({
    tmuxExec,
    cmuxExec: vi.fn(async () => ({ stdout: '', stderr: '' })),
    serverIdentityDependencies: {
      tmuxQuery: vi.fn(async () => ({ stdout: '42\n', stderr: '' })),
      processIdentity: () => processStartedAt,
      processObservation: () => 'matching' as const,
    },
  });
  const target = (providerTarget: string) => ({
    provider: 'tmux' as const,
    providerTarget,
    recipient: 'worker-1',
    recipientRole: 'worker' as const,
    paneId: '%9',
    workerIndex: 1,
    tmuxServerIdentity: serverIdentity,
  });

  it('uses an exact session selector for bare named-session membership', async () => {
    const tmuxExec = vi.fn(async () => ({ stdout: '%9\n', stderr: '' }));

    await expect(verifyTeamTargetOwnership(target('dispatch-session'), dependenciesFor(tmuxExec))).resolves.toEqual({
      kind: 'owned',
      provider: 'tmux',
      providerTarget: 'dispatch-session',
      paneId: '%9',
      tmuxServerIdentity: serverIdentity,
    });

    expect(tmuxExec).toHaveBeenCalledWith([
      '-S', serverIdentity.socket_path, 'list-panes', '-s', '-t', '=dispatch-session:', '-F', '#{pane_id}',
    ]);
  });

  it('keeps an explicit session:window target exact without session scope', async () => {
    const tmuxExec = vi.fn(async () => ({ stdout: '%9\n', stderr: '' }));

    await expect(verifyTeamTargetOwnership(target('dispatch-session:0'), dependenciesFor(tmuxExec)))
      .resolves.toMatchObject({ kind: 'owned', paneId: '%9', tmuxServerIdentity: serverIdentity });

    expect(tmuxExec).toHaveBeenCalledWith([
      '-S', serverIdentity.socket_path, 'list-panes', '-t', '=dispatch-session:0', '-F', '#{pane_id}',
    ]);
  });

  it('adds exact matching to named windows to prevent prefix collisions', async () => {
    const tmuxExec = vi.fn(async () => ({ stdout: '%9\n', stderr: '' }));

    await expect(verifyTeamTargetOwnership(target('dispatch-session:worker'), dependenciesFor(tmuxExec)))
      .resolves.toMatchObject({ kind: 'owned', paneId: '%9', tmuxServerIdentity: serverIdentity });

    expect(tmuxExec).toHaveBeenCalledWith([
      '-S', serverIdentity.socket_path, 'list-panes', '-t', '=dispatch-session:=worker', '-F', '#{pane_id}',
    ]);
  });

  it('passes supported native session/window IDs without name prefixes', async () => {
    const tmuxExec = vi.fn(async () => ({ stdout: '%9\n', stderr: '' }));
    const dependencies = dependenciesFor(tmuxExec);

    await expect(verifyTeamTargetOwnership(target('$7'), dependencies))
      .resolves.toMatchObject({ kind: 'owned', paneId: '%9', tmuxServerIdentity: serverIdentity });
    expect(tmuxExec).toHaveBeenLastCalledWith([
      '-S', serverIdentity.socket_path, 'list-panes', '-s', '-t', '$7', '-F', '#{pane_id}',
    ]);

    await expect(verifyTeamTargetOwnership(target('@13'), dependencies))
      .resolves.toMatchObject({ kind: 'owned', paneId: '%9', tmuxServerIdentity: serverIdentity });
    expect(tmuxExec).toHaveBeenLastCalledWith([
      '-S', serverIdentity.socket_path, 'list-panes', '-t', '@13', '-F', '#{pane_id}',
    ]);
  });

  it('fails closed for malformed native-looking target IDs', async () => {
    const tmuxExec = vi.fn(async () => ({ stdout: '%9\n', stderr: '' }));

    await expect(verifyTeamTargetOwnership(target('$session'), dependenciesFor(tmuxExec)))
      .resolves.toEqual({ kind: 'unavailable' });
    expect(tmuxExec).not.toHaveBeenCalled();
  });
});

describe('tmux server incarnation identity', () => {
  const startIdentity = process.platform === 'linux'
    ? 'linux:test-boot:1'
    : process.platform === 'darwin'
      ? 'darwin:1:1'
      : process.platform === 'win32'
        ? 'win32:1'
        : `${process.platform}:native`;
  const identity: TmuxServerIdentity = {
    socket_path: '/tmp/omc-tmux-test.sock',
    server_pid: 42,
    process_started_at: startIdentity,
  };

  it('captures socket and PID from tmux output, then binds strict process identity', async () => {
    const tmuxQuery = vi.fn(async () => ({ stdout: `${identity.socket_path}\t${identity.server_pid}\n`, stderr: '' }));
    await expect(captureTmuxServerIdentity(undefined, {
      tmuxQuery,
      processIdentity: () => identity.process_started_at,
    })).resolves.toEqual(identity);
    expect(tmuxQuery).toHaveBeenCalledWith(
      ['display-message', '-p', '#{socket_path}\t#{pid}'],
      undefined,
    );
  });

  it.each([
    ['matching', 'matching', 'matching'],
    ['dead', 'dead', 'dead'],
    ['unknown', 'unknown', 'unknown'],
  ] as const)(
    'keeps process identity observation distinct for %s',
    async (_label, processState, expected) => {
      const actual = await observeTmuxServerIdentity(identity, {
        tmuxQuery: vi.fn(async () => ({ stdout: '42\n', stderr: '' })),
        processIdentity: () => identity.process_started_at,
        processObservation: () => processState,
      });
      expect(actual as TmuxServerIdentityObservation).toBe(expected);
    },
  );

  it('rejects malformed identity before querying and rejects a mismatched server response', async () => {
    expect(isValidTmuxServerIdentity({ socket_path: 'relative', server_pid: 42, process_started_at: startIdentity })).toBe(false);
    const tmuxQuery = vi.fn(async () => ({ stdout: '42\n', stderr: '' }));
    await expect(observeTmuxServerIdentity({
      ...identity,
      socket_path: 'relative',
    }, { tmuxQuery })).resolves.toBe('unknown');
    expect(tmuxQuery).not.toHaveBeenCalled();
    await expect(observeTmuxServerIdentity({
      ...identity,
      server_pid: 43,
    }, {
      tmuxQuery,
      processIdentity: () => identity.process_started_at,
      processObservation: () => 'matching',
    })).resolves.toBe('unknown');
    expect(tmuxQuery).toHaveBeenCalledExactlyOnceWith(
      ['-S', identity.socket_path, 'display-message', '-p', '#{pid}'],
      { timeout: 2_000, stripTmux: true },
    );
  });

  it('returns guard success only for exact PID/socket and strict process identity', () => {
    expect(runTmuxServerIdentityGuard(identity, '42', identity.socket_path, {
      processIdentity: () => identity.process_started_at,
    })).toBe(0);
    expect(runTmuxServerIdentityGuard(identity, '43', identity.socket_path, {
      processIdentity: () => identity.process_started_at,
    })).toBe(1);
    expect(runTmuxServerIdentityGuard(identity, '42', '/tmp/other.sock', {
      processIdentity: () => identity.process_started_at,
    })).toBe(1);
  });
});

describe('detached tmux no-server startup handshake', () => {
  it('starts the first session directly on a short private endpoint', () => {
    const socketPath = buildPrivateTmuxSocketPath();
    const keepalive = buildDetachedTmuxServerKeepaliveArgs(socketPath);

    expect(keepalive).toEqual([
      '-S', socketPath, 'start-server', ';', 'set-option', '-g', 'exit-empty', 'off',
    ]);
    if (process.platform === 'darwin' || process.platform === 'linux') {
      expect(Buffer.byteLength(socketPath, 'utf8')).toBeLessThan(104);
    }
  });
});

describe('getWorkerLiveness tmux inventory fallback', () => {
  async function loadLivenessWithTmuxOutputs(
    displayOutput: string,
    inventoryOutput: string,
  ): Promise<{ liveness: WorkerPaneLiveness; calls: string[][] }> {
    const calls: string[][] = [];
    const tmuxCmdAsync = vi.fn(async (args: string[]) => {
      calls.push(args);
      if (args[0] === 'display-message') return { stdout: displayOutput, stderr: '' };
      return { stdout: inventoryOutput, stderr: '' };
    });

    vi.resetModules();
    vi.doMock('../../cli/tmux-utils.js', async (importOriginal) => {
      const actual = await importOriginal<typeof import('../../cli/tmux-utils.js')>();
      return { ...actual, tmuxCmdAsync };
    });

    try {
      const { getWorkerLiveness } = await import('../tmux-session.js');
      return { liveness: await getWorkerLiveness('%1'), calls };
    } finally {
      vi.doUnmock('../../cli/tmux-utils.js');
      vi.resetModules();
    }
  }

  it('proves a removed pane dead from a valid non-empty native inventory', async () => {
    const result = await loadLivenessWithTmuxOutputs('', '%0 0\n');

    expect(result.liveness).toBe('dead');
    expect(result.calls).toEqual([
      ['display-message', '-t', '%1', '-p', '#{pane_dead}'],
      ['list-panes', '-a', '-F', '#{pane_id} #{pane_dead}'],
    ]);
  });

  it.each(['', 'not-a-pane\n', '%0 malformed\n', '%0 0\nmalformed\n'])(
    'preserves unknown when fallback inventory is empty or malformed: %j',
    async (inventoryOutput) => {
      const result = await loadLivenessWithTmuxOutputs('', inventoryOutput);

      expect(result.liveness).toBe('unknown');
    },
  );

  it('matches native pane IDs exactly instead of treating a prefix as present', async () => {
    const result = await loadLivenessWithTmuxOutputs('', '%10 0\n');

    expect(result.liveness).toBe('dead');
  });
});

describe('applyMainVerticalLayout', () => {
  const identity: TmuxServerIdentity = {
    socket_path: '/tmp/layout-test.sock',
    server_pid: 42,
    process_started_at: process.platform === 'linux' ? 'linux:fixture:42' : 'darwin:42:123456',
  };
  function guardedResult(args: string[]): { stdout: string; stderr: string } {
    expect(args.slice(0, 3)).toEqual(['-S', identity.socket_path, 'if-shell']);
    expect(args[3]).toContain('--tmux-server-identity-guard');
    const marker = args[4]?.match(/OMC_TMUX_GUARD_OK_[A-Za-z0-9_]+/)?.[0];
    expect(marker).toBeDefined();
    return { stdout: `${marker}\n`, stderr: '' };
  }

  it('sets the 80-column main width before its sole layout selection', async () => {
    const calls: string[][] = [];
    let mainPaneWidth: number | undefined;
    const selectedPaneWidths: Array<number | undefined> = [];

    vi.resetModules();
    vi.doMock('../../cli/tmux-utils.js', async (importOriginal) => {
      const actual = await importOriginal<typeof import('../../cli/tmux-utils.js')>();
      return {
        ...actual,
        tmuxCmdAsync: vi.fn(async (args: string[]) => {
          calls.push(args);
          if (args[2] === 'if-shell') {
            const command = args[4] ?? '';
            const width = command.match(/'main-pane-width' '(\d+)'/)?.[1];
            if (width) mainPaneWidth = Number(width);
            if (command.includes("'select-layout'")) selectedPaneWidths.push(mainPaneWidth);
            return guardedResult(args);
          }
          return { stdout: '80\n', stderr: '' };
        }),
        tmuxExecAsync: vi.fn(async (args: string[]) => {
          throw new Error(`unguarded layout effect: ${args.join(' ')}`);
        }),
      };
    });

    try {
      const { applyMainVerticalLayout } = await import('../tmux-session.js');
      await applyMainVerticalLayout('team-session', { tmuxServerIdentity: identity });
    } finally {
      vi.doUnmock('../../cli/tmux-utils.js');
      vi.resetModules();
    }

    expect(calls).toEqual([
      ['-S', identity.socket_path, 'display-message', '-p', '-t', 'team-session', '#{window_width}'],
      ['-S', identity.socket_path, 'if-shell', expect.any(String), expect.stringContaining("'main-pane-width' '40'"), expect.any(String)],
      ['-S', identity.socket_path, 'if-shell', expect.any(String), expect.stringContaining("'select-layout' '-t' 'team-session' 'main-vertical'"), expect.any(String)],
    ]);
    expect(calls.filter(args => args[4]?.includes("'select-layout'"))).toHaveLength(1);
    expect(selectedPaneWidths).toEqual([40]);
  });

  it('fails required startup layout before selecting when width is invalid', async () => {
    const calls: string[][] = [];

    vi.resetModules();
    vi.doMock('../../cli/tmux-utils.js', async (importOriginal) => {
      const actual = await importOriginal<typeof import('../../cli/tmux-utils.js')>();
      return {
        ...actual,
        tmuxCmdAsync: vi.fn(async (args: string[]) => {
          calls.push(args);
          return { stdout: 'not-a-width\n', stderr: '' };
        }),
        tmuxExecAsync: vi.fn(async (args: string[]) => {
          calls.push(args);
          return { stdout: '', stderr: '' };
        }),
      };
    });

    try {
      const { applyMainVerticalLayout } = await import('../tmux-session.js');
      await expect(applyMainVerticalLayout('team-session', { required: true, tmuxServerIdentity: identity }))
        .rejects.toThrow('team_layout_window_width_invalid:not-a-width');
    } finally {
      vi.doUnmock('../../cli/tmux-utils.js');
      vi.resetModules();
    }

    expect(calls).toEqual([
      ['-S', identity.socket_path, 'display-message', '-p', '-t', 'team-session', '#{window_width}'],
    ]);
  });

  it('rejects a required layout below the startup width boundary', async () => {
    const calls: string[][] = [];

    vi.resetModules();
    vi.doMock('../../cli/tmux-utils.js', async (importOriginal) => {
      const actual = await importOriginal<typeof import('../../cli/tmux-utils.js')>();
      return {
        ...actual,
        tmuxCmdAsync: vi.fn(async (args: string[]) => {
          calls.push(args);
          return { stdout: '39\n', stderr: '' };
        }),
        tmuxExecAsync: vi.fn(async (args: string[]) => {
          calls.push(args);
          return { stdout: '', stderr: '' };
        }),
      };
    });

    try {
      const { applyMainVerticalLayout } = await import('../tmux-session.js');
      await expect(applyMainVerticalLayout('team-session', { required: true, tmuxServerIdentity: identity }))
        .rejects.toThrow('team_layout_window_width_invalid:39');
    } finally {
      vi.doUnmock('../../cli/tmux-utils.js');
      vi.resetModules();
    }

    expect(calls).toEqual([
      ['-S', identity.socket_path, 'display-message', '-p', '-t', 'team-session', '#{window_width}'],
    ]);
  });

  it('never selects a best-effort layout when main-pane-width cannot be set', async () => {
    const calls: string[][] = [];

    vi.resetModules();
    vi.doMock('../../cli/tmux-utils.js', async (importOriginal) => {
      const actual = await importOriginal<typeof import('../../cli/tmux-utils.js')>();
      return {
        ...actual,
        tmuxCmdAsync: vi.fn(async (args: string[]) => {
          calls.push(args);
          if (args[2] === 'if-shell') {
            guardedResult(args);
            return { stdout: '', stderr: 'set failed' };
          }
          return { stdout: '80\n', stderr: '' };
        }),
        tmuxExecAsync: vi.fn(async (args: string[]) => {
          calls.push(args);
          if (args[0] === 'set-window-option') throw new Error('set failed');
          return { stdout: '', stderr: '' };
        }),
      };
    });

    try {
      const { applyMainVerticalLayout } = await import('../tmux-session.js');
      await expect(applyMainVerticalLayout('team-session', { tmuxServerIdentity: identity }))
        .rejects.toThrow('team_layout_server_guard_failed');
    } finally {
      vi.doUnmock('../../cli/tmux-utils.js');
      vi.resetModules();
    }

    expect(calls).toEqual([
      ['-S', identity.socket_path, 'display-message', '-p', '-t', 'team-session', '#{window_width}'],
      ['-S', identity.socket_path, 'if-shell', expect.any(String), expect.stringContaining("'main-pane-width' '40'"), expect.any(String)],
    ]);
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

  it('uses cmd.exe syntax for native Windows psmux worker start commands', () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    vi.stubEnv('PSMUX_SESSION', 'psmux-session-1');
    vi.stubEnv('COMSPEC', 'C:\\Windows\\System32\\cmd.exe');

    const cmd = buildWorkerStartCommand({
      teamName: 't',
      workerName: 'w',
      envVars: { OMC_TEAM_WORKER: 'team/worker-1' },
      launchBinary: 'C:\\Users\\tester\\AppData\\Local\\Programs\\claude\\claude.exe',
      launchArgs: ['--agent-id', 'worker-1'],
      cwd: 'C:\\repo'
    });

    expect(cmd).toBe(
      'C:\\Windows\\System32\\cmd.exe /d /s /c "set "OMC_TEAM_WORKER=team/worker-1" && ' +
      '"C:\\Users\\tester\\AppData\\Local\\Programs\\claude\\claude.exe" "--agent-id" "worker-1"" & exit /b'
    );
    expect(cmd).not.toContain('$env:OMC_TEAM_WORKER');
  });

  it('preserves POSIX argv-style exec while routing launch through the acknowledgement bootstrap', () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
    vi.stubEnv('SHELL', '/bin/bash');
    const cmd = buildWorkerStartCommand({
      teamName: 't',
      workerName: 'w',
      envVars: { OMC_TEAM_WORKER: 't/w' },
      launchBinary: '/opt/codex/bin/codex',
      launchArgs: ['--label', 'worker one'],
      cwd: '/tmp/team workspace',
      provider: 'codex',
      launchAttempt: {
        schema_version: 1,
        attempt_id: '11111111-1111-4111-8111-111111111111',
        nonce: '22222222-2222-4222-8222-222222222222',
        instance_id: '33333333-3333-4333-8333-333333333333',
        team_name: 't',
        worker_name: 'w',
        pane_id: '%2',
        provider: 'codex',
        created_at: '2026-01-01T00:00:00.000Z',
        currentPath: '/tmp/current.json',
        expectedPath: '/tmp/expected.json',
        ackPath: '/tmp/ack.json',
        decisionPath: '/tmp/decision.json',
        startedPath: '/tmp/provider-started.json',
        transportOwnerPath: '/tmp/transport-owner.json',
        bootstrapDescriptorPath: '/tmp/bootstrap.json',
        wrapperPath: '/tmp/launch.cmd',
        transportCleanupCompletePath: '/tmp/transport-cleanup-complete.json',
        runtimeCliPath: '/opt/omc/runtime-cli.cjs',
      },
    });

    // Supervised POSIX launches reference the attempt-owned descriptor by path
    // (issue #3655); the bootstrap spec itself must never travel inline.
    expect(cmd).toContain("OMC_WORKER_LAUNCH_SPEC_FILE='/tmp/bootstrap.json'");
    expect(cmd).not.toContain('OMC_WORKER_LAUNCH_SPEC=');
    expect(cmd).toContain("exec \"$@\"");
    expect(cmd).toContain("'--worker-launch'");
    expect(cmd).toContain("'/opt/omc/runtime-cli.cjs'");
  });

  it('keeps provider percent/quote metacharacters out of the native Windows cmd command', () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    vi.stubEnv('COMSPEC', 'C:\\Windows\\System32\\cmd.exe');
    const cmd = buildWorkerStartCommand({
      teamName: 't',
      workerName: 'w',
      envVars: { OMC_TEAM_WORKER: 't/w' },
      launchBinary: 'C:\\Program Files\\Codex\\codex.exe',
      launchArgs: ['--label', '100% ready %USERPROFILE%', '--title="quoted"'],
      cwd: 'C:\\team workspace',
      provider: 'codex',
      launchAttempt: {
        schema_version: 1,
        attempt_id: '11111111-1111-4111-8111-111111111111',
        nonce: '22222222-2222-4222-8222-222222222222',
        instance_id: '33333333-3333-4333-8333-333333333333',
        team_name: 't',
        worker_name: 'w',
        pane_id: '%2',
        provider: 'codex',
        created_at: '2026-01-01T00:00:00.000Z',
        currentPath: 'C:\\state\\current.json',
        expectedPath: 'C:\\state\\expected.json',
        ackPath: 'C:\\state\\ack.json',
        decisionPath: 'C:\\state\\decision.json',
        startedPath: 'C:\\state\\provider-started.json',
        transportOwnerPath: 'C:\\state\\transport-owner.json',
        bootstrapDescriptorPath: 'C:\\state\\bootstrap.json',
        wrapperPath: 'C:\\state\\launch.cmd',
        transportCleanupCompletePath: 'C:\\state\\transport-cleanup-complete.json',
        runtimeCliPath: 'C:\\Program Files\\omc\\runtime-cli.cjs',
      },
    });

    expect(cmd).toContain('C:\\Windows\\System32\\cmd.exe /d /s /c');
    // Supervised launches deliver the attempt-owned descriptor by path; the
    // bootstrap spec (and its percent/quote metacharacters) never travels in
    // the command line or cmd environment (issue #3655).
    expect(cmd).toContain('set "OMC_WORKER_LAUNCH_SPEC_FILE=C:\\state\\bootstrap.json"');
    expect(cmd).not.toContain('OMC_WORKER_LAUNCH_SPEC_B64=');
    expect(cmd).not.toContain('OMC_WORKER_LAUNCH_SPEC=');
    expect(cmd).not.toContain('100% ready %USERPROFILE%');
    expect(cmd).not.toContain('pane_id=%%2');
  });

  it('rejects CRLF injection in native Windows provider argv', () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    vi.stubEnv('COMSPEC', 'C:\\Windows\\System32\\cmd.exe');

    expect(() => buildWorkerStartCommand({
      teamName: 't', workerName: 'w', envVars: {},
      launchBinary: 'C:\\Program Files\\Cursor\\cursor-agent.exe',
      launchArgs: ['--model', 'safe\r\nset PWNED=1'], cwd: 'C:\\repo',
    })).toThrow('contains CR, LF, or NUL');
  });

  it('escapes psmux cmd.exe env vars and quoted launch args without PowerShell syntax', () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    vi.stubEnv('PSMUX_SESSION', 'psmux-session-1');
    vi.stubEnv('COMSPEC', 'C:\\Windows\\System32\\cmd.exe');

    const cmd = buildWorkerStartCommand({
      teamName: 't',
      workerName: 'w',
      envVars: {
        OMC_TEAM_WORKER: "team name/worker 'one'",
        OMC_TEAM_STATE_ROOT: 'C:\\Users\\Test User\\AppData\\Local\\omc state',
        CLAUDE_CODE_USE_BEDROCK: 'value with spaces & [brackets] "quotes"',
      },
      launchBinary: 'C:\\Program Files\\Claude Code\\claude.exe',
      launchArgs: [
        '--model',
        'sonnet "quoted"',
        "--label=worker 'one'",
      ],
      cwd: 'C:\\repo'
    });

    expect(cmd).toContain('set "OMC_TEAM_WORKER=team name/worker \'one\'"');
    expect(cmd).toContain('set "OMC_TEAM_STATE_ROOT=C:\\Users\\Test User\\AppData\\Local\\omc state"');
    expect(cmd).toContain('set "CLAUDE_CODE_USE_BEDROCK=value with spaces & [brackets] ""quotes"""');
    expect(cmd).toContain('"C:\\Program Files\\Claude Code\\claude.exe" "--model" "sonnet ""quoted""" "--label=worker \'one\'"');
    expect(cmd).not.toContain('$env:OMC_TEAM_WORKER');
  });

  it('escapes literal percent signs in native Windows cmd env values and launch args', () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    vi.stubEnv('COMSPEC', 'C:\\Windows\\System32\\cmd.exe');

    const cmd = buildWorkerStartCommand({
      teamName: 't',
      workerName: 'w',
      envVars: {
        OMC_TEAM_WORKER: 'team/worker-1',
        OMC_TOKEN: 'literal%USERPROFILE%token%25',
      },
      launchBinary: 'C:\\Program Files\\Claude Code\\claude.exe',
      launchArgs: ['--label', '100% ready %USERPROFILE%', '--token=abc%25'],
      cwd: 'C:\\repo'
    });

    expect(cmd).toContain('set "OMC_TOKEN=literal%%USERPROFILE%%token%%25"');
    expect(cmd).toContain('"100%% ready %%USERPROFILE%%"');
    expect(cmd).toContain('"--token=abc%%25"');
    expect(cmd).not.toContain('literal%USERPROFILE%token%25');
  });
  it('base64-encodes recovery gate launch identities for native Windows cmd', () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    vi.stubEnv('COMSPEC', 'C:\\Windows\\System32\\cmd.exe');
    const gate = { recoveryId: 'recovery-1', launchAttempt: { attempt_id: 'attempt-1', nonce: 'nonce-1', pane_id: '%2' } };

    const cmd = buildWorkerStartCommand({
      teamName: 't',
      workerName: 'w',
      envVars: { OMC_RECOVERY_GATE_SPEC: JSON.stringify(gate) },
      launchBinary: 'C:\\Program Files\\nodejs\\node.exe',
      launchArgs: ['C:\\omc\\runtime-cli.cjs', '--recovery-gate'],
      cwd: 'C:\\repo',
    });

    const marker = 'set "OMC_RECOVERY_GATE_SPEC_B64=';
    const encodedStart = cmd.indexOf(marker) + marker.length;
    const encodedEnd = cmd.indexOf('" &&', encodedStart);
    expect(JSON.parse(Buffer.from(cmd.slice(encodedStart, encodedEnd), 'base64').toString('utf8')))
      .toMatchObject({ launchAttempt: { pane_id: '%2' } });
    expect(cmd).not.toContain('OMC_RECOVERY_GATE_SPEC=');
    expect(cmd).not.toContain('pane_id=%%2');
  });


  it('does not cmd-escape percent signs on MSYS Windows worker startup', () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    vi.stubEnv('PSMUX_SESSION', 'psmux-session-1');
    vi.stubEnv('MSYSTEM', 'MINGW64');
    vi.stubEnv('SHELL', '/usr/bin/bash');
    vi.stubEnv('COMSPEC', 'C:\\Windows\\System32\\cmd.exe');

    const cmd = buildWorkerStartCommand({
      teamName: 't',
      workerName: 'w',
      envVars: { OMC_TOKEN: 'literal%USERPROFILE%token%25' },
      launchBinary: '/c/Program Files/Git/bin/bash.exe',
      launchArgs: ['--label=100% ready'],
      cwd: '/c/repo'
    });

    expect(cmd).toContain("OMC_TOKEN='literal%USERPROFILE%token%25'");
    expect(cmd).toContain("'--label=100% ready'");
    expect(cmd).not.toContain('%%USERPROFILE%%');
  });


  it('keeps cmd.exe worker startup syntax for native Windows without psmux', () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    vi.stubEnv('COMSPEC', 'C:\\Windows\\System32\\cmd.exe');

    const cmd = buildWorkerStartCommand({
      teamName: 't',
      workerName: 'w',
      envVars: { OMC_TEAM_WORKER: 'team/worker-1' },
      launchBinary: 'C:\\Program Files\\OpenAI\\Codex\\codex.exe',
      launchArgs: ['--full-auto'],
      cwd: 'C:\\repo'
    });

    expect(cmd).toBe(
      'C:\\Windows\\System32\\cmd.exe /d /s /c "set "OMC_TEAM_WORKER=team/worker-1" && ' +
      '"C:\\Program Files\\OpenAI\\Codex\\codex.exe" "--full-auto"" & exit /b'
    );
  });

  it('keeps MSYS/Git Bash worker startup syntax even when psmux env is present', () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    vi.stubEnv('PSMUX_SESSION', 'psmux-session-1');
    vi.stubEnv('MSYSTEM', 'MINGW64');
    vi.stubEnv('SHELL', '/usr/bin/bash');
    vi.stubEnv('COMSPEC', 'C:\\Windows\\System32\\cmd.exe');

    const cmd = buildWorkerStartCommand({
      teamName: 't',
      workerName: 'w',
      envVars: { OMC_TEAM_WORKER: 'team/worker-1' },
      launchBinary: '/c/Program Files/Git/bin/bash.exe',
      launchArgs: ['--login'],
      cwd: '/c/repo'
    });

    expect(cmd).toContain("'env' OMC_TEAM_WORKER='team/worker-1'");
    expect(cmd).toContain("'/usr/bin/bash' '-lc'");
    expect(cmd).toContain("'--' '/c/Program Files/Git/bin/bash.exe' '--login'");
    expect(cmd).not.toContain('/d /s /c');
    expect(cmd).not.toContain('$env:OMC_TEAM_WORKER');
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

describe('pane readiness startup banners', () => {
  it('does not treat Claude bypass-permissions startup banner as ready', () => {
    const capture = [
      'Read .omc/state/team/example/workers/worker-1/inbox.md, execute now, report concrete progress.',
      '─────────────────────────────────────────────',
      '[OMC] Starting...',
      '⏵⏵ bypass permissions on (shift+tab to cycle)',
    ].join('\n');

    expect(paneLooksReady(capture)).toBe(false);
  });

  it('treats an exact directory trust selector as ready for legacy delivery', () => {
    const capture = [
      'Do you trust the contents of this directory?',
      '› 1. Yes, continue',
      '  2. No, quit',
    ].join('\n');

    expect(paneHasTrustPrompt(capture)).toBe(true);
    expect(paneLooksReady(capture)).toBe(true);
    expect(paneHasActiveTask(capture)).toBe(false);
  });

  it('detects Codex CLI hook-trust review screen as a trust prompt', () => {
    const capture = [
      '  Hooks need review',
      '  3 hooks are new or changed.',
      '  Hooks can run outside the sandbox after you trust them.',
      '',
      '› 1. Review hooks',
      '  2. Trust all and continue',
      "  3. Continue without trusting (hooks won't run)",
      '',
      '  Press enter to confirm or esc to go back',
    ].join('\n');

    expect(paneHasTrustPrompt(capture)).toBe(true);
    expect(paneLooksReady(capture)).toBe(true);
    expect(paneHasActiveTask(capture)).toBe(false);
  });

  it('detects the cursor-agent workspace-trust banner and refuses to call it ready', () => {
    // Verbatim capture from `cursor-agent` launched in tmux on an untrusted
    // directory. It offers no numbered choice and the process exits, unlike
    // the dismissible Claude/Codex prompts above.
    const capture = [
      '⚠ Workspace Trust Required',
      '',
      '  Cursor Agent can execute code and access files in this directory.',
      '  Do you trust the contents of this directory?',
      '',
      '    /private/tmp/ct-nf2',
      '',
      '  To proceed, you can either:',
      "    • Run 'agent' interactively to decide",
      '    • Pass --trust, --yolo, or -f if you trust this directory',
    ].join('\n');

    expect(paneHasTrustPrompt(capture)).toBe(true);
    // The pane is dead: treating it as ready would hand work to a gone process.
    expect(paneLooksReady(capture, 'cursor')).toBe(false);
    expect(paneHasActiveTask(capture, 'cursor')).toBe(false);
  });

  it('gives the Cursor trust banner precedence and keeps it provider-scoped', () => {
    const capture = [
      '⚠ Workspace Trust Required',
      'Do you trust the contents of this directory?',
      '› 1. Yes, continue',
      '  2. No, quit',
      "  • Pass --trust, --yolo, or -f if you trust this directory",
    ].join('\n');

    expect(paneHasTrustPrompt(capture, 'cursor')).toBe(true);
    expect(paneLooksReady(capture, 'cursor')).toBe(false);
    expect(paneLooksReady(capture, 'claude')).toBe(true);
  });

  it('still treats actual prompt lines as ready', () => {
    expect(paneLooksReady('Welcome\n❯ ')).toBe(true);
    expect(paneLooksReady('Welcome\n> ')).toBe(true);
    expect(paneLooksReady('⏵⏵ bypass permissions on (shift+tab to cycle)\nReady\n❯ ')).toBe(true);
  });

  it('treats Claude Code v2.1.x idle pane (prompt above persistent mode indicator) as ready', () => {
    // Claude Code v2.1.142 renders the permission-mode indicator
    // ("⏵⏵ bypass permissions on (shift+tab to cycle)") *below* the prompt
    // as a persistent idle-state UI element. Before this fix, the pane was
    // misread as still bootstrapping and OMC never dispatched the inbox to
    // claude workers, leaving them hung with "[OMC] Starting..." forever.
    const capture = [
      '▐▛███▜▌   Claude Code v2.1.142',
      '▝▜█████▛▘  Opus 4.7 (1M context) · Claude Max',
      '  ▘▘ ▝▝    ~/some/repo',
      '',
      '───────────────────────────────────────',
      '❯ ',
      '───────────────────────────────────────',
      '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
    ].join('\n');

    expect(paneLooksReady(capture)).toBe(true);
    expect(paneHasActiveTask(capture)).toBe(false);
  });

  it('treats Claude idle prompt inside the TUI gutter as ready for initial dispatch', () => {
    const capture = [
      '╭────────────────────────────────────────────────────────╮',
      '│ ✻ Welcome to Claude Code v2.1.142                      │',
      '│                                                        │',
      '│ ❯                                                      │',
      '╰────────────────────────────────────────────────────────╯',
      '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
    ].join('\n');

    expect(paneLooksReady(capture)).toBe(true);
    expect(paneHasActiveTask(capture)).toBe(false);
  });

  it('still flags Claude Code v2.1.x mid-task panes via paneHasActiveTask', () => {
    // Same v2.1.x pane shape with a spinner + "esc to interrupt" — paneLooksReady
    // sees the prompt and reports ready, but waitForPaneReady's secondary
    // paneHasActiveTask guard catches the in-flight task and keeps the worker
    // from being treated as idle.
    const capture = [
      '❯ Run the migration',
      '·  Thinking…',
      '   esc to interrupt',
      '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
    ].join('\n');

    expect(paneLooksReady(capture)).toBe(true);
    expect(paneHasActiveTask(capture)).toBe(true);
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

