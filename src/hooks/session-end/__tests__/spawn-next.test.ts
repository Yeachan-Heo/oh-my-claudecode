import { describe, it, expect, vi, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { AFK_SPAWN_FLAGS, defaultSpawnFn, executeSpawnNext, factoryLinkArgv, planSpawnNext, spawnNextAlertComment, type SpawnNextChain, type SpawnFn } from '../spawn-next.js';

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return { ...actual, spawn: vi.fn(() => ({ unref() {}, stdin: null })) as unknown as typeof actual.spawn };
});

import * as childProcess from 'child_process';

const chain: SpawnNextChain = {
  outcome: 'success',
  reason: 'clear',
  routeTable: { 'success:clear': { stage: 'launch', skill: 'launch' }, 'success:*': { stage: 'fallback', skill: 'fallback' } },
  sessionId: 'sess-1',
  handoffContext: 'context body',
  tracker: { repo: 'owner/repo', issue: 42, nextLabel: 'in-launch', failedLabel: 'failed' },
};

const sessions = (): Array<[string, string[]]> => [];
const spawnRecording = (): { spawnFn: SpawnFn; calls: Array<[string, string[]]>; ctxs: Array<unknown> } => {
  const calls = sessions();
  const ctxs: Array<unknown> = [];
  const spawnFn: SpawnFn = (command, args, ctx) => { calls.push([command, args]); ctxs.push(ctx); return { unref() {} }; };
  return { spawnFn, calls, ctxs };
};

describe('planSpawnNext', () => {
  it('routes exact key hit to the next stage plan', () => {
    const plan = planSpawnNext(chain, '/omc-root');
    expect(plan?.directive).toEqual({ stage: 'launch', skill: 'launch' });
    expect(plan?.handoffPath).toBe(path.join('/omc-root', 'handoffs', 'sess-1-launch.json'));
    expect(plan?.spawnArgv[0]).toBe('claude');
    expect(plan?.spawnArgv.join(' ')).toContain('-p');
    expect(plan?.spawnArgv.join(' ')).toContain('launch');
    expect(plan?.spawnArgv).toContain('--session-id');
    expect(plan?.nextSessionId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('falls back to the wildcard key', () => {
    const plan = planSpawnNext({ ...chain, reason: 'other' }, '/omc-root');
    expect(plan?.directive).toEqual({ stage: 'fallback', skill: 'fallback' });
  });

  it('returns null when no route matches', () => {
    expect(planSpawnNext({ ...chain, outcome: 'failed' as const }, '/omc-root')).toBeNull();
  });

  it('builds tracker writeback argv arrays only when a tracker is configured', () => {
    const withTracker = planSpawnNext(chain, '/omc-root');
    expect(withTracker?.trackerCommands[0]).toEqual(['gh', 'issue', 'edit', '42', '--repo', 'owner/repo', '--add-label', 'in-launch']);
    expect(withTracker?.trackerCommands[1]?.slice(0, 6)).toEqual(['gh', 'issue', 'comment', '42', '--repo', 'owner/repo']);
    const withoutTracker = planSpawnNext({ ...chain, tracker: undefined }, '/omc-root');
    expect(withoutTracker?.trackerCommands).toEqual([]);
  });

  it('appends the AFK permission profile to the spawn argv', () => {
    const plan = planSpawnNext(chain, '/omc-root');
    for (const flag of AFK_SPAWN_FLAGS) expect(plan?.spawnArgv).toContain(flag);
    expect(plan?.spawnArgv).toContain('--permission-mode');
    expect(plan?.spawnArgv).toContain('--allowedTools');
  });

  it('isolates AFK links from user-level settings via --setting-sources', () => {
    const plan = planSpawnNext(chain, '/omc-root');
    const sourcesIdx = plan?.spawnArgv.indexOf('--setting-sources');
    expect(sourcesIdx).toBeGreaterThan(-1);
    expect(plan?.spawnArgv[sourcesIdx! + 1]).toBe('project,local');
    const linkArgv = factoryLinkArgv('prompt', 'sess-9');
    expect(linkArgv).toContain('--setting-sources');
    expect(linkArgv[linkArgv.indexOf('--setting-sources') + 1]).toBe('project,local');
  });

  it('rejects a chain with a path-traversal session id before planning', () => {
    const { spawnFn, calls } = spawnRecording();
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'spawn-next-'));
    try {
      expect(() => executeSpawnNext({ ...chain, sessionId: '../evil' }, directory, spawnFn)).toThrow(/Invalid session ID/);
      expect(calls).toEqual([]);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('rejects a chain whose tracker repo or label carries shell metacharacters', () => {
    expect(() => planSpawnNext({ ...chain, tracker: { ...chain.tracker!, repo: 'owner/repo; rm -rf /' } }, '/omc-root')).toThrow(/invalid tracker repo/);
    expect(() => planSpawnNext({ ...chain, tracker: { ...chain.tracker!, nextLabel: 'a b; touch /tmp/x' } }, '/omc-root')).toThrow(/invalid tracker label/);
  });

  it('rejects a chain whose visits carry an invalid stage or count', () => {
    expect(() => planSpawnNext({ ...chain, visits: { '../evil': 1 } }, '/omc-root')).toThrow(/invalid visits entry/);
    expect(() => planSpawnNext({ ...chain, visits: { launch: 1.5 } }, '/omc-root')).toThrow(/invalid visits entry/);
    expect(() => planSpawnNext({ ...chain, visits: { launch: 100 } }, '/omc-root')).toThrow(/invalid visits entry/);
  });
});

describe('spawnNextAlertComment', () => {
  it('names the failing outcome and reason with no-retry semantics', () => {
    const comment = spawnNextAlertComment(chain);
    expect(comment).toContain('success:clear');
    expect(comment).toContain('无自动重试');
  });
});

describe('executeSpawnNext', () => {
  it('writes the handoff file, the next-link ledger, and spawns the next session plus tracker writebacks', () => {
    const { spawnFn, calls, ctxs } = spawnRecording();
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'spawn-next-'));
    execFileSync('git', ['init', '--quiet'], { cwd: directory, stdio: 'ignore' });
    try {
      executeSpawnNext(chain, directory, spawnFn);
      const handoffPath = path.join(directory, '.omc', 'handoffs', 'sess-1-launch.json');
      const handoff = JSON.parse(fs.readFileSync(handoffPath, 'utf8')) as { sessionId: string; next: unknown; context: string };
      expect(handoff.sessionId).toBe('sess-1');
      expect(handoff.next).toEqual({ stage: 'launch', skill: 'launch' });
      expect(handoff.context).toBe('context body');
      const factoryDir = path.join(directory, '.omc', 'state', 'factory');
      const ledgerFiles = fs.readdirSync(factoryDir).filter((f) => f.startsWith('chain-') && f.endsWith('.json'));
      expect(ledgerFiles).toHaveLength(1);
      const ledger = JSON.parse(fs.readFileSync(path.join(factoryDir, ledgerFiles[0]), 'utf8')) as { intentId: string; stage: string; routeTable: unknown };
      expect(ledger.intentId).toBe('chain-sess-1');
      expect(ledger.stage).toBe('launch');
      expect(ledger.routeTable).toEqual(chain.routeTable);
      const claudeCall = calls.find(([command]) => command === 'claude');
      expect(claudeCall).toBeDefined();
      expect(claudeCall?.[1]).toContain('--session-id');
      const claudeIdx = calls.findIndex(([command]) => command === 'claude');
      expect(ctxs[claudeIdx]).toEqual({ cwd: directory });
      expect(calls.filter(([command]) => command === 'gh')).toHaveLength(2);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('does nothing when the route misses', () => {
    const { spawnFn, calls } = spawnRecording();
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'spawn-next-'));
    execFileSync('git', ['init', '--quiet'], { cwd: directory, stdio: 'ignore' });
    try {
      executeSpawnNext({ ...chain, outcome: 'failed' as const }, directory, spawnFn);
      expect(fs.existsSync(path.join(directory, '.omc'))).toBe(false);
      expect(calls).toEqual([]);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('carries a chain intentId into the next-link ledger', () => {
    const { spawnFn } = spawnRecording();
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'spawn-next-'));
    execFileSync('git', ['init', '--quiet'], { cwd: directory, stdio: 'ignore' });
    try {
      executeSpawnNext({ ...chain, intentId: 'demo#7' }, directory, spawnFn);
      const factoryDir = path.join(directory, '.omc', 'state', 'factory');
      const ledgerFile = fs.readdirSync(factoryDir).find((f) => f.startsWith('chain-') && f.endsWith('.json'));
      const ledger = JSON.parse(fs.readFileSync(path.join(factoryDir, ledgerFile!), 'utf8')) as { intentId: string };
      expect(ledger.intentId).toBe('demo#7');
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('writes incremented stage visits into the next-link ledger', () => {
    const { spawnFn } = spawnRecording();
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'spawn-next-'));
    execFileSync('git', ['init', '--quiet'], { cwd: directory, stdio: 'ignore' });
    try {
      executeSpawnNext({ ...chain, visits: { launch: 1 } }, directory, spawnFn);
      const factoryDir = path.join(directory, '.omc', 'state', 'factory');
      const ledgerFile = fs.readdirSync(factoryDir).find((f) => f.startsWith('chain-') && f.endsWith('.json'));
      const ledger = JSON.parse(fs.readFileSync(path.join(factoryDir, ledgerFile!), 'utf8')) as { visits?: Record<string, number> };
      expect(ledger.visits).toEqual({ launch: 2 });
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('alerts the tracker and rethrows when spawning the next session fails', () => {
    const calls = sessions();
    const failingSpawn: SpawnFn = (command, args) => {
      if (command === 'claude') throw new Error('spawn-failure');
      calls.push([command, args]);
      return { unref() {} };
    };
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'spawn-next-'));
    execFileSync('git', ['init', '--quiet'], { cwd: directory, stdio: 'ignore' });
    try {
      expect(() => executeSpawnNext(chain, directory, failingSpawn)).toThrow('spawn-failure');
      const ghCalls = calls.filter(([command]) => command === 'gh');
      expect(ghCalls).toHaveLength(2);
      const comment = ghCalls.find(([, args]) => args.includes('comment'));
      expect(comment?.[1].join(' ')).toContain('--body');
      expect(comment?.[1].join(' ')).toContain('无自动重试');
      const label = ghCalls.find(([, args]) => args.includes('edit'));
      expect(label?.[1].join(' ')).toContain('failed');
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe('factoryLinkArgv', () => {
  it('keeps the prompt right after -p and appends the AFK profile at the tail', () => {
    const argv = factoryLinkArgv('/intent 处理进货：<url>。', 'sess-9');
    expect(argv[0]).toBe('-p');
    expect(argv[1]).toBe('/intent 处理进货：<url>。');
    expect(argv[2]).toBe('--session-id');
    expect(argv[3]).toBe('sess-9');
    expect(argv.slice(4)).toEqual(AFK_SPAWN_FLAGS);
  });
});

describe('AFK_ALLOWED_TOOLS security', () => {
  it('does not allow arbitrary gh api calls (privilege escalation vector)', () => {
    const tools = AFK_SPAWN_FLAGS[AFK_SPAWN_FLAGS.indexOf('--allowedTools') + 1];
    const entries = tools.split(',');
    expect(tools).not.toContain('gh api');
    // No unrestricted shell: every Bash entry must be scoped to a gh subcommand.
    expect(entries).not.toContain('Bash');
    for (const entry of entries.filter((e) => e.startsWith('Bash'))) {
      expect(entry).toMatch(/^Bash\(gh (issue|pr|label) [a-z]+:\*\)$/);
    }
  });
});

describe('defaultSpawnFn win32 .cmd shim routing', () => {
  const originalPlatform = process.platform;
  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform });
    vi.mocked(childProcess.spawn).mockClear();
  });

  it('routes gh through cmd.exe on win32 so the .cmd shim resolves (B4: tracker writeback)', () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    defaultSpawnFn('gh', ['issue', 'edit', '42', '--repo', 'owner/repo', '--add-label', 'in-launch']);
    expect(childProcess.spawn).toHaveBeenCalledTimes(1);
    const [command, argv, opts] = vi.mocked(childProcess.spawn).mock.calls[0];
    expect(command).toBe('cmd.exe');
    expect(argv?.[0]).toBe('/d');
    expect(argv?.[1]).toBe('/s');
    expect(argv?.[2]).toBe('/c');
    // quoteForCmd from tmux-utils only quotes args that need it (with special chars).
    // Arguments like issue, edit, 42, owner/repo, in-launch don't have special chars,
    // so they appear unquoted in the command line (wrapped in outer quotes for the whole command).
    expect(argv?.[3]).toContain('gh');
    expect(argv?.[3]).toContain('issue');
    expect(argv?.[3]).toContain('edit');
    expect(argv?.[3]).toContain('42');
    expect(opts).toMatchObject({ stdio: 'ignore', windowsVerbatimArguments: true });
  });

  it('routes claude through cmd.exe unchanged (regression guard)', () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    defaultSpawnFn('claude', ['-p', '继续 launch 环', '--session-id', 'sess-9']);
    const [command, , opts] = vi.mocked(childProcess.spawn).mock.calls[0];
    expect(command).toBe('cmd.exe');
    expect(opts).toMatchObject({ stdio: ['pipe', 'ignore', 'ignore'], windowsVerbatimArguments: true });
  });

  it('spawns other commands directly on win32 (no shell wrapping)', () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    defaultSpawnFn('node', ['script.js']);
    expect(childProcess.spawn).toHaveBeenCalledWith('node', ['script.js'], expect.objectContaining({ stdio: 'ignore' }));
  });

  it('spawns gh directly off-win32 with detached semantics', () => {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    defaultSpawnFn('gh', ['issue', 'view', '1']);
    expect(childProcess.spawn).toHaveBeenCalledWith('gh', ['issue', 'view', '1'], expect.objectContaining({ detached: true, stdio: 'ignore' }));
  });

  describe('gh --body stdin routing (command injection prevention)', () => {
    it('detects gh --body argument and routes body text through stdin via --body-file -', () => {
      Object.defineProperty(process, 'platform', { value: 'win32' });
      vi.mocked(childProcess.spawn).mockImplementation(() => ({ unref: vi.fn(), stdin: { write: vi.fn(), end: vi.fn() } } as any));
      defaultSpawnFn('gh', ['issue', 'comment', '42', '--repo', 'owner/repo', '--body', 'comment text']);
      const [command, cmdArgs] = vi.mocked(childProcess.spawn).mock.calls[0];
      expect(command).toBe('cmd.exe');
      // --body should be replaced with --body-file -
      const cmdLine = cmdArgs?.[3] ?? '';
      expect(cmdLine).toContain('--body-file');
      expect(cmdLine).toContain('-');
      expect(cmdLine).not.toContain('"comment text"');
      // The spawn should have pipe stdin
      const opts = vi.mocked(childProcess.spawn).mock.calls[0][2];
      expect(opts?.stdio).toEqual(['pipe', 'ignore', 'ignore']);
      // stdin.write should be called with the body text
      const child = vi.mocked(childProcess.spawn).mock.results[0].value;
      expect(child.stdin?.write).toHaveBeenCalledWith('comment text', 'utf8');
      expect(child.stdin?.end).toHaveBeenCalled();
    });

    it('neutralizes command injection attempt with embedded quotes in an argument', () => {
      Object.defineProperty(process, 'platform', { value: 'win32' });
      defaultSpawnFn('gh', ['issue', 'edit', '42', '--repo', 'owner/repo', '--body', '"&calc&"']);
      const [, cmdArgs] = vi.mocked(childProcess.spawn).mock.calls[0];
      const cmdLine = cmdArgs?.[3] ?? '';
      // The body text should NOT appear in argv at all; only --body-file - should be there
      expect(cmdLine).not.toContain('calc');
      expect(cmdLine).toContain('--body-file');
    });

    it('neutralizes environment variable expansion attempt in --body via stdin routing', () => {
      Object.defineProperty(process, 'platform', { value: 'win32' });
      vi.mocked(childProcess.spawn).mockImplementation(() => ({ unref: vi.fn(), stdin: { write: vi.fn(), end: vi.fn() } } as any));
      const bodyWithEnvVar = 'secret: %PATH%';
      defaultSpawnFn('gh', ['issue', 'comment', '1', '--repo', 'o/r', '--body', bodyWithEnvVar]);
      const cmdArgs = vi.mocked(childProcess.spawn).mock.calls[0][1];
      const cmdLine = cmdArgs?.[3] ?? '';
      // %PATH% should not be in the command line; body goes to stdin
      expect(cmdLine).not.toContain('%PATH%');
      expect(cmdLine).not.toContain('PATH');
      // stdin.write should be called with the unmodified body (cmd.exe won't expand it there)
      const child = vi.mocked(childProcess.spawn).mock.results[0].value;
      expect(child.stdin?.write).toHaveBeenCalledWith(bodyWithEnvVar, 'utf8');
    });

    it('handles gh commands with --body in the middle of other arguments', () => {
      Object.defineProperty(process, 'platform', { value: 'win32' });
      vi.mocked(childProcess.spawn).mockImplementation(() => ({ unref: vi.fn(), stdin: { write: vi.fn(), end: vi.fn() } } as any));
      defaultSpawnFn('gh', ['issue', 'comment', '42', '--body', 'my comment', '--repo', 'owner/repo']);
      const [, cmdArgs] = vi.mocked(childProcess.spawn).mock.calls[0];
      const cmdLine = cmdArgs?.[3] ?? '';
      expect(cmdLine).toContain('--body-file');
      expect(cmdLine).toContain('owner/repo');
      expect(cmdLine).not.toContain('my comment');
    });

    it('handles gh commands without --body normally (no stdin routing)', () => {
      Object.defineProperty(process, 'platform', { value: 'win32' });
      defaultSpawnFn('gh', ['issue', 'view', '42', '--repo', 'owner/repo']);
      const [, cmdArgs, opts] = vi.mocked(childProcess.spawn).mock.calls[0];
      const cmdLine = cmdArgs?.[3] ?? '';
      expect(cmdLine).toContain('issue');
      expect(cmdLine).toContain('view');
      // Should not have pipe stdin when there's no --body
      expect(opts?.stdio).toBe('ignore');
    });

    it('applies correct cmd.exe quoting to remaining arguments (double quotes and percents)', () => {
      Object.defineProperty(process, 'platform', { value: 'win32' });
      // An arg with a quote and a percent should be properly quoted with both escaped
      defaultSpawnFn('gh', ['issue', 'comment', '42', '--body', 'body', '--repo', 'o/"r%e"po']);
      const [, cmdArgs] = vi.mocked(childProcess.spawn).mock.calls[0];
      const cmdLine = cmdArgs?.[3] ?? '';
      // Quotes should be doubled: " -> ""
      // Percents should be doubled: % -> %%
      expect(cmdLine).toContain('""');
      expect(cmdLine).toContain('%%');
    });
  });
});
