import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { execFileSync } from 'child_process';
const persistentModeScript = join(process.cwd(), 'scripts', 'persistent-mode.mjs');
const preToolScript = join(process.cwd(), 'scripts', 'pre-tool-enforcer.mjs');
const keywordScript = join(process.cwd(), 'scripts', 'keyword-detector.mjs');
const ISOLATED_ENV_KEYS = [
    'HOME',
    'USERPROFILE',
    'OMC_STATE_DIR',
    'CLAUDE_CONFIG_DIR',
    'XDG_CONFIG_HOME',
    'CLAUDE_PLUGIN_ROOT',
    'OMC_SESSION_ID',
    'OMC_DISABLE_MULTIREPO',
    'ALLOW_ULTRAGOAL_WITHOUT_GOAL',
    'NODE_ENV',
];
const created = [];
let fixtureEnv;
function restoreFixtureEnv() {
    for (const key of ISOLATED_ENV_KEYS) {
        const value = fixtureEnv[key];
        if (value === undefined)
            delete process.env[key];
        else
            process.env[key] = value;
    }
}
function runHook(script, payload, env = {}) {
    const stdout = execFileSync(process.execPath, [script], {
        input: JSON.stringify(payload),
        encoding: 'utf-8',
        cwd: typeof payload.cwd === 'string' && payload.cwd.length > 0 ? payload.cwd : process.cwd(),
        env: {
            ...process.env,
            NODE_ENV: 'test',
            OMC_STATE_DIR: '',
            CLAUDE_PLUGIN_ROOT: '',
            ...env,
        },
    });
    return JSON.parse(stdout);
}
function makeTempProject(prefix) {
    const cwd = mkdtempSync(join(tmpdir(), prefix));
    created.push(cwd);
    execFileSync('git', ['init', '--quiet'], { cwd, stdio: 'pipe' });
    mkdirSync(join(cwd, '.omc', 'state', 'sessions', 'session-a'), { recursive: true });
    return cwd;
}
function writeUltragoalState(cwd, overrides = {}) {
    const now = new Date().toISOString();
    const state = {
        active: true,
        started_at: now,
        last_checked_at: now,
        session_id: 'session-a',
        project_path: cwd,
        current_phase: 'executing',
        claude_goal_objective: 'Complete issue #3098 ultragoal persistence.',
        ...overrides,
    };
    writeFileSync(join(cwd, '.omc', 'state', 'sessions', 'session-a', 'ultragoal-state.json'), `${JSON.stringify(state, null, 2)}\n`);
    return state;
}
function ultragoalStatePath(cwd) {
    return join(cwd, '.omc', 'state', 'sessions', 'session-a', 'ultragoal-state.json');
}
function readUltragoalState(cwd) {
    return JSON.parse(readFileSync(ultragoalStatePath(cwd), 'utf-8'));
}
function expectUltragoalEnforcement(cwd) {
    const preTool = runHook(preToolScript, { cwd, session_id: 'session-a', tool_name: 'Bash', tool_input: {} });
    const stop = runHook(persistentModeScript, { cwd, session_id: 'session-a' });
    expect(preTool.hookSpecificOutput?.permissionDecision).toBe('deny');
    expect(stop.decision).toBe('block');
}
function expectAwaitingConfirmationRelease(cwd) {
    const preTool = runHook(preToolScript, { cwd, session_id: 'session-a', tool_name: 'Bash', tool_input: {} });
    const stop = runHook(persistentModeScript, { cwd, session_id: 'session-a' });
    expect(preTool.hookSpecificOutput?.permissionDecision).not.toBe('deny');
    expect(stop.decision).toBeUndefined();
}
beforeEach(() => {
    fixtureEnv = Object.fromEntries(ISOLATED_ENV_KEYS.map((key) => [key, process.env[key]]));
    const environmentRoot = mkdtempSync(join(tmpdir(), 'omc-ultragoal-env-'));
    created.push(environmentRoot);
    const home = join(environmentRoot, 'home');
    const claudeConfigDir = join(home, '.claude');
    mkdirSync(claudeConfigDir, { recursive: true });
    mkdirSync(join(home, '.config'), { recursive: true });
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    process.env.OMC_STATE_DIR = '';
    process.env.CLAUDE_CONFIG_DIR = claudeConfigDir;
    process.env.XDG_CONFIG_HOME = join(home, '.config');
    process.env.CLAUDE_PLUGIN_ROOT = '';
    process.env.OMC_SESSION_ID = '';
    process.env.OMC_DISABLE_MULTIREPO = '';
    delete process.env.ALLOW_ULTRAGOAL_WITHOUT_GOAL;
    process.env.NODE_ENV = 'test';
});
afterEach(() => {
    restoreFixtureEnv();
    while (created.length)
        rmSync(created.pop(), { recursive: true, force: true });
});
describe('ultragoal persistence and Claude /goal enforcement', () => {
    it('allows PreToolUse when active ultragoal has a matching active Claude /goal', () => {
        const cwd = makeTempProject('omc-ultragoal-pass-');
        writeUltragoalState(cwd);
        const result = runHook(preToolScript, {
            cwd,
            session_id: 'session-a',
            tool_name: 'Bash',
            tool_input: { command: 'npm test' },
            goal: { objective: 'Complete issue #3098 ultragoal persistence.', status: 'active' },
        });
        expect(result.hookSpecificOutput?.permissionDecision).not.toBe('deny');
    });
    it('allows standalone active goal snapshot when no expected ultragoal objective exists', () => {
        const cwd = makeTempProject('omc-ultragoal-standalone-empty-');
        writeUltragoalState(cwd, { claude_goal_objective: '' });
        const result = runHook(preToolScript, {
            cwd,
            session_id: 'session-a',
            tool_name: 'Bash',
            tool_input: { command: 'npm test' },
            goal: { objective: 'Standalone Claude Code aggregate goal', status: 'active' },
        });
        expect(result.hookSpecificOutput?.permissionDecision).not.toBe('deny');
    });
    it('allows ultragoal CLI bootstrap commands before Claude /goal is visible', () => {
        const cwd = makeTempProject('omc-ultragoal-bootstrap-');
        writeUltragoalState(cwd);
        const createGoals = runHook(preToolScript, {
            cwd,
            session_id: 'session-a',
            tool_name: 'Bash',
            tool_input: { command: 'omc ultragoal create-goals --brief "fix issue"' },
        });
        const completeGoals = runHook(preToolScript, {
            cwd,
            session_id: 'session-a',
            tool_name: 'Bash',
            tool_input: { command: 'omc ultragoal complete-goals' },
        });
        expect(createGoals.hookSpecificOutput?.permissionDecision).not.toBe('deny');
        expect(completeGoals.hookSpecificOutput?.permissionDecision).not.toBe('deny');
    });
    it('allows cancel skill bootstrap paths when ultragoal goal snapshot is absent', () => {
        const cwd = makeTempProject('omc-ultragoal-cancel-bootstrap-');
        writeUltragoalState(cwd);
        const readCancelSkill = runHook(preToolScript, {
            cwd,
            session_id: 'session-a',
            tool_name: 'Read',
            tool_input: { file_path: join(process.cwd(), 'skills', 'cancel', 'SKILL.md') },
        });
        const invokeCancelSkill = runHook(preToolScript, {
            cwd,
            session_id: 'session-a',
            tool_name: 'Skill',
            tool_input: { skill: 'oh-my-claudecode:cancel' },
        });
        const clearState = runHook(preToolScript, {
            cwd,
            session_id: 'session-a',
            tool_name: 'mcp__omx_state__state_clear',
            tool_input: { mode: 'ultragoal' },
        });
        expect(readCancelSkill.hookSpecificOutput?.permissionDecision).not.toBe('deny');
        expect(invokeCancelSkill.hookSpecificOutput?.permissionDecision).not.toBe('deny');
        expect(clearState.hookSpecificOutput?.permissionDecision).not.toBe('deny');
    });
    it('allows trusted plugin CLI cancel/state bootstrap and denies untrusted node scripts (#3630)', () => {
        const cwd = makeTempProject('omc-ultragoal-plugin-cancel-');
        writeUltragoalState(cwd);
        const pluginEntry = join(cwd, 'bin', 'oh-my-claudecode.js');
        mkdirSync(join(cwd, 'bin'), { recursive: true });
        writeFileSync(pluginEntry, '#!/usr/bin/env node\n');
        const allowed = [
            `node ${pluginEntry} cancel`,
            `nodejs ${pluginEntry} state clear --mode ultragoal`,
            `node "${pluginEntry}" cancel`,
            'omc cancel',
            'oh-my-claudecode.js cancel',
        ];
        for (const command of allowed) {
            const result = runHook(preToolScript, {
                cwd,
                session_id: 'session-a',
                tool_name: 'Bash',
                tool_input: { command },
            });
            expect(result.hookSpecificOutput?.permissionDecision).not.toBe('deny');
        }
        const denied = [
            `node ${join(cwd, 'evil.js')} cancel`,
            `node ${pluginEntry} cancel && npm test`,
            `node ${pluginEntry} cancel; echo pwned`,
            'npm test',
        ];
        writeFileSync(join(cwd, 'evil.js'), '#!/usr/bin/env node\n');
        for (const command of denied) {
            const result = runHook(preToolScript, {
                cwd,
                session_id: 'session-a',
                tool_name: 'Bash',
                tool_input: { command },
            });
            expect(result.hookSpecificOutput?.permissionDecision).toBe('deny');
            expect(result.hookSpecificOutput?.permissionDecisionReason).toContain('[ULTRAGOAL /GOAL REQUIRED]');
        }
    });
    it('allows plugin-shaped ultragoal bootstrap commands without allowing lookalikes (#4459)', () => {
        const cwd = makeTempProject('omc-ultragoal-plugin-bootstrap-');
        writeFileSync(join(cwd, '.omc-workspace'), JSON.stringify({ id: 'issue-4459' }));
        writeUltragoalState(cwd);
        const pluginEntry = join(cwd, 'plugin', 'bin', 'oh-my-claudecode.js');
        const transcript = join(cwd, 'transcript.jsonl');
        mkdirSync(join(cwd, 'plugin', 'bin'), { recursive: true });
        writeFileSync(pluginEntry, '#!/usr/bin/env node\n');
        writeFileSync(transcript, '');
        const allowed = [
            'oh-my-claudecode.js ultragoal status',
            `node ${pluginEntry} ultragoal create-goals --brief "issue #4459"`,
            `nodejs "${pluginEntry}" ultragoal checkpoint --goal-id G001`,
            'omc ultragoal status',
            'oh-my-claudecode.js ultragoal list-plans',
        ];
        for (const command of allowed) {
            const result = runHook(preToolScript, {
                cwd,
                session_id: 'session-a',
                transcript_path: transcript,
                tool_name: 'Bash',
                tool_input: { command },
            });
            expect(result.hookSpecificOutput?.permissionDecision, command).not.toBe('deny');
        }
        const denied = [
            `node ${join(cwd, 'evil.js')} ultragoal status`,
            'oh-my-claudecode.js ultragoal unknown',
            'oh-my-claudecode.js ultragoal status && npm test',
            'oh-my-claudecode.js ultragoal status | cat',
            'oh-my-claudecode.js ultragoal status $(echo bypass)',
            'oh-my-claudecode.js ultragoal status `echo bypass`',
            `node ${pluginEntry} ultragoal checkpoint; echo bypass`,
            `node ${pluginEntry} ultragoalish status`,
        ];
        writeFileSync(join(cwd, 'evil.js'), '#!/usr/bin/env node\n');
        for (const command of denied) {
            const result = runHook(preToolScript, {
                cwd,
                session_id: 'session-a',
                transcript_path: transcript,
                tool_name: 'Bash',
                tool_input: { command },
            });
            expect(result.hookSpecificOutput?.permissionDecision, command).toBe('deny');
            expect(result.hookSpecificOutput?.permissionDecisionReason).toContain('[ULTRAGOAL /GOAL REQUIRED]');
        }
    });
    it('denies PreToolUse when active ultragoal has no visible Claude /goal', () => {
        const cwd = makeTempProject('omc-ultragoal-deny-');
        writeUltragoalState(cwd);
        const result = runHook(preToolScript, {
            cwd,
            session_id: 'session-a',
            tool_name: 'Bash',
            tool_input: { command: 'npm test' },
        });
        expect(result.hookSpecificOutput?.permissionDecision).toBe('deny');
        expect(result.hookSpecificOutput?.permissionDecisionReason).toContain('ALLOW_ULTRAGOAL_WITHOUT_GOAL=1');
    });
    it('releases both hooks only for a fresh awaiting-confirmation timestamp', () => {
        const fresh = new Date().toISOString();
        const preferred = makeTempProject('omc-ultragoal-awaiting-preferred-');
        writeUltragoalState(preferred, { awaiting_confirmation: true, awaiting_confirmation_set_at: fresh });
        expectAwaitingConfirmationRelease(preferred);
        const insideTtl = makeTempProject('omc-ultragoal-awaiting-inside-ttl-');
        writeUltragoalState(insideTtl, {
            awaiting_confirmation: true,
            awaiting_confirmation_set_at: new Date(Date.now() - 110_000).toISOString(),
        });
        expectAwaitingConfirmationRelease(insideTtl);
        for (const [name, overrides] of [
            ['false', { awaiting_confirmation: false, awaiting_confirmation_set_at: fresh }],
            ['missing', {}],
            ['stale', { awaiting_confirmation: true, awaiting_confirmation_set_at: new Date(Date.now() - 120_001).toISOString() }],
            ['at or beyond TTL', { awaiting_confirmation: true, awaiting_confirmation_set_at: new Date(Date.now() - 120_000).toISOString() }],
            ['future', { awaiting_confirmation: true, awaiting_confirmation_set_at: new Date(Date.now() + 60_000).toISOString() }],
            ['invalid preferred', { awaiting_confirmation: true, awaiting_confirmation_set_at: 'invalid', started_at: fresh }],
        ]) {
            const cwd = makeTempProject(`omc-ultragoal-awaiting-${name.replace(/\s/g, '-')}-`);
            writeUltragoalState(cwd, overrides);
            expectUltragoalEnforcement(cwd);
        }
        for (const preferred of [undefined, '   ']) {
            const cwd = makeTempProject('omc-ultragoal-awaiting-started-at-');
            writeUltragoalState(cwd, { awaiting_confirmation: true, awaiting_confirmation_set_at: preferred, started_at: fresh });
            expectAwaitingConfirmationRelease(cwd);
        }
    });
    it('requires /goal after confirmation and allows the matching goal', () => {
        const cwd = makeTempProject('omc-ultragoal-confirmation-transition-');
        runHook(keywordScript, { cwd, session_id: 'session-a', prompt: '$ultragoal fix issue #3506' });
        expectAwaitingConfirmationRelease(cwd);
        runHook(preToolScript, {
            cwd,
            session_id: 'session-a',
            tool_name: 'Skill',
            tool_input: { skill: 'oh-my-claudecode:ultragoal' },
        });
        expect(readUltragoalState(cwd).awaiting_confirmation).not.toBe(true);
        expectUltragoalEnforcement(cwd);
        const confirmedState = readUltragoalState(cwd);
        confirmedState.claude_goal_objective = 'Complete issue #3506 ultragoal confirmation parity.';
        writeFileSync(ultragoalStatePath(cwd), `${JSON.stringify(confirmedState, null, 2)}\n`);
        const matchingGoal = runHook(preToolScript, {
            cwd,
            session_id: 'session-a',
            tool_name: 'Bash',
            tool_input: {},
            goal: { objective: confirmedState.claude_goal_objective, status: 'active' },
        });
        expect(matchingGoal.hookSpecificOutput?.permissionDecision).not.toBe('deny');
    });
    it('releases two keyword-detector activation and confirmation cycles in one session and project', () => {
        const cwd = makeTempProject('omc-ultragoal-two-cycles-');
        for (const prompt of ['$ultragoal fix issue #3506', 'run ultragoal for issue #3506 again']) {
            runHook(keywordScript, { cwd, session_id: 'session-a', prompt });
            expectAwaitingConfirmationRelease(cwd);
            runHook(preToolScript, {
                cwd,
                session_id: 'session-a',
                tool_name: 'Skill',
                tool_input: { skill: 'oh-my-claudecode:ultragoal' },
            });
            expect(readUltragoalState(cwd).awaiting_confirmation).not.toBe(true);
            expectUltragoalEnforcement(cwd);
            const confirmedState = readUltragoalState(cwd);
            confirmedState.claude_goal_objective = 'Complete issue #3506 recurring ultragoal run.';
            writeFileSync(ultragoalStatePath(cwd), `${JSON.stringify(confirmedState, null, 2)}\n`);
            const matchingGoal = runHook(preToolScript, {
                cwd,
                session_id: 'session-a',
                tool_name: 'Bash',
                tool_input: {},
                goal: { objective: confirmedState.claude_goal_objective, status: 'active' },
            });
            expect(matchingGoal.hookSpecificOutput?.permissionDecision).not.toBe('deny');
        }
    });
    // Write a session-bound transcript (`<sessionId>.jsonl`) with the given record
    // contents, mirroring how Claude Code records `/goal` local-command output.
    const PLAN_OBJECTIVE = 'Complete issue #3098 ultragoal persistence.';
    // A canonical `/goal` slash-command invocation record content string.
    function goalCommand(args) {
        return `<command-name>/goal</command-name>\n<command-message>goal</command-message>\n<command-args>${args}</command-args>`;
    }
    function writeSessionTranscript(cwd, sessionId, contents) {
        const transcriptPath = join(cwd, `${sessionId}.jsonl`);
        writeFileSync(transcriptPath, `${contents
            .map(content => JSON.stringify({ type: 'user', message: { role: 'user', content } }))
            .join('\n')}\n`);
        return transcriptPath;
    }
    it('allows PreToolUse when an active Claude /goal is recovered from the transcript', () => {
        const cwd = makeTempProject('omc-ultragoal-transcript-');
        writeUltragoalState(cwd);
        // Claude Code never puts /goal in the hook payload; the /goal invocation is recorded
        // in the session transcript as a command record. The guard must recover it there
        // instead of denying every tool for the whole run (regression for #3341).
        const transcriptPath = writeSessionTranscript(cwd, 'session-a', [goalCommand(PLAN_OBJECTIVE)]);
        const result = runHook(preToolScript, {
            cwd,
            session_id: 'session-a',
            transcript_path: transcriptPath,
            tool_name: 'Bash',
            tool_input: { command: 'npm test' },
        });
        expect(result.hookSpecificOutput?.permissionDecision).not.toBe('deny');
    });
    it('re-denies when the transcript shows the /goal was cleared', () => {
        const cwd = makeTempProject('omc-ultragoal-transcript-cleared-');
        writeUltragoalState(cwd);
        const transcriptPath = writeSessionTranscript(cwd, 'session-a', [
            goalCommand(PLAN_OBJECTIVE),
            goalCommand('clear'),
        ]);
        const result = runHook(preToolScript, {
            cwd,
            session_id: 'session-a',
            transcript_path: transcriptPath,
            tool_name: 'Bash',
            tool_input: { command: 'npm test' },
        });
        expect(result.hookSpecificOutput?.permissionDecision).toBe('deny');
    });
    it('denies when the transcript is not the active session file (#3465 blocker 1)', () => {
        const cwd = makeTempProject('omc-ultragoal-foreign-transcript-');
        writeUltragoalState(cwd);
        // A canonical command record, but in a file not bound to this session.
        const foreignPath = join(cwd, 'not-the-session.jsonl');
        writeFileSync(foreignPath, `${JSON.stringify({ type: 'user', message: { role: 'user', content: goalCommand(PLAN_OBJECTIVE) } })}\n`);
        const result = runHook(preToolScript, {
            cwd,
            session_id: 'session-a',
            transcript_path: foreignPath,
            tool_name: 'Bash',
            tool_input: { command: 'npm test' },
        });
        expect(result.hookSpecificOutput?.permissionDecision).toBe('deny');
    });
    it('rejects a symlinked session transcript (#3466 blocker 2)', () => {
        const cwd = makeTempProject('omc-ultragoal-symlink-');
        writeUltragoalState(cwd);
        const realPath = join(cwd, 'real-transcript.jsonl');
        writeFileSync(realPath, `${JSON.stringify({ type: 'user', message: { role: 'user', content: goalCommand(PLAN_OBJECTIVE) } })}\n`);
        const linkPath = join(cwd, 'session-a.jsonl');
        symlinkSync(realPath, linkPath);
        const result = runHook(preToolScript, {
            cwd,
            session_id: 'session-a',
            transcript_path: linkPath,
            tool_name: 'Bash',
            tool_input: { command: 'npm test' },
        });
        expect(result.hookSpecificOutput?.permissionDecision).toBe('deny');
    });
    it('denies when transcript display text quotes the /goal wrapper without a command record (#3466 blocker 1)', () => {
        const cwd = makeTempProject('omc-ultragoal-spoof-');
        writeUltragoalState(cwd);
        // A user-typed/pasted message that merely embeds the literal stdout wrapper must
        // NOT authorize tools: only a real `<command-name>/goal</command-name>` record does.
        const transcriptPath = writeSessionTranscript(cwd, 'session-a', [
            `here is a log I pasted: <local-command-stdout>Goal set: ${PLAN_OBJECTIVE}</local-command-stdout>`,
        ]);
        const result = runHook(preToolScript, {
            cwd,
            session_id: 'session-a',
            transcript_path: transcriptPath,
            tool_name: 'Bash',
            tool_input: { command: 'npm test' },
        });
        expect(result.hookSpecificOutput?.permissionDecision).toBe('deny');
    });
    it('fails closed when a goal-bearing transcript record is malformed (#3466 blocker 3)', () => {
        const cwd = makeTempProject('omc-ultragoal-malformed-tail-');
        writeUltragoalState(cwd);
        const transcriptPath = join(cwd, 'session-a.jsonl');
        // A valid set, then a truncated/corrupt goal-bearing line: recovery must invalidate
        // rather than keep the stale set active.
        writeFileSync(transcriptPath, `${JSON.stringify({ type: 'user', message: { role: 'user', content: goalCommand(PLAN_OBJECTIVE) } })}\n{"type":"user","message":{"role":"user","content":"<command-name>/goal</command-n\n`);
        const result = runHook(preToolScript, {
            cwd,
            session_id: 'session-a',
            transcript_path: transcriptPath,
            tool_name: 'Bash',
            tool_input: { command: 'npm test' },
        });
        expect(result.hookSpecificOutput?.permissionDecision).toBe('deny');
    });
    it('applies /goal set then clear across records, last-event-wins (#3465 blocker 2)', () => {
        const cwd = makeTempProject('omc-ultragoal-record-order-');
        writeUltragoalState(cwd);
        const transcriptPath = writeSessionTranscript(cwd, 'session-a', [
            goalCommand(PLAN_OBJECTIVE),
            goalCommand('clear'),
            // A later non-goal record must not resurrect the cleared goal.
            'some unrelated follow-up message',
        ]);
        const result = runHook(preToolScript, {
            cwd,
            session_id: 'session-a',
            transcript_path: transcriptPath,
            tool_name: 'Bash',
            tool_input: { command: 'npm test' },
        });
        expect(result.hookSpecificOutput?.permissionDecision).toBe('deny');
    });
    it('denies an explicit payload goal whose objective does not match the plan (#3465 blocker 3)', () => {
        const cwd = makeTempProject('omc-ultragoal-payload-mismatch-');
        writeUltragoalState(cwd);
        const result = runHook(preToolScript, {
            cwd,
            session_id: 'session-a',
            tool_name: 'Bash',
            tool_input: { command: 'npm test' },
            goal: { objective: 'Some entirely unrelated objective', status: 'active' },
        });
        expect(result.hookSpecificOutput?.permissionDecision).toBe('deny');
    });
    it('prefers an explicit matching payload goal over the transcript (#3466 blocker 5)', () => {
        const cwd = makeTempProject('omc-ultragoal-payload-precedence-');
        writeUltragoalState(cwd);
        // Transcript would clear the goal, but an explicit matching payload snapshot
        // (Claude/Codex host-supplied) takes precedence and is honored.
        const transcriptPath = writeSessionTranscript(cwd, 'session-a', [goalCommand('clear')]);
        const result = runHook(preToolScript, {
            cwd,
            session_id: 'session-a',
            transcript_path: transcriptPath,
            tool_name: 'Bash',
            tool_input: { command: 'npm test' },
            goal: { objective: PLAN_OBJECTIVE, status: 'active' },
        });
        expect(result.hookSpecificOutput?.permissionDecision).not.toBe('deny');
    });
    it('allows single ultragoal checkpoint / record-review-blockers commands', () => {
        const cwd = makeTempProject('omc-ultragoal-checkpoint-');
        writeUltragoalState(cwd);
        const checkpoint = runHook(preToolScript, {
            cwd,
            session_id: 'session-a',
            tool_name: 'Bash',
            tool_input: { command: 'omc ultragoal checkpoint --goal-id G001 --status complete' },
        });
        const blockers = runHook(preToolScript, {
            cwd,
            session_id: 'session-a',
            tool_name: 'Bash',
            tool_input: { command: 'omc ultragoal record-review-blockers --goal-id G001' },
        });
        expect(checkpoint.hookSpecificOutput?.permissionDecision).not.toBe('deny');
        expect(blockers.hookSpecificOutput?.permissionDecision).not.toBe('deny');
    });
    it('does not let a checkpoint bypass smuggle a chained command (#3465 blocker 4)', () => {
        const cwd = makeTempProject('omc-ultragoal-checkpoint-chain-');
        writeUltragoalState(cwd);
        const result = runHook(preToolScript, {
            cwd,
            session_id: 'session-a',
            tool_name: 'Bash',
            tool_input: { command: 'omc ultragoal checkpoint --goal-id G001 --status complete && npm test' },
        });
        expect(result.hookSpecificOutput?.permissionDecision).toBe('deny');
    });
    it('ignores stale ultragoal state in PreToolUse and Stop enforcement', () => {
        const cwd = makeTempProject('omc-ultragoal-stale-');
        writeUltragoalState(cwd, {
            started_at: '2000-01-01T00:00:00.000Z',
            last_checked_at: '2000-01-01T00:00:00.000Z',
        });
        const preTool = runHook(preToolScript, { cwd, session_id: 'session-a', tool_name: 'Bash', tool_input: {} });
        const stop = runHook(persistentModeScript, { cwd, session_id: 'session-a' });
        expect(preTool.hookSpecificOutput?.permissionDecision).not.toBe('deny');
        expect(stop.continue).toBe(true);
    });
    it('ignores ultragoal state for another worktree', () => {
        const cwd = makeTempProject('omc-ultragoal-worktree-a-');
        const other = makeTempProject('omc-ultragoal-worktree-b-');
        writeUltragoalState(cwd, { project_path: other });
        const preTool = runHook(preToolScript, { cwd, session_id: 'session-a', tool_name: 'Bash', tool_input: {} });
        const stop = runHook(persistentModeScript, { cwd, session_id: 'session-a' });
        expect(preTool.hookSpecificOutput?.permissionDecision).not.toBe('deny');
        expect(stop.continue).toBe(true);
    });
    it('does not reinject Stop continuation after ultragoal is all done', () => {
        const cwd = makeTempProject('omc-ultragoal-done-');
        writeUltragoalState(cwd, { current_phase: 'all-done', all_done: true });
        const stop = runHook(persistentModeScript, { cwd, session_id: 'session-a' });
        expect(stop.continue).toBe(true);
        expect(stop.decision).toBeUndefined();
    });
    it('does not activate ultragoal state for unrelated prose mentions', () => {
        const cwd = makeTempProject('omc-ultragoal-keyword-prose-');
        runHook(keywordScript, {
            cwd,
            session_id: 'session-a',
            prompt: 'Review whether ultragoal keyword activation steals unrelated prompts',
        });
        const statePath = join(cwd, '.omc', 'state', 'sessions', 'session-a', 'ultragoal-state.json');
        expect(existsSync(statePath)).toBe(false);
    });
    it('does not activate or deny for quoted reported speech and pasted bug-report keyword mentions', () => {
        for (const prompt of [
            'The reporter said “please run ultragoal” during triage.',
            'Pasted bug report: log line `[MAGIC KEYWORD DETECTED: ULTRAGOAL]` caused a prior failure.',
        ]) {
            const cwd = makeTempProject('omc-ultragoal-keyword-negative-');
            runHook(keywordScript, { cwd, session_id: 'session-a', prompt });
            expect(existsSync(ultragoalStatePath(cwd))).toBe(false);
            const preTool = runHook(preToolScript, { cwd, session_id: 'session-a', tool_name: 'Bash', tool_input: {} });
            expect(preTool.hookSpecificOutput?.permissionDecision).not.toBe('deny');
        }
    });
    it('activates ultragoal session state from explicit natural-language invocation', () => {
        const cwd = makeTempProject('omc-ultragoal-keyword-natural-');
        runHook(keywordScript, { cwd, session_id: 'session-a', prompt: 'run ultragoal for issue #3098' });
        const state = readUltragoalState(cwd);
        expect(state.active).toBe(true);
    });
    it('activates ultragoal session state from keyword-detector', () => {
        const cwd = makeTempProject('omc-ultragoal-keyword-');
        runHook(keywordScript, { cwd, session_id: 'session-a', prompt: '$ultragoal fix issue #3098' });
        const state = readUltragoalState(cwd);
        expect(state.active).toBe(true);
        expect(state.session_id).toBe('session-a');
        expect(state.current_phase).toBe('executing');
    });
});
//# sourceMappingURL=ultragoal-persistence.test.js.map