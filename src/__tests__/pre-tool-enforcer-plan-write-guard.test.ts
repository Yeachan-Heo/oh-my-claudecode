/**
 * Plan write guard of scripts/pre-tool-enforcer.mjs (OMC_PLANNER_WRITE_GUARD=1).
 * Every hook run gets its own temporary home, state and log directories.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.unmock('child_process');
vi.unmock('node:child_process');

import { spawnSync } from 'child_process';

const SCRIPT_PATH = join(process.cwd(), 'scripts', 'pre-tool-enforcer.mjs');
const PLANNER = 'oh-my-claudecode:planner';

let tmp = '';
let homeDir = '';
let projectDir = '';
let stateDir = '';
let logDir = '';
let logPath = '';

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), 'plan-write-guard-'));
  homeDir = join(tmp, 'home');
  projectDir = join(tmp, 'project');
  stateDir = join(tmp, 'state');
  logDir = join(tmp, 'logs');
  logPath = join(logDir, 'plan-write-guard.jsonl');
  for (const dir of [join(homeDir, '.claude'), join(projectDir, '.omc', 'plans'), stateDir, logDir]) {
    mkdirSync(dir, { recursive: true });
  }
});

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function hookEnv(extra: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  const base = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !/^(OMC_|TYPESAFE_|CLAUDE|ANTHROPIC_|DISABLE_OMC|CODEX)/i.test(key)),
  );
  const env: NodeJS.ProcessEnv = {
    ...base,
    HOME: homeDir,
    USERPROFILE: homeDir,
    CLAUDE_CONFIG_DIR: join(homeDir, '.claude'),
    OMC_STATE_DIR: stateDir,
    OMC_JEV_LOG_DIR: logDir,
    OMC_JEV_QUIET: '1',
  };
  for (const [key, value] of Object.entries(extra)) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  return env;
}

function runHook(input: string, extra: Record<string, string | undefined> = {}) {
  return spawnSync(process.execPath, [SCRIPT_PATH], {
    input,
    env: hookEnv(extra),
    encoding: 'utf8',
    timeout: 60000,
    windowsHide: true,
  });
}

interface CallOptions {
  agentType?: string | null;
  guard?: string | null;
  extraEnv?: Record<string, string>;
  field?: string;
}

function callTool(tool: string, path: string, options: CallOptions = {}) {
  const { agentType = PLANNER, guard = '1', extraEnv = {}, field } = options;
  const key = field ?? (tool === 'NotebookEdit' ? 'notebook_path' : 'file_path');
  const payload: Record<string, unknown> = {
    hook_event_name: 'PreToolUse',
    tool_name: tool,
    tool_input: { [key]: path },
    session_id: 'ses-plan-write',
    tool_use_id: `t-${Math.random().toString(36).slice(2, 8)}`,
    cwd: projectDir,
  };
  if (agentType !== null) {
    payload.agent_id = 'agent-1';
    payload.agent_type = agentType;
  }
  return runHook(JSON.stringify(payload), {
    ...extraEnv,
    OMC_PLANNER_WRITE_GUARD: guard === null ? undefined : guard,
  });
}

function parseOutput(result: ReturnType<typeof runHook>): Record<string, any> | null {
  const text = result.stdout.trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return JSON.parse(text.split('\n').filter(Boolean).pop() ?? 'null');
  }
}

function verdictOf(result: ReturnType<typeof runHook>): 'allow' | 'deny' {
  expect(result.status, result.stderr).toBe(0);
  return parseOutput(result)?.hookSpecificOutput?.permissionDecision === 'deny' ? 'deny' : 'allow';
}

function reasonOf(result: ReturnType<typeof runHook>): string {
  return parseOutput(result)?.hookSpecificOutput?.permissionDecisionReason;
}

function logRows(): Array<Record<string, any>> {
  if (!existsSync(logPath)) return [];
  return readFileSync(logPath, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

describe('plan write guard (pre-tool-enforcer.mjs)', () => {
  it('has no effect without the variable and with any value other than 1', () => {
    for (const value of [null, '', '0', 'true', 'on', '2']) {
      // null = the variable is not set
      const result = callTool('Write', join(projectDir, 'src', 'a.js'), { guard: value });
      expect(verdictOf(result), `value ${JSON.stringify(value)} must not guard`).toBe('allow');
    }
    expect(existsSync(logPath), 'a disabled guard writes no log row').toBe(false);
  });

  it('allows the planner to write Markdown files inside .omc/plans', () => {
    const cases: Array<[string, string]> = [
      ['Write', '.omc/plans/x.md'],
      ['Write', join(projectDir, '.omc', 'plans', 'x.md')],
      ['Edit', '.omc/plans/sub/dir/y.md'],
      ['MultiEdit', './.omc/plans/../plans/z.md'],
    ];
    for (const [tool, path] of cases) {
      expect(verdictOf(callTool(tool, path)), `${tool} ${path}`).toBe('allow');
    }
  });

  it('denies the planner writes outside the plans directory, for all four tools', () => {
    const cases: Array<[string, string]> = [
      ['Write', 'README.md'],
      ['Write', 'src/a.js'],
      ['Edit', join(projectDir, 'src', 'b.ts')],
      ['MultiEdit', '.omc/state/x.md'],
      ['NotebookEdit', 'analysis.ipynb'],
      ['Write', '.omc/plans-other/x.md'],
      ['Write', '.omc/plans'],
      ['Write', '/etc/hostname.md'],
    ];
    for (const [tool, path] of cases) {
      expect(verdictOf(callTool(tool, path)), `${tool} ${path}`).toBe('deny');
    }
  });

  it('denies a non-Markdown file inside the plans directory', () => {
    for (const path of ['.omc/plans/x.txt', '.omc/plans/x.md.bak', '.omc/plans/x', '.omc/plans/sub/x.json']) {
      expect(verdictOf(callTool('Write', path)), path).toBe('deny');
    }
  });

  it('denies a path with .. that leaves the plans directory and allows one that stays inside', () => {
    for (const path of ['.omc/plans/../notes.md', '.omc/plans/../../x.md', '../.omc/plans/x.md', '.omc/plans/sub/../../src/x.md']) {
      expect(verdictOf(callTool('Write', path)), path).toBe('deny');
    }
    expect(verdictOf(callTool('Write', '.omc/plans/sub/../x.md'))).toBe('allow');
  });

  it('gives a short English denial that names the plans directory and Markdown', () => {
    const text = reasonOf(callTool('Write', 'src/a.js'));
    expect(text).toMatch(/^\[PLAN WRITE GUARD\]/);
    expect(text).toMatch(/\.omc\/plans\//);
    expect(text).toMatch(/Markdown/);
    expect(text.length).toBeLessThan(300);
  });

  it('lets other agent types and the main session through', () => {
    for (const agentType of ['oh-my-claudecode:executor', 'planner', 'Explore', 'general-purpose', null, '']) {
      expect(verdictOf(callTool('Write', 'src/a.js', { agentType })), `agent_type ${agentType}`).toBe('allow');
    }
  });

  it('lets tools outside the four through for the planner', () => {
    for (const tool of ['Read', 'Bash', 'Grep']) {
      expect(verdictOf(callTool(tool, 'src/a.js')), tool).toBe('allow');
    }
  });

  it('OMC_PLANNER_WRITE_GUARD_TYPES replaces the guarded list, and an empty list falls back to the default', () => {
    const extraEnv = { OMC_PLANNER_WRITE_GUARD_TYPES: ' oh-my-claudecode:executor , custom-agent ' };
    expect(verdictOf(callTool('Write', 'src/a.js', { agentType: 'oh-my-claudecode:executor', extraEnv }))).toBe('deny');
    expect(verdictOf(callTool('Write', 'src/a.js', { agentType: 'custom-agent', extraEnv }))).toBe('deny');
    expect(verdictOf(callTool('Write', '.omc/plans/x.md', { agentType: 'custom-agent', extraEnv }))).toBe('allow');
    expect(verdictOf(callTool('Write', 'src/a.js', { agentType: PLANNER, extraEnv })), 'the list replaces the default').toBe('allow');
    expect(
      verdictOf(callTool('Write', 'src/a.js', { agentType: PLANNER, extraEnv: { OMC_PLANNER_WRITE_GUARD_TYPES: ' , ' } })),
      'an empty list falls back to the default',
    ).toBe('deny');
  });

  it('passes unreadable input (fail-open)', () => {
    const base = {
      hook_event_name: 'PreToolUse',
      session_id: 'ses-plan-write',
      cwd: projectDir,
      agent_id: 'agent-1',
      agent_type: PLANNER,
    };
    const guard = { OMC_PLANNER_WRITE_GUARD: '1' };
    expect(verdictOf(runHook('{ not json', guard)), 'broken JSON').toBe('allow');
    expect(verdictOf(runHook('', guard)), 'empty input').toBe('allow');
    expect(verdictOf(runHook(JSON.stringify({ ...base, tool_name: 'Write' }), guard)), 'no tool_input').toBe('allow');
    expect(verdictOf(runHook(JSON.stringify({ ...base, tool_name: 'Write', tool_input: [] }), guard)), 'tool_input is an array').toBe('allow');
    expect(verdictOf(runHook(JSON.stringify({ ...base, tool_name: 'Write', tool_input: {} }), guard)), 'no path').toBe('allow');
    expect(
      verdictOf(runHook(JSON.stringify({ ...base, tool_name: 'Write', tool_input: { file_path: 42 } }), guard)),
      'path is not a string',
    ).toBe('allow');
    expect(
      verdictOf(runHook(JSON.stringify({ ...base, tool_name: 'Write', tool_input: { file_path: '  ' } }), guard)),
      'blank path',
    ).toBe('allow');
    expect(
      verdictOf(runHook(JSON.stringify({ ...base, tool_name: 'Write', tool_input: { file_path: 'src/a.js' }, agent_type: 7 }), guard)),
      'agent_type is not a string',
    ).toBe('allow');
  });

  it('writes one log row per guarded call, allow and deny, and one row with a reason for an unguarded call', () => {
    const before = logRows().length;
    callTool('Write', 'src/logged.js');
    callTool('Write', '.omc/plans/logged.md');
    callTool('Write', 'src/not-logged.js', { agentType: 'oh-my-claudecode:executor' });
    const added = logRows().slice(before);
    expect(added.map((row) => row.decision)).toEqual(['deny', 'allow', 'allow']);
    expect(added[0].point).toBe('plan-write-guard');
    expect(added[0].tool_name).toBe('Write');
    expect(added[0].agent_type).toBe(PLANNER);
    expect(added[0].path).toBe('src/logged.js');
    expect(added[0].session_id).toBe('ses-plan-write');
    expect(added[0].reason).toBeUndefined();
    expect(added[2].reason).toBe('agent_type not guarded');
    expect(added[2].path).toBeUndefined();
  });

  it('writes a row with a reason when the guard is on and agent_type is missing or not guarded', () => {
    const before = logRows().length;
    callTool('Write', 'src/no-type.js', { agentType: null });
    callTool('Write', 'src/other-type.js', { agentType: 'oh-my-claudecode:executor' });
    const added = logRows().slice(before);
    expect(added.map((row) => [row.decision, row.reason])).toEqual([
      ['allow', 'no agent_type'],
      ['allow', 'agent_type not guarded'],
    ]);
    expect(added[0].agent_type).toBeNull();
    expect(added[1].agent_type).toBe('oh-my-claudecode:executor');
  });

  it('denies a write through a symbolic link inside the plans directory that leads outside it, or a link that cannot be resolved', () => {
    const outside = join(tmp, 'outside');
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, 'source.ts'), 'export {};\n');
    const plans = join(projectDir, '.omc', 'plans');
    symlinkSync(outside, join(plans, 'linked-dir'), 'dir');
    symlinkSync(join(outside, 'source.ts'), join(plans, 'linked-file.md'));
    symlinkSync(join(outside, 'missing.md'), join(plans, 'dangling.md'));
    expect(verdictOf(callTool('Write', '.omc/plans/linked-dir/new.md')), 'linked directory').toBe('deny');
    expect(verdictOf(callTool('Edit', '.omc/plans/linked-file.md')), 'linked file').toBe('deny');
    expect(verdictOf(callTool('Write', '.omc/plans/dangling.md')), 'dangling link').toBe('deny');
    expect(verdictOf(callTool('Write', '.omc/plans/linked-dir/new-sub/x.md')), 'missing directory under a linked directory').toBe('deny');
  });

  it('allows a write through a symbolic link that stays inside the plans directory', () => {
    const plans = join(projectDir, '.omc', 'plans');
    mkdirSync(join(plans, 'real-dir'), { recursive: true });
    symlinkSync(join(plans, 'real-dir'), join(plans, 'inner-link'), 'dir');
    expect(verdictOf(callTool('Write', '.omc/plans/inner-link/plan.md'))).toBe('allow');
    expect(verdictOf(callTool('Write', '.omc/plans/new-sub/plan.md')), 'missing directory inside the plans directory').toBe('allow');
  });

  // The guard walks the raw path the way the kernel does: from the working directory, a link is followed where it stands and
  // ".." then goes to the parent of the link target, not to the parent of the link.
  describe('links combined with ..', () => {
    const plans = () => join(projectDir, '.omc', 'plans');
    const outside = () => join(tmp, 'walk-outside');

    beforeAll(() => {
      mkdirSync(join(outside(), 'nested'), { recursive: true });
      mkdirSync(join(outside(), '.omc', 'plans'), { recursive: true });
      mkdirSync(join(plans(), 'walk-sub'), { recursive: true });
      mkdirSync(join(plans(), 'walk-real'), { recursive: true });
      symlinkSync(join(outside(), 'nested'), join(plans(), 'walk-link'), 'dir');
      symlinkSync(join(plans(), 'walk-real'), join(plans(), 'walk-inner'), 'dir');
      symlinkSync(join(outside(), 'nested'), join(projectDir, 'walk-jump'), 'dir');
      symlinkSync(join(plans(), 'walk-link'), join(plans(), 'walk-chain'), 'dir');
    });

    it('denies a link followed by .. that leads out of the plans directory', () => {
      const cases: Array<[string, string]> = [
        ['Edit', '.omc/plans/walk-link/../victim.md'],
        ['Write', '.omc/plans/walk-chain/../victim.md'],
        ['Write', '.omc/plans/../plans/walk-link/../victim.md'],
        ['Write', './.omc/plans/./walk-link/./../victim.md'],
        ['Write', '.omc/plans/walk-link/../../plans/victim.md'],
        ['MultiEdit', `${projectDir}/.omc/plans/walk-link/../victim.md`],
        ['NotebookEdit', '.omc/plans/walk-link/../victim.md'],
      ];
      for (const [tool, path] of cases) {
        expect(verdictOf(callTool(tool, path)), `${tool} ${path}`).toBe('deny');
      }
    });

    it('denies a link before the plans directory that is followed by ..', () => {
      for (const path of [
        'walk-jump/../.omc/plans/victim.md',
        './walk-jump/../.omc/plans/victim.md',
        `${projectDir}/walk-jump/../.omc/plans/victim.md`,
      ]) {
        expect(verdictOf(callTool('Write', path)), path).toBe('deny');
      }
      rmSync(join(outside(), '.omc'), { recursive: true, force: true });
      expect(verdictOf(callTool('Write', 'walk-jump/../.omc/plans/victim.md')), 'the outside target does not exist').toBe('deny');
    });

    it('allows .. after a real directory or after a link that stays inside the plans directory', () => {
      const cases: Array<[string, string]> = [
        ['Write', '.omc/plans/walk-sub/../x.md'],
        ['Write', './.omc/plans/../plans/z.md'],
        ['Edit', '.omc/plans/walk-inner/../x.md'],
        ['Write', '.omc/plans/walk-inner/sub/../y.md'],
        ['Write', '.omc/plans/walk-missing/../x.md'],
        ['Write', `${projectDir}/.omc/plans/walk-sub/../x.md`],
      ];
      for (const [tool, path] of cases) {
        expect(verdictOf(callTool(tool, path)), `${tool} ${path}`).toBe('allow');
      }
    });
  });
});
