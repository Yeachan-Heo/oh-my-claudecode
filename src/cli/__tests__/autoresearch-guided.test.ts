import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseSandboxContract } from '../../autoresearch/contracts.js';

const { tmuxAvailableMock, buildTmuxShellCommandMock, wrapWithLoginShellMock, quoteShellArgMock } = vi.hoisted(() => ({
  tmuxAvailableMock: vi.fn(),
  buildTmuxShellCommandMock: vi.fn((cmd: string, args: string[]) => `${cmd} ${args.join(' ')}`),
  wrapWithLoginShellMock: vi.fn((cmd: string) => `wrapped:${cmd}`),
  quoteShellArgMock: vi.fn((value: string) => `'${value}'`),
}));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    execFileSync: vi.fn(),
  };
});

vi.mock('../tmux-utils.js', () => ({
  isTmuxAvailable: tmuxAvailableMock,
  buildTmuxShellCommand: buildTmuxShellCommandMock,
  wrapWithLoginShell: wrapWithLoginShellMock,
  quoteShellArg: quoteShellArgMock,
}));

import {
  buildAutoresearchSetupSlashCommand,
  checkTmuxAvailable,
  guidedAutoresearchSetup,
  guidedAutoresearchSetupInference,
  initAutoresearchMission,
  parseInitArgs,
  prepareAutoresearchSetupCodexHome,
  runAutoresearchNoviceBridge,
  spawnAutoresearchSetupTmux,
  spawnAutoresearchTmux,
  type AutoresearchQuestionIO,
} from '../autoresearch-guided.js';

async function initRepo(): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), 'omc-autoresearch-guided-test-'));
  execFileSync('git', ['init'], { cwd, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'Test User'], { cwd, stdio: 'ignore' });
  await writeFile(join(cwd, 'README.md'), 'hello\n', 'utf-8');
  execFileSync('git', ['add', 'README.md'], { cwd, stdio: 'ignore' });
  execFileSync('git', ['commit', '-m', 'init'], { cwd, stdio: 'ignore' });
  return cwd;
}

function withMockedTty<T>(fn: () => Promise<T>): Promise<T> {
  const descriptor = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
  Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: true });
  return fn().finally(() => {
    if (descriptor) {
      Object.defineProperty(process.stdin, 'isTTY', descriptor);
    } else {
      Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: false });
    }
  });
}

function makeFakeIo(answers: string[]): AutoresearchQuestionIO {
  const queue = [...answers];
  return {
    async question(): Promise<string> {
      return queue.shift() ?? '';
    },
    close(): void {},
  };
}

describe('initAutoresearchMission', () => {
  it('creates mission.md with correct content', async () => {
    const repo = await initRepo();
    try {
      const result = await initAutoresearchMission({
        topic: 'Improve test coverage for the auth module',
        evaluatorCommand: 'node scripts/eval.js',
        keepPolicy: 'score_improvement',
        slug: 'auth-coverage',
        repoRoot: repo,
      });

      expect(result.slug).toBe('auth-coverage');
      expect(result.missionDir).toBe(join(repo, 'missions', 'auth-coverage'));

      const missionContent = await readFile(join(result.missionDir, 'mission.md'), 'utf-8');
      expect(missionContent).toMatch(/# Mission/);
      expect(missionContent).toMatch(/Improve test coverage for the auth module/);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('creates sandbox.md with valid YAML frontmatter', async () => {
    const repo = await initRepo();
    try {
      const result = await initAutoresearchMission({
        topic: 'Optimize database queries',
        evaluatorCommand: 'node scripts/eval-perf.js',
        keepPolicy: 'pass_only',
        slug: 'db-perf',
        repoRoot: repo,
      });

      const sandboxContent = await readFile(join(result.missionDir, 'sandbox.md'), 'utf-8');
      expect(sandboxContent).toMatch(/^---\n/);
      expect(sandboxContent).toMatch(/evaluator:/);
      expect(sandboxContent).toMatch(/command: node scripts\/eval-perf\.js/);
      expect(sandboxContent).toMatch(/format: json/);
      expect(sandboxContent).toMatch(/keep_policy: pass_only/);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('omits keep_policy when not provided', async () => {
    const repo = await initRepo();
    try {
      const result = await initAutoresearchMission({
        topic: 'Investigate flaky tests',
        evaluatorCommand: 'npm run eval',
        slug: 'flaky-tests',
        repoRoot: repo,
      });

      const sandboxContent = await readFile(join(result.missionDir, 'sandbox.md'), 'utf-8');
      expect(sandboxContent).not.toMatch(/keep_policy:/);
      const parsed = parseSandboxContract(sandboxContent);
      expect(parsed.evaluator.keep_policy).toBeUndefined();
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('generated sandbox.md passes parseSandboxContract validation', async () => {
    const repo = await initRepo();
    try {
      const result = await initAutoresearchMission({
        topic: 'Fix flaky tests',
        evaluatorCommand: 'bash run-tests.sh',
        keepPolicy: 'score_improvement',
        slug: 'flaky-tests',
        repoRoot: repo,
      });

      const sandboxContent = await readFile(join(result.missionDir, 'sandbox.md'), 'utf-8');
      const parsed = parseSandboxContract(sandboxContent);
      expect(parsed.evaluator.command).toBe('bash run-tests.sh');
      expect(parsed.evaluator.format).toBe('json');
      expect(parsed.evaluator.keep_policy).toBe('score_improvement');
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });
});

describe('parseInitArgs', () => {
  it('parses all flags with space-separated values', () => {
    const result = parseInitArgs([
      '--topic', 'my topic',
      '--evaluator', 'node eval.js',
      '--keep-policy', 'pass_only',
      '--slug', 'my-slug',
    ]);
    expect(result.topic).toBe('my topic');
    expect(result.evaluatorCommand).toBe('node eval.js');
    expect(result.keepPolicy).toBe('pass_only');
    expect(result.slug).toBe('my-slug');
  });

  it('parses all flags with = syntax', () => {
    const result = parseInitArgs([
      '--topic=my topic',
      '--eval=node eval.js',
      '--keep-policy=score_improvement',
      '--slug=my-slug',
    ]);
    expect(result.topic).toBe('my topic');
    expect(result.evaluatorCommand).toBe('node eval.js');
    expect(result.keepPolicy).toBe('score_improvement');
    expect(result.slug).toBe('my-slug');
  });
});

describe('runAutoresearchNoviceBridge', () => {
  it('loops through refine further before launching and writes draft + mission files', async () => {
    const repo = await initRepo();
    try {
      const result = await withMockedTty(() => runAutoresearchNoviceBridge(
        repo,
        {},
        makeFakeIo([
          'Improve evaluator UX',
          'Make success measurable',
          'TODO replace with evaluator command',
          'score_improvement',
          'ux-eval',
          'refine further',
          'Improve evaluator UX',
          'Passing evaluator output',
          'node scripts/eval.js',
          'pass_only',
          'ux-eval',
          'launch',
        ]),
      ));

      const draftContent = await readFile(join(repo, '.omc', 'specs', 'deep-interview-autoresearch-ux-eval.md'), 'utf-8');
      const resultContent = await readFile(join(repo, '.omc', 'specs', 'autoresearch-ux-eval', 'result.json'), 'utf-8');
      const missionContent = await readFile(join(result.missionDir, 'mission.md'), 'utf-8');
      const sandboxContent = await readFile(join(result.missionDir, 'sandbox.md'), 'utf-8');

      expect(result.slug).toBe('ux-eval');
      expect(draftContent).toMatch(/Launch-ready: yes/);
      expect(resultContent).toMatch(/"launchReady": true/);
      expect(missionContent).toMatch(/Improve evaluator UX/);
      expect(sandboxContent).toMatch(/command: node scripts\/eval\.js/);
      expect(sandboxContent).toMatch(/keep_policy: pass_only/);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });
});

describe('guidedAutoresearchSetup', () => {
  it('delegates to the novice bridge behavior', async () => {
    const repo = await initRepo();
    try {
      const result = await withMockedTty(() => guidedAutoresearchSetup(
        repo,
        { topic: 'Seeded topic', evaluatorCommand: 'node scripts/eval.js', keepPolicy: 'score_improvement', slug: 'seeded-topic' },
        makeFakeIo(['', '', '', '', '', 'launch']),
      ));

      expect(result.slug).toBe('seeded-topic');
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('loops on low-confidence inference until clarification produces a launch-ready handoff', async () => {
    const questionMock = vi.fn()
      .mockResolvedValueOnce('Improve search onboarding')
      .mockResolvedValueOnce('')
      .mockResolvedValueOnce('Use the vitest onboarding smoke test as evaluator');
    const closeMock = vi.fn();
    const createPromptInterface = vi.fn(() => ({ question: questionMock, close: closeMock }));
    const runSetupSession = vi.fn()
      .mockReturnValueOnce({
        missionText: 'Improve search onboarding',
        evaluatorCommand: 'npm run test:onboarding',
        evaluatorSource: 'inferred',
        confidence: 0.4,
        slug: 'search-onboarding',
        readyToLaunch: false,
        clarificationQuestion: 'Which script or command should prove the goal?',
      })
      .mockReturnValueOnce({
        missionText: 'Improve search onboarding',
        evaluatorCommand: 'npm run test:onboarding',
        evaluatorSource: 'inferred',
        confidence: 0.92,
        slug: 'search-onboarding',
        readyToLaunch: true,
      });

    const isTty = process.stdin.isTTY;
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });

    try {
      const repo = await initRepo();
      const result = await guidedAutoresearchSetupInference(repo, {
        createPromptInterface: createPromptInterface as never,
        runSetupSession,
      });

      expect(result.slug).toBe('search-onboarding');
      expect(runSetupSession).toHaveBeenCalledTimes(2);
      expect(closeMock).toHaveBeenCalled();
      await rm(repo, { recursive: true, force: true });
    } finally {
      Object.defineProperty(process.stdin, 'isTTY', { value: isTty, configurable: true });
    }
  });
});

describe('checkTmuxAvailable', () => {
  beforeEach(() => {
    tmuxAvailableMock.mockReset();
  });

  it('delegates to tmux-utils', () => {
    tmuxAvailableMock.mockReturnValue(true);
    expect(checkTmuxAvailable()).toBe(true);
    expect(tmuxAvailableMock).toHaveBeenCalled();
  });
});

describe('spawnAutoresearchTmux', () => {
  const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

  beforeEach(() => {
    vi.mocked(execFileSync).mockReset();
    tmuxAvailableMock.mockReset();
    buildTmuxShellCommandMock.mockClear();
    wrapWithLoginShellMock.mockClear();
    logSpy.mockClear();
  });

  afterAll(() => {
    logSpy.mockRestore();
  });

  it('throws when tmux is unavailable', () => {
    tmuxAvailableMock.mockReturnValue(false);
    expect(() => spawnAutoresearchTmux('/repo/missions/demo', 'demo')).toThrow(/background autoresearch execution/);
  });

  it('uses explicit cwd, login-shell wrapping, and verifies startup before logging success', () => {
    tmuxAvailableMock.mockReturnValue(true);
    let hasSessionCalls = 0;
    vi.mocked(execFileSync).mockImplementation((cmd, args, opts) => {
      if (cmd === 'tmux' && Array.isArray(args) && args[0] === 'has-session') {
        hasSessionCalls += 1;
        if (hasSessionCalls === 1) {
          throw new Error('missing session');
        }
        return Buffer.from('');
      }
      if (cmd === 'git') {
        expect(args).toEqual(['rev-parse', '--show-toplevel']);
        expect((opts as { cwd?: string }).cwd).toBe('/repo/missions/demo');
        return '/repo\n';
      }
      if (cmd === 'tmux' && Array.isArray(args) && args[0] === 'new-session') {
        expect(args.slice(0, 6)).toEqual(['new-session', '-d', '-s', 'omc-autoresearch-demo', '-c', '/repo']);
        expect(args[6]).toBe('wrapped:' + `${process.execPath} ${process.cwd()}/bin/omc.js autoresearch /repo/missions/demo`);
        return Buffer.from('');
      }
      throw new Error(`unexpected call: ${String(cmd)}`);
    });

    spawnAutoresearchTmux('/repo/missions/demo', 'demo');

    expect(buildTmuxShellCommandMock).toHaveBeenCalledWith(process.execPath, [expect.stringMatching(/bin\/omc\.js$/), 'autoresearch', '/repo/missions/demo']);
    expect(wrapWithLoginShellMock).toHaveBeenCalledWith(`${process.execPath} ${process.cwd()}/bin/omc.js autoresearch /repo/missions/demo`);
    expect(logSpy).toHaveBeenCalledWith('\nAutoresearch launched in background tmux session.');
    expect(logSpy).toHaveBeenCalledWith('  Attach:   tmux attach -t omc-autoresearch-demo');
  });
});

describe('prepareAutoresearchSetupCodexHome', () => {
  it('creates a temp CODEX_HOME with autoNudge disabled and symlinked skills when available', async () => {
    vi.mocked(execFileSync).mockReset();
    const repo = await initRepo();
    const originalCodexHome = process.env.CODEX_HOME;
    try {
      const baseCodexHome = join(repo, 'base-codex-home');
      await mkdir(join(baseCodexHome, 'skills'), { recursive: true });
      await writeFile(join(baseCodexHome, 'skills', 'marker.txt'), 'ok\n', 'utf-8');
      process.env.CODEX_HOME = baseCodexHome;

      const tempCodexHome = prepareAutoresearchSetupCodexHome(repo, 'setup-session');
      const configText = await readFile(join(tempCodexHome, '.omx-config.json'), 'utf-8');
      expect(JSON.parse(configText)).toEqual({ autoNudge: { enabled: false } });
      expect(await readFile(join(tempCodexHome, 'skills', 'marker.txt'), 'utf-8')).toBe('ok\n');
    } finally {
      if (originalCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = originalCodexHome;
      await rm(repo, { recursive: true, force: true });
    }
  });
});

describe('spawnAutoresearchSetupTmux', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let dateNowSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.mocked(execFileSync).mockReset();
    tmuxAvailableMock.mockReset();
    buildTmuxShellCommandMock.mockClear();
    wrapWithLoginShellMock.mockClear();
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    dateNowSpy = vi.spyOn(Date, 'now').mockReturnValue(1234567890);
  });

  afterEach(() => {
    dateNowSpy.mockRestore();
    logSpy.mockRestore();
  });

  it('launches a detached claude setup session and seeds deep-interview autoresearch mode', async () => {
    tmuxAvailableMock.mockReturnValue(true);
    const repo = await initRepo();
    let hasSessionCalls = 0;
    try {
      vi.mocked(execFileSync).mockImplementation((cmd, args) => {
        if (cmd === 'tmux' && Array.isArray(args) && args[0] === 'new-session') {
          expect(args.slice(0, 9)).toEqual([
            'new-session', '-d', '-P', '-F', '#{pane_id}', '-s', 'omc-autoresearch-setup-kf12oi', '-c', repo,
          ]);
          expect(typeof args[9]).toBe('string');
          expect(String(args[9])).toContain('wrapped:env');
          expect(String(args[9])).toContain(`CODEX_HOME=${repo}/.omx/tmp/omc-autoresearch-setup-kf12oi/codex-home`);
          expect(String(args[9])).toContain('claude');
          expect(String(args[9])).toContain('--dangerously-skip-permissions');
          return '%42\n' as never;
        }
        if (cmd === 'tmux' && Array.isArray(args) && args[0] === 'has-session') {
          hasSessionCalls += 1;
          expect(args).toEqual(['has-session', '-t', 'omc-autoresearch-setup-kf12oi']);
          return Buffer.from('');
        }
        if (cmd === 'tmux' && Array.isArray(args) && args[0] === 'send-keys') {
          return Buffer.from('');
        }
        throw new Error(`unexpected call: ${String(cmd)}`);
      });

      spawnAutoresearchSetupTmux(repo);

      expect(buildTmuxShellCommandMock).toHaveBeenCalledWith('env', [`CODEX_HOME=${repo}/.omx/tmp/omc-autoresearch-setup-kf12oi/codex-home`, 'claude', '--dangerously-skip-permissions']);
      expect(wrapWithLoginShellMock).toHaveBeenCalledWith(`env CODEX_HOME=${repo}/.omx/tmp/omc-autoresearch-setup-kf12oi/codex-home claude --dangerously-skip-permissions`);
      expect(buildAutoresearchSetupSlashCommand()).toBe('/deep-interview --autoresearch');
      expect(vi.mocked(execFileSync)).toHaveBeenCalledWith(
        'tmux',
        ['send-keys', '-t', '%42', '-l', buildAutoresearchSetupSlashCommand()],
        expect.objectContaining({ stdio: 'ignore' }),
      );
      expect(logSpy).toHaveBeenCalledWith('\nAutoresearch setup launched in background Claude session.');
      expect(logSpy).toHaveBeenCalledWith('  Attach:   tmux attach -t omc-autoresearch-setup-kf12oi');
      expect(hasSessionCalls).toBe(1);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });
});
