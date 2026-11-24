/**
 * Plan write guard of scripts/pre-tool-enforcer.mjs (OMC_PLANNER_WRITE_GUARD=1).
 * Every hook run gets its own temporary home, state and log directories.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { isAbsolute, join, relative, resolve, sep } from 'path';
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
function hookEnv(extra = {}) {
    const base = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(OMC_|TYPESAFE_|CLAUDE|ANTHROPIC_|DISABLE_OMC|CODEX)/i.test(key)));
    const env = {
        ...base,
        HOME: homeDir,
        USERPROFILE: homeDir,
        CLAUDE_CONFIG_DIR: join(homeDir, '.claude'),
        OMC_STATE_DIR: stateDir,
        OMC_JEV_LOG_DIR: logDir,
        OMC_JEV_QUIET: '1',
    };
    for (const [key, value] of Object.entries(extra)) {
        if (value === undefined)
            delete env[key];
        else
            env[key] = value;
    }
    return env;
}
function runHook(input, extra = {}) {
    return spawnSync(process.execPath, [SCRIPT_PATH], {
        input,
        env: hookEnv(extra),
        encoding: 'utf8',
        timeout: 60000,
        windowsHide: true,
    });
}
function callTool(tool, path, options = {}) {
    const { agentType = PLANNER, guard = '1', extraEnv = {}, field, input, extra = {} } = options;
    const key = field ?? (tool === 'NotebookEdit' ? 'notebook_path' : 'file_path');
    const payload = {
        hook_event_name: 'PreToolUse',
        tool_name: tool,
        tool_input: input ?? { [key]: path },
        session_id: 'ses-plan-write',
        tool_use_id: `t-${Math.random().toString(36).slice(2, 8)}`,
        cwd: projectDir,
    };
    if (agentType !== null) {
        payload.agent_id = 'agent-1';
        payload.agent_type = agentType;
    }
    return runHook(JSON.stringify({ ...payload, ...extra }), {
        ...extraEnv,
        OMC_PLANNER_WRITE_GUARD: guard === null ? undefined : guard,
    });
}
function parseOutput(result) {
    const text = result.stdout.trim();
    if (!text)
        return null;
    try {
        return JSON.parse(text);
    }
    catch {
        return JSON.parse(text.split('\n').filter(Boolean).pop() ?? 'null');
    }
}
function verdictOf(result) {
    expect(result.status, result.stderr).toBe(0);
    return parseOutput(result)?.hookSpecificOutput?.permissionDecision === 'deny' ? 'deny' : 'allow';
}
function reasonOf(result) {
    return parseOutput(result)?.hookSpecificOutput?.permissionDecisionReason;
}
function logRows() {
    if (!existsSync(logPath))
        return [];
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
        const cases = [
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
        const cases = [
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
        expect(verdictOf(callTool('Write', 'src/a.js', { agentType: PLANNER, extraEnv: { OMC_PLANNER_WRITE_GUARD_TYPES: ' , ' } })), 'an empty list falls back to the default').toBe('deny');
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
        expect(verdictOf(runHook(JSON.stringify({ ...base, tool_name: 'Write', tool_input: { file_path: 42 } }), guard)), 'path is not a string').toBe('allow');
        expect(verdictOf(runHook(JSON.stringify({ ...base, tool_name: 'Write', tool_input: { file_path: '  ' } }), guard)), 'blank path').toBe('allow');
        expect(verdictOf(runHook(JSON.stringify({ ...base, tool_name: 'Write', tool_input: { file_path: 'src/a.js' }, agent_type: 7 }), guard)), 'agent_type is not a string').toBe('allow');
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
            writeFileSync(join(plans(), 'walk-file.md'), 'plan\n');
            symlinkSync('walk-loop', join(plans(), 'walk-loop'));
        });
        it('denies a link followed by .. that leads out of the plans directory', () => {
            const cases = [
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
        it('denies a path that cannot be resolved: a file used as a directory, and a link that loops', () => {
            for (const path of ['.omc/plans/walk-file.md/x.md', '.omc/plans/walk-loop/x.md']) {
                expect(verdictOf(callTool('Write', path)), path).toBe('deny');
            }
            expect(verdictOf(callTool('Write', '.omc/plans/walk-file.md')), 'the file itself').toBe('allow');
        });
        it('allows .. after a real directory or after a link that stays inside the plans directory', () => {
            const cases = [
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
    // The tool follows a link in the last component too, so the entry it opens can be another file than the one the text names.
    // The guard follows the last component one link at a time, and every entry of the chain must be a Markdown path inside the
    // real plans directory; the entry that ends the chain must be a regular file, or must not exist when no link is on the way.
    describe('a final component that is a link', () => {
        const plans = () => join(projectDir, '.omc', 'plans');
        const outside = () => join(tmp, 'entry-outside');
        const stateFile = () => join(plans(), 'state.json');
        beforeAll(() => {
            mkdirSync(outside(), { recursive: true });
            mkdirSync(join(plans(), 'entry-real-dir', 'deep'), { recursive: true });
            mkdirSync(join(plans(), 'entry-dir.md'), { recursive: true });
            writeFileSync(stateFile(), '{}\n');
            writeFileSync(join(plans(), 'entry-real.md'), 'plan\n');
            writeFileSync(join(plans(), 'entry-upper.MD'), 'plan\n');
            writeFileSync(join(outside(), 'entry-out.md'), 'plan\n');
            symlinkSync(stateFile(), join(plans(), 'alias-abs.md'));
            symlinkSync('state.json', join(plans(), 'alias-rel.md'));
            symlinkSync('state.json', join(plans(), 'chain-b.md'));
            symlinkSync('chain-b.md', join(plans(), 'chain-a.md'));
            symlinkSync('entry-real.md', join(plans(), 'chain-ok-b.md'));
            symlinkSync('chain-ok-b.md', join(plans(), 'chain-ok-a.md'));
            symlinkSync(join(plans(), 'entry-real.md'), join(outside(), 'hop.md'));
            symlinkSync(join(outside(), 'hop.md'), join(plans(), 'chain-out.md'));
            symlinkSync(plans(), join(plans(), 'to-plans.md'), 'dir');
            symlinkSync(join(plans(), 'entry-real-dir'), join(plans(), 'to-dir.md'), 'dir');
            symlinkSync(join(plans(), 'entry-dir.md'), join(plans(), 'to-md-dir.md'), 'dir');
            symlinkSync(join(plans(), 'entry-missing.md'), join(plans(), 'dangling-in.md'));
            symlinkSync(join(outside(), 'entry-missing.md'), join(plans(), 'dangling-out.md'));
            symlinkSync('entry-real.md', join(plans(), 'to-real.md'));
            symlinkSync(join(plans(), 'entry-real.md'), join(plans(), 'to-real-abs.md'));
            symlinkSync(join(outside(), 'entry-out.md'), join(plans(), 'to-out.md'));
            symlinkSync('entry-upper.MD', join(plans(), 'to-upper.md'));
            symlinkSync('entry-loop.md', join(plans(), 'entry-loop.md'));
            symlinkSync('entry-loop-b.md', join(plans(), 'entry-loop-a.md'));
            symlinkSync('entry-loop-a.md', join(plans(), 'entry-loop-b.md'));
            symlinkSync(join(plans(), 'entry-real-dir', 'deep'), join(plans(), 'entry-inner'), 'dir');
            symlinkSync(stateFile(), join(plans(), 'entry-real-dir', 'trap.md'));
            writeFileSync(join(plans(), 'entry-real-dir', 'good.md'), 'plan\n');
            symlinkSync('state.json', join(plans(), 'good.md'));
            symlinkSync(outside(), join(plans(), 'entry-out-dir'), 'dir');
            symlinkSync('entry-out-dir/../victim.md', join(plans(), 'via-link.md'));
            symlinkSync('entry-real-dir/../entry-real.md', join(plans(), 'via-dir.md'));
        });
        it('denies a link to a file that is not Markdown, whatever the tool and the way the link is written', () => {
            const cases = [
                ['Write', '.omc/plans/alias-abs.md'],
                ['Edit', '.omc/plans/alias-abs.md'],
                ['MultiEdit', '.omc/plans/alias-rel.md'],
                ['NotebookEdit', '.omc/plans/alias-rel.md'],
                ['Write', `${projectDir}/.omc/plans/alias-rel.md`],
                ['Write', './.omc/plans/../plans/alias-rel.md'],
                ['Write', '.omc/plans/entry-real-dir/../alias-rel.md'],
            ];
            for (const [tool, path] of cases) {
                expect(verdictOf(callTool(tool, path)), `${tool} ${path}`).toBe('deny');
            }
        });
        it('denies a chain of links that ends in a file that is not Markdown, and one that leaves the plans directory on the way', () => {
            for (const path of ['.omc/plans/chain-a.md', '.omc/plans/chain-b.md', '.omc/plans/chain-out.md']) {
                expect(verdictOf(callTool('Write', path)), path).toBe('deny');
            }
        });
        it('allows a link, and a chain of links, that ends in a Markdown file inside the plans directory', () => {
            for (const path of [
                '.omc/plans/to-real.md',
                '.omc/plans/to-real-abs.md',
                '.omc/plans/chain-ok-a.md',
                '.omc/plans/chain-ok-b.md',
                '.omc/plans/via-dir.md',
                `${projectDir}/.omc/plans/to-real.md`,
            ]) {
                expect(verdictOf(callTool('Edit', path)), path).toBe('allow');
            }
        });
        it('denies a link that leads to the plans directory, to another directory, or to a directory named like a Markdown file', () => {
            for (const path of ['.omc/plans/to-plans.md', '.omc/plans/to-dir.md', '.omc/plans/to-md-dir.md']) {
                expect(verdictOf(callTool('Write', path)), path).toBe('deny');
            }
        });
        it('denies a directory named like a Markdown file', () => {
            expect(verdictOf(callTool('Write', '.omc/plans/entry-dir.md'))).toBe('deny');
        });
        it('denies a link that cannot be resolved, inside the plans directory or outside it, and links that loop', () => {
            for (const path of [
                '.omc/plans/dangling-in.md',
                '.omc/plans/dangling-out.md',
                '.omc/plans/entry-loop.md',
                '.omc/plans/entry-loop-a.md',
            ]) {
                expect(verdictOf(callTool('Write', path)), path).toBe('deny');
            }
        });
        it('denies a link to a Markdown file outside the plans directory, also when the link text goes through a directory link', () => {
            for (const path of ['.omc/plans/to-out.md', '.omc/plans/via-link.md']) {
                expect(verdictOf(callTool('Write', path)), path).toBe('deny');
            }
        });
        it('denies a file that is not Markdown written directly, and an extension of another case, also through a link', () => {
            for (const path of ['.omc/plans/state.json', '.omc/plans/x.MD', '.omc/plans/entry-upper.MD', '.omc/plans/to-upper.md']) {
                expect(verdictOf(callTool('Write', path)), path).toBe('deny');
            }
        });
        it('denies a path whose text names one entry and whose route through a directory link ends on a link to a file that is not Markdown', () => {
            // .omc/plans/entry-inner is a link to .omc/plans/entry-real-dir/deep, so entry-inner/../trap.md is
            // .omc/plans/entry-real-dir/trap.md, a link to state.json, while the normalized text names .omc/plans/trap.md.
            expect(verdictOf(callTool('Write', '.omc/plans/entry-inner/../trap.md'))).toBe('deny');
            writeFileSync(join(plans(), 'trap.md'), 'plan\n');
            expect(verdictOf(callTool('Write', '.omc/plans/entry-inner/../trap.md')), 'a plain file of that name exists').toBe('deny');
            expect(verdictOf(callTool('Write', '.omc/plans/trap.md')), 'the plain file itself').toBe('allow');
        });
        it('denies a path whose route through a directory link ends on a plain file when its normalized text ends on a link to a file that is not Markdown', () => {
            // .omc/plans/entry-inner/../good.md is the plain file .omc/plans/entry-real-dir/good.md, while the normalized text
            // names .omc/plans/good.md, a link to state.json: a caller that normalizes the path before it opens it writes state.json.
            expect(verdictOf(callTool('Write', '.omc/plans/entry-inner/../good.md'))).toBe('deny');
            expect(verdictOf(callTool('Write', '.omc/plans/entry-real-dir/good.md')), 'the plain file itself').toBe('allow');
        });
        it('still allows a Markdown file that does not exist yet and a plain Markdown file', () => {
            for (const path of ['.omc/plans/entry-new.md', '.omc/plans/entry-real.md', '.omc/plans/entry-real-dir/new.md']) {
                expect(verdictOf(callTool('Write', path)), path).toBe('allow');
            }
        });
        it('logs the denial of a link to a file that is not Markdown', () => {
            const before = logRows().length;
            callTool('Write', '.omc/plans/alias-abs.md');
            const added = logRows().slice(before);
            expect(added.map((row) => [row.decision, row.path])).toEqual([['deny', '.omc/plans/alias-abs.md']]);
        });
    });
    // The guard does not decide from one field and let the tool act on another: every text among file_path, filePath,
    // notebook_path, path and file must pass, and a field that is empty or not a text is left out.
    describe('the path fields of the tool input', () => {
        const inside = () => join(projectDir, '.omc', 'plans', 'field-plan.md');
        const outside = () => join(projectDir, 'src', 'field-code.ipynb');
        it('denies when a text field leads outside the plans directory, whichever field holds it and whatever the others hold', () => {
            const cases = [
                ['NotebookEdit', { file_path: '', notebook_path: outside() }],
                ['NotebookEdit', { file_path: 42, notebook_path: outside() }],
                ['NotebookEdit', { file_path: null, notebook_path: outside() }],
                ['NotebookEdit', { file_path: '  ', notebook_path: outside() }],
                ['NotebookEdit', { file_path: inside(), notebook_path: outside() }],
                ['NotebookEdit', { notebook_path: inside(), path: outside() }],
                ['Write', { file_path: inside(), notebook_path: outside() }],
                ['Write', { file_path: outside(), notebook_path: inside() }],
                ['Write', { file_path: '', path: outside() }],
                ['Edit', { file_path: inside(), path: outside() }],
                ['MultiEdit', { path: outside() }],
                ['Write', { file_path: inside(), filePath: outside() }],
                ['Edit', { file: outside() }],
                ['MultiEdit', { file_path: 7, notebook_path: inside(), path: outside() }],
            ];
            for (const [tool, input] of cases) {
                expect(verdictOf(callTool(tool, '', { input })), `${tool} ${JSON.stringify(input)}`).toBe('deny');
            }
        });
        it('allows when every text field leads to a Markdown file inside the plans directory, and when no field is a text', () => {
            const cases = [
                ['Write', { file_path: inside() }],
                ['Write', { file_path: inside(), path: inside() }],
                ['Write', { file_path: inside(), filePath: inside(), file: inside() }],
                ['NotebookEdit', { notebook_path: inside() }],
                ['NotebookEdit', { file_path: '', notebook_path: inside() }],
                ['Edit', { file_path: inside(), notebook_path: 5, path: '' }],
                ['Write', { file_path: 42 }],
                ['Write', { file_path: '  ', notebook_path: null }],
                ['Write', {}],
            ];
            for (const [tool, input] of cases) {
                expect(verdictOf(callTool(tool, '', { input })), `${tool} ${JSON.stringify(input)}`).toBe('allow');
            }
        });
        it('applies the link rules to every text field', () => {
            const plans = join(projectDir, '.omc', 'plans');
            writeFileSync(join(plans, 'field-state.json'), '{}\n');
            symlinkSync('field-state.json', join(plans, 'field-alias.md'));
            expect(verdictOf(callTool('NotebookEdit', '', { input: { file_path: inside(), notebook_path: join(plans, 'field-alias.md') } }))).toBe('deny');
            expect(verdictOf(callTool('Write', '', { input: { file_path: join(plans, 'field-alias.md'), path: inside() } }))).toBe('deny');
        });
        it('logs the text that was denied', () => {
            const before = logRows().length;
            callTool('NotebookEdit', '', { input: { file_path: inside(), notebook_path: outside() } });
            callTool('Write', '', { input: { file_path: inside(), path: inside() } });
            const added = logRows().slice(before);
            expect(added.map((row) => [row.decision, row.path])).toEqual([['deny', outside()], ['allow', inside()]]);
        });
    });
    // The hook input may spell its keys in snake case or in camel case (agent_type or agentType, tool_input or toolInput).
    // The guard reads both: the agent is guarded when either spelling is in the list, and every path text of either object
    // must pass. A value that is empty, not a text or not an object is left out.
    describe('the two spellings of the hook input keys', () => {
        const inside = () => join(projectDir, '.omc', 'plans', 'spelling-plan.md');
        const outside = () => join(projectDir, 'src', 'spelling-code.js');
        it('guards the agent when either spelling of agent_type is in the list', () => {
            const cases = [
                { agentType: PLANNER },
                { agent_type: PLANNER, agentType: 'other-agent' },
                { agent_type: 'other-agent', agentType: PLANNER },
                { agent_type: '', agentType: PLANNER },
                { agent_type: '  ', agentType: PLANNER },
                { agent_type: 7, agentType: PLANNER },
                { agent_type: null, agentType: PLANNER },
            ];
            for (const extra of cases) {
                const result = callTool('Write', outside(), { agentType: null, extra: { agent_id: 'agent-1', ...extra } });
                expect(verdictOf(result), JSON.stringify(extra)).toBe('deny');
            }
        });
        it('lets the call through when neither spelling is in the list or is a text', () => {
            const cases = [
                { agent_type: 'other-agent', agentType: 'another-agent' },
                { agent_type: 7, agentType: 8 },
                { agent_type: '', agentType: '' },
                {},
            ];
            for (const extra of cases) {
                const result = callTool('Write', outside(), { agentType: null, extra: { agent_id: 'agent-1', ...extra } });
                expect(verdictOf(result), JSON.stringify(extra)).toBe('allow');
            }
        });
        it('checks the path texts of both tool_input and toolInput', () => {
            const cases = [
                [{ tool_input: {}, toolInput: { file_path: outside() } }, 'deny'],
                [{ tool_input: { file_path: inside() }, toolInput: { file_path: outside() } }, 'deny'],
                [{ tool_input: { file_path: outside() }, toolInput: { file_path: inside() } }, 'deny'],
                [{ tool_input: null, toolInput: { file_path: outside() } }, 'deny'],
                [{ tool_input: [], toolInput: { notebook_path: outside() } }, 'deny'],
                [{ tool_input: 'text', toolInput: { path: outside() } }, 'deny'],
                [{ tool_input: undefined, toolInput: { file_path: outside() } }, 'deny'],
                [{ tool_input: undefined, toolInput: { file_path: inside() } }, 'allow'],
                [{ tool_input: { file_path: inside() }, toolInput: { file_path: inside() } }, 'allow'],
                [{ tool_input: { file_path: inside() }, toolInput: [] }, 'allow'],
                [{ tool_input: [], toolInput: [] }, 'allow'],
                [{ tool_input: undefined }, 'allow'],
            ];
            for (const [extra, expected] of cases) {
                expect(verdictOf(callTool('Write', '', { extra })), JSON.stringify(extra)).toBe(expected);
            }
        });
        it('logs the guarded type and the text that was denied', () => {
            const before = logRows().length;
            callTool('Write', outside(), { agentType: null, extra: { agent_id: 'agent-1', agent_type: 'other-agent', agentType: PLANNER } });
            callTool('Write', '', { extra: { tool_input: { file_path: inside() }, toolInput: { file_path: outside() } } });
            const added = logRows().slice(before);
            expect(added.map((row) => [row.agent_type, row.decision, row.path])).toEqual([
                [PLANNER, 'deny', outside()],
                [PLANNER, 'deny', outside()],
            ]);
        });
    });
    // The guard resolves the raw path against the plans directory as the kernel reaches it, whether that directory exists or
    // not. The expected verdict comes from the file system: the write is made for real in the same tree (after the hook ran),
    // and the file must have landed inside the real plans directory, and the normalized path must name the plans directory too.
    describe('a plans directory that does not exist, or is a link, combined with links and ..', () => {
        const roots = {
            'no .omc': () => { },
            '.omc without plans': (root, cwd) => mkdirSync(join(cwd, '.omc'), { recursive: true }),
            'plans directory': (root, cwd) => mkdirSync(join(cwd, '.omc', 'plans'), { recursive: true }),
            'plans directory that is a link': (root, cwd) => {
                mkdirSync(join(cwd, '.omc'), { recursive: true });
                mkdirSync(join(root, 'real-plans'), { recursive: true });
                symlinkSync(join(root, 'real-plans'), join(cwd, '.omc', 'plans'), 'dir');
            },
            '.omc that is a link, without plans': (root, cwd) => {
                mkdirSync(join(root, 'real-omc'), { recursive: true });
                symlinkSync(join(root, 'real-omc'), join(cwd, '.omc'), 'dir');
            },
        };
        const layouts = {
            'no link': () => { },
            'link to a directory with plans beside it': (root, cwd) => {
                mkdirSync(join(root, 'out', 'nested'), { recursive: true });
                mkdirSync(join(root, 'out', '.omc', 'plans'), { recursive: true });
                symlinkSync(join(root, 'out', 'nested'), join(cwd, 'jump'), 'dir');
            },
            'link to a directory without plans beside it': (root, cwd) => {
                mkdirSync(join(root, 'out', 'nested'), { recursive: true });
                symlinkSync(join(root, 'out', 'nested'), join(cwd, 'jump'), 'dir');
            },
            'link to a deeper directory of the project': (root, cwd) => {
                mkdirSync(join(cwd, 'a', 'b'), { recursive: true });
                symlinkSync(join(cwd, 'a', 'b'), join(cwd, 'jump'), 'dir');
            },
            'link that dangles': (root, cwd) => symlinkSync(join(root, 'nowhere'), join(cwd, 'jump'), 'dir'),
        };
        const paths = [
            () => '.omc/plans/v.md',
            () => 'jump/../.omc/plans/v.md',
            (cwd) => `${cwd}/jump/../.omc/plans/v.md`,
            () => '.omc/plans/s/../v.md',
            () => '.omc/plans/jump/../v.md',
            () => 'jump/../../.omc/plans/v.md',
        ];
        function landedFiles(dir, found = []) {
            for (const entry of readdirSync(dir, { withFileTypes: true })) {
                const full = join(dir, entry.name);
                if (entry.isDirectory())
                    landedFiles(full, found);
                else if (entry.name === 'v.md')
                    found.push(full);
            }
            return found;
        }
        function kernelVerdict(root, cwd, path) {
            const write = spawnSync('sh', ['-c', 'mkdir -p -- "$(dirname -- "$1")" && : > "$1"', 'sh', path], { cwd, encoding: 'utf8' });
            if (write.status !== 0)
                return 'deny';
            const landed = landedFiles(root);
            if (landed.length !== 1 || !existsSync(join(cwd, '.omc', 'plans')))
                return 'deny';
            const plansReal = realpathSync(join(cwd, '.omc', 'plans'));
            const rel = relative(plansReal, landed[0]);
            const lexical = relative(join(cwd, '.omc', 'plans'), resolve(cwd, path));
            const lexicalInside = lexical !== '' && lexical.split(sep)[0] !== '..' && !isAbsolute(lexical);
            return rel !== '' && rel.split(sep)[0] !== '..' && !isAbsolute(rel) && lexicalInside ? 'allow' : 'deny';
        }
        for (const [rootName, buildRoot] of Object.entries(roots)) {
            it(`gives the verdict of the file system for ${rootName}, for every link layout and path`, () => {
                let allowed = 0;
                let denied = 0;
                for (const [layoutName, buildLayout] of Object.entries(layouts)) {
                    for (const [index, makePath] of paths.entries()) {
                        const root = mkdtempSync(join(tmp, 'grid-'));
                        const cwd = join(root, 'project');
                        mkdirSync(cwd, { recursive: true });
                        buildRoot(root, cwd);
                        buildLayout(root, cwd);
                        const path = makePath(cwd);
                        const verdict = verdictOf(callTool('Write', path, { extra: { cwd } }));
                        const expected = kernelVerdict(root, cwd, path);
                        expect(verdict, `${rootName} | ${layoutName} | ${path}`).toBe(expected);
                        if (verdict === 'allow')
                            allowed += 1;
                        else
                            denied += 1;
                        rmSync(root, { recursive: true, force: true });
                    }
                }
                expect(denied, 'the grid has denied cases').toBeGreaterThan(0);
                expect(allowed, 'the grid has allowed cases').toBeGreaterThan(0);
            }, 120000);
        }
        it('denies the raw path through a link when the plans directory does not exist, whichever tool and field names it', () => {
            const root = mkdtempSync(join(tmp, 'grid-'));
            const cwd = join(root, 'project');
            mkdirSync(cwd, { recursive: true });
            mkdirSync(join(root, 'out', 'nested'), { recursive: true });
            mkdirSync(join(root, 'out', '.omc', 'plans'), { recursive: true });
            symlinkSync(join(root, 'out', 'nested'), join(cwd, 'jump'), 'dir');
            for (const tool of ['Write', 'Edit', 'MultiEdit', 'NotebookEdit']) {
                expect(verdictOf(callTool(tool, 'jump/../.omc/plans/victim.md', { extra: { cwd } })), tool).toBe('deny');
            }
            expect(verdictOf(callTool('Write', '', { input: { file_path: '.omc/plans/ok.md', path: 'jump/../.omc/plans/victim.md' }, extra: { cwd } }))).toBe('deny');
            expect(verdictOf(callTool('Write', '.omc/plans/new.md', { extra: { cwd } })), 'a new plan in a plans directory that does not exist yet').toBe('allow');
            rmSync(root, { recursive: true, force: true });
        });
    });
});
//# sourceMappingURL=pre-tool-enforcer-plan-write-guard.test.js.map