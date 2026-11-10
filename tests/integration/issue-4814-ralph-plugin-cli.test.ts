import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveOmcCliPrefix } from '../../src/utils/omc-cli-rendering.js';
import { ralphAfkArgv, RALPH_AFK_SESSION_COMMANDS } from '../../src/cli/commands/ralph.js';

// A plugin-only install has no `omc` on PATH. The ralph feedback gate is
// mandatory, so the skill's documented fallback must actually run: resolve the
// plugin entrypoint, create a baseline through it, and judge a later run with
// it. This drives the shipped entrypoint (`bridge/cli.cjs`) rather than
// importing `ralphVerify`, because that is what the skill tells the agent to
// execute.

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const ENTRYPOINT = join(REPO_ROOT, 'bridge', 'cli.cjs');
const tempRoots: string[] = [];

function tempProject(): string {
  const dir = mkdtempSync(join(tmpdir(), 'omc-ralph-plugin-cli-'));
  tempRoots.push(dir);
  return dir;
}

function pluginOnlyEnv(home: string): NodeJS.ProcessEnv {
  return {
    // Empty PATH: no `omc`, and no `node` either. The fixture's feedback
    // command spells the node binary out, so nothing needs PATH.
    PATH: '',
    HOME: home,
    USERPROFILE: home,
    CLAUDE_PLUGIN_ROOT: REPO_ROOT,
  };
}

function writeFixture(project: string, checkOutput: string): void {
  const command = `"${process.execPath}" check.js`;
  writeFileSync(
    join(project, 'prd.json'),
    `${JSON.stringify({
      project: 'plugin-cli-fixture',
      branchName: 'main',
      description: 'plugin-only ralph verify fixture',
      userStories: [],
      feedbackCommands: [command],
    }, null, 2)}\n`,
  );
  writeFileSync(join(project, 'check.js'), `console.log(${JSON.stringify(checkOutput)});\nprocess.exit(1);\n`);
}

function runVerify(project: string, args: string[], env: NodeJS.ProcessEnv) {
  return spawnSync(process.execPath, [ENTRYPOINT, 'ralph', 'verify', ...args], {
    cwd: project,
    env,
    encoding: 'utf8',
    timeout: 60_000,
  });
}

afterEach(() => {
  for (const dir of tempRoots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('ralph verify in a plugin-only install (issue #4814)', () => {
  it('documents the same plugin entrypoint the renderer resolves', () => {
    const env = pluginOnlyEnv(tempProject());
    const prefix = resolveOmcCliPrefix({ omcAvailable: false, env });
    expect(prefix).toBe('node "$CLAUDE_PLUGIN_ROOT"/bridge/cli.cjs');

    const skill = readFileSync(join(REPO_ROOT, 'skills', 'ralph', 'SKILL.md'), 'utf8');
    expect(skill).toContain('node "$CLAUDE_PLUGIN_ROOT"/bridge/cli.cjs');
  });

  it('creates a baseline and judges later runs with omc absent from PATH', () => {
    const project = tempProject();
    const env = pluginOnlyEnv(project);
    const session = 'plugin-cli-session';

    // Precondition: `omc` really is unreachable in this environment.
    const omcProbe = spawnSync('omc', ['--version'], { env, encoding: 'utf8' });
    expect(omcProbe.error && 'code' in omcProbe.error ? omcProbe.error.code : undefined).toBe('ENOENT');

    writeFixture(project, 'FAIL env-specific baseline failure');
    const baselineRun = runVerify(project, ['--write-baseline', '--session', session], env);
    expect(baselineRun.status).toBe(0);
    const baselinePath = /baseline recorded at (.+)$/m.exec(baselineRun.stdout ?? '')?.[1]?.trim();
    expect(baselinePath).toBeTruthy();
    expect(baselinePath && existsSync(baselinePath)).toBe(true);

    // Same failure: environment noise, not a regression.
    const cleanRun = runVerify(project, ['--session', session], env);
    expect(cleanRun.status).toBe(0);
    expect(cleanRun.stdout).toContain('clean vs baseline');

    // A different failure is a real regression.
    writeFixture(project, 'FAIL brand new regression');
    const regressionRun = runVerify(project, ['--session', session], env);
    expect(regressionRun.status).toBe(1);
    expect(regressionRun.stdout).toContain('NEW failure');
  });
});

describe('ralph AFK preflight uses the granted CLI form (issue #4814 follow-up)', () => {
  it('tells AFK sessions to use the one form the launcher grants, without a probe', () => {
    // The launcher grants only the bare form; a discovery probe is not on the
    // list and is denied in headless mode, which would block the gate before
    // its first permitted call.
    const argv = ralphAfkArgv('task', [], 'afk-session');
    const allowedTools = argv[argv.indexOf('--allowedTools') + 1];
    for (const grant of RALPH_AFK_SESSION_COMMANDS) expect(allowedTools).toContain(grant);

    const skill = readFileSync(join(REPO_ROOT, 'skills', 'ralph', 'SKILL.md'), 'utf8');
    expect(skill).toContain('OMC_RALPH_AFK_FEEDBACK');
    expect(skill).toContain('Bash(omc ralph verify:*)');
    expect(skill).not.toContain('command -v');
    // The non-AFK plugin-only fallback stays documented.
    expect(skill).toContain('node "$CLAUDE_PLUGIN_ROOT"/bridge/cli.cjs');
  });
});
