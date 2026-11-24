// Records which tmux keys the readiness paths send for each recorded pane
// frame. scripts/dev/readiness-diff.mjs copies this file and its tmux mock
// (helpers/readiness-trace-tmux.ts) unchanged into a base checkout and runs it
// in both trees, so it may statically import only those and modules that exist
// on the base as well. Runs only when READINESS_TRACE_OUT is set.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PANE_ID, trace } from './helpers/readiness-trace-tmux.js';
const TRACE_OUT = process.env.READINESS_TRACE_OUT;
const TRACE_SET = process.env.READINESS_TRACE_SET ?? 'r5';
const FIXTURE_ROOT = process.env.READINESS_FIXTURE_ROOT
    ?? join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'pane-frames');
const STARTUP_MESSAGE = 'Read .omc/state/team/trace/workers/worker-1/inbox.md, execute now, report concrete progress.';
vi.mock('../../platform/process-utils.js', async (importOriginal) => ({
    ...await importOriginal(),
    isProcessIdentityLive: vi.fn(async () => 'live'),
}));
vi.mock('../../cli/tmux-utils.js', async (importOriginal) => {
    const { tmuxUtilsOverrides } = await import('./helpers/readiness-trace-tmux.js');
    return {
        ...await importOriginal(),
        ...Object.fromEntries(Object.entries(tmuxUtilsOverrides()).map(([name, fn]) => [name, vi.fn(fn)])),
    };
});
import { deliverStartupInbox } from '../tmux-session.js';
import { currentStrictProcessStartIdentity } from '../team-owner-epoch.js';
import { awaitWorkerLaunchAcknowledgement, prepareWorkerLaunchAttempt } from '../worker-launch-ack.js';
// Claude Code's trust dialog: "No, exit" is focused first, Down moves the
// focus, Enter confirms the focused choice. `immediate` applies each key as it
// arrives. `batched` applies the keys sent since the last capture together,
// against the focus drawn before them: the hypothesis that fits the recorded
// Claude Code 2.1.328 failures.
function claudeTrustPane(noFocused, idle, mode) {
    const lines = noFocused.split('\n');
    const no = lines.findIndex(line => /❯\s*No, exit/.test(line));
    const yes = lines.findIndex(line => /^\s*Yes, (?:proceed|I trust this folder)/.test(line));
    const column = lines[no].indexOf('❯');
    lines[no] = `${lines[no].slice(0, column)} ${lines[no].slice(column + 1)}`;
    lines[yes] = `${lines[yes].slice(0, column)}❯${lines[yes].slice(column + 1)}`;
    const frames = {
        no: noFocused,
        yes: lines.join('\n'),
        declined: `${noFocused.trimEnd()}\nClaude Code didn't start because this folder isn't trusted.\n`,
        trusted: idle,
    };
    let focus = 'no';
    let pending = [];
    const apply = (keys) => {
        const drawn = focus;
        if (drawn !== 'no' && drawn !== 'yes')
            return;
        for (const key of keys) {
            if (key === 'Enter') {
                focus = drawn === 'yes' ? 'trusted' : 'declined';
                return;
            }
            if (key === 'Down')
                focus = 'yes';
        }
    };
    return {
        send: keys => {
            if (keys.length !== 1)
                return;
            if (mode === 'batched')
                pending.push(keys[0]);
            else
                apply(keys);
        },
        capture: () => {
            apply(pending);
            pending = [];
            return frames[focus];
        },
    };
}
// Each set lists its cases; later PRs add sets here and in readiness-diff.mjs.
const SETS = {
    r5: (fixtures, contexts) => {
        const values = [undefined, '', 'abc', '4999', '5000', '29999', '30000', '60000', '120000', '120001', '600000', '6e4', '9007199254740992'];
        return fixtures.flatMap(fixture => values.map(raw => ({
            case: `${fixture.file} OMC_TEAM_READY_TIMEOUT_MS=${raw === undefined ? '<unset>' : JSON.stringify(raw)}`,
            fn: 'deliverStartupInbox',
            fixture: fixture.file,
            eventState: null,
            env: { OMC_TEAM_READY_TIMEOUT_MS: raw ?? null },
            control: fixture.file === 'claude/2.1.325/idle.txt' && raw === undefined,
            run: () => deliverStartupInbox(contexts.get(fixture.provider), STARTUP_MESSAGE, { attemptAlreadyFenced: true }),
        })));
    },
    trust: (fixtures, contexts) => {
        const idle = readFileSync(join(FIXTURE_ROOT, 'claude/2.1.325/idle.txt'), 'utf8');
        // Claude's other "No, exit" dialog, the Bypass Permissions warning, is not a trust dialog.
        const dialogs = fixtures.filter(fixture => {
            const text = readFileSync(join(FIXTURE_ROOT, fixture.file), 'utf8');
            return fixture.provider === 'claude' && /❯\s*No, exit/.test(text) && /^\s*Yes, (?:proceed|I trust this folder)/m.test(text);
        });
        // An answered dialog left above the live input prompt: keys reach the
        // prompt, so the pane stays as recorded.
        const stale = (file) => {
            const lines = readFileSync(join(FIXTURE_ROOT, file), 'utf8').split('\n');
            return lines.slice(lines.findIndex(line => /^\s*Yes,/.test(line)) + 1).some(line => /^\s*❯/.test(line));
        };
        return dialogs.flatMap(fixture => (stale(fixture.file) ? ['stale'] : ['immediate', 'batched']).map(mode => ({
            case: `${fixture.file} keys=${mode}`,
            fn: 'deliverStartupInbox',
            fixture: fixture.file,
            eventState: mode,
            env: { OMC_TEAM_READY_TIMEOUT_MS: null },
            control: fixture.file === 'claude/2.1.325/trust.txt' && mode === 'immediate',
            pane: mode === 'stale' ? undefined : () => claudeTrustPane(readFileSync(join(FIXTURE_ROOT, fixture.file), 'utf8'), idle, mode),
            run: () => deliverStartupInbox(contexts.get(fixture.provider), STARTUP_MESSAGE, { attemptAlreadyFenced: true }),
        })));
    },
};
// Advance the fake clock only while the code under test sleeps; between
// sleeps let real file I/O finish so it never eats into the deadline.
async function settleOnFakeClock(work) {
    let settled = false;
    void work.then(() => { settled = true; }, () => { settled = true; });
    while (!settled) {
        if (vi.getTimerCount() > 0)
            await vi.advanceTimersToNextTimerAsync();
        else
            await new Promise(resolve => setImmediate(resolve));
    }
    return work;
}
const supported = currentStrictProcessStartIdentity() !== null
    && (process.platform === 'darwin' || process.platform === 'linux');
describe.skipIf(!TRACE_OUT)('readiness trace harness', () => {
    let root = '';
    const savedEnv = new Map();
    beforeAll(() => {
        root = mkdtempSync(join(tmpdir(), 'readiness-trace-'));
        for (const key of ['HOME', 'USERPROFILE', 'OMC_STATE_DIR', 'OMC_TEAM_READY_TIMEOUT_MS'])
            savedEnv.set(key, process.env[key]);
        process.env.HOME = root;
        process.env.USERPROFILE = root;
        delete process.env.OMC_STATE_DIR;
    });
    afterAll(() => {
        for (const [key, value] of savedEnv) {
            if (value === undefined)
                delete process.env[key];
            else
                process.env[key] = value;
        }
        rmSync(root, { recursive: true, force: true });
    });
    it(`records the keys sent for set ${TRACE_SET}`, async () => {
        expect(supported, 'needs a strict process start identity (darwin or linux)').toBe(true);
        const buildCases = SETS[TRACE_SET];
        expect(buildCases, `unknown set ${TRACE_SET}`).toBeDefined();
        const fixtures = JSON.parse(readFileSync(join(FIXTURE_ROOT, 'manifest.json'), 'utf8'));
        const contexts = new Map();
        for (const provider of new Set(fixtures.map(fixture => fixture.provider))) {
            const attempt = await prepareWorkerLaunchAttempt({
                cwd: root,
                teamName: 'trace-team',
                workerName: `worker-${provider}`,
                instanceId: randomUUID(),
                paneId: PANE_ID,
                provider,
                runtimeCliPath: '/runtime-cli.cjs',
            });
            const { ackPath, ...rest } = attempt;
            writeFileSync(ackPath, JSON.stringify({
                schema_version: rest.schema_version,
                attempt_id: rest.attempt_id,
                nonce: rest.nonce,
                instance_id: rest.instance_id,
                team_name: rest.team_name,
                worker_name: rest.worker_name,
                pane_id: rest.pane_id,
                provider: rest.provider,
                created_at: rest.created_at,
                kind: 'worker_launch_ack',
                written_at: new Date().toISOString(),
            }));
            await awaitWorkerLaunchAcknowledgement(attempt, { timeoutMs: 1_000, pollIntervalMs: 5 });
            contexts.set(provider, {
                provider,
                attempt,
                ownership: {
                    provider: 'tmux',
                    providerTarget: 'trace:0',
                    paneId: PANE_ID,
                    splitTarget: '%1',
                    leaderPaneId: '%1',
                    reservedPaneIds: [],
                    source: 'split',
                    tmuxServerIdentity: {
                        socket_path: '/tmp/omc-readiness-trace.sock',
                        server_pid: process.pid,
                        process_started_at: currentStrictProcessStartIdentity(),
                    },
                },
            });
        }
        const results = [];
        const warn = vi.spyOn(console, 'warn');
        for (const traceCase of buildCases(fixtures, contexts)) {
            trace.frame = readFileSync(join(FIXTURE_ROOT, traceCase.fixture), 'utf8');
            trace.pane = traceCase.pane?.() ?? null;
            trace.keys = [];
            trace.unknown = [];
            for (const [key, value] of Object.entries(traceCase.env)) {
                if (value === null)
                    delete process.env[key];
                else
                    process.env[key] = value;
            }
            const warnings = [];
            warn.mockImplementation((...args) => { warnings.push(args.map(String).join(' ')); });
            vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
            trace.startedAt = Date.now();
            let result;
            try {
                result = await settleOnFakeClock(traceCase.run());
            }
            catch (error) {
                result = { threw: error instanceof Error ? error.message : String(error) };
            }
            const waitMs = Date.now() - trace.startedAt;
            vi.useRealTimers();
            trace.pane = null;
            const { run: _run, pane: _pane, ...described } = traceCase;
            results.push({
                ...described,
                keys: trace.keys,
                result,
                wait_ms: waitMs,
                unknown_commands: trace.unknown,
                warnings,
            });
        }
        warn.mockRestore();
        writeFileSync(TRACE_OUT, `${JSON.stringify({
            set: TRACE_SET,
            loaded_modules: ['tmux-session', 'worker-launch-ack', 'team-owner-epoch'],
            cases: results,
        }, null, 2)}\n`);
    }, 30 * 60_000);
});
//# sourceMappingURL=readiness-trace.harness.test.js.map