import { spawn } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderRecoveryContinuationInstruction } from '../worker-bootstrap.js';
// Drives fake-team-provider.mjs over pipes, with a stub `omc` on PATH, so each
// scenario's frames and key handling stay checked without tmux.
const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '../../..');
const FAKE_PROVIDER = join(HERE, 'fixtures', 'fake-team-provider.mjs');
const CORPUS_ROOT = join(HERE, 'fixtures', 'pane-frames');
const TSX_LOADER_URL = pathToFileURL(join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'loader.mjs')).href;
const DOWN = '\x1b[B';
function frame(file) {
    return readFileSync(join(CORPUS_ROOT, file), 'utf8').trimEnd();
}
let root = '';
let callsPath = '';
let tracePath = '';
let inboxPath = '';
let ackPath = '';
const runs = [];
async function apiCalls() {
    const raw = await readFile(callsPath, 'utf8').catch(() => '');
    return raw.split('\n').filter(Boolean).map(line => {
        const [operation, ...input] = line.split(' ');
        return { operation: operation, input: JSON.parse(input.join(' ')) };
    });
}
async function traceSteps() {
    const raw = await readFile(tracePath, 'utf8').catch(() => '');
    return raw.split('\n').filter(Boolean).map(line => JSON.parse(line).step);
}
async function traceTimes() {
    const raw = await readFile(tracePath, 'utf8').catch(() => '');
    const entries = raw.split('\n').filter(Boolean).map(line => JSON.parse(line));
    return Object.fromEntries(entries.map(entry => [entry.step, Date.parse(entry.at)]));
}
function startFake(scenario, selectBy = 'flag') {
    const env = {
        ...process.env,
        PATH: `${join(root, 'bin')}${delimiter}${process.env.PATH ?? ''}`,
        OMC_TEAM_STATE_ROOT: root,
    };
    delete env.OMC_FAKE_PROVIDER_SCENARIO;
    if (scenario && selectBy === 'env')
        env.OMC_FAKE_PROVIDER_SCENARIO = scenario;
    const scenarioArgs = scenario && selectBy === 'flag' ? ['--scenario', scenario] : [];
    const child = spawn(process.execPath, ['--import', TSX_LOADER_URL, FAKE_PROVIDER, '--trace', tracePath, ...scenarioArgs], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    const exitCode = new Promise(resolveExit => child.once('exit', code => resolveExit(code)));
    const run = {
        child,
        output: () => stdout,
        exitCode,
        send: line => { child.stdin.write(`${line}\n`); },
        press: keys => { child.stdin.write(keys); },
        waitForOutput: async (text, timeoutMs = 10_000) => {
            const deadline = Date.now() + timeoutMs;
            while (!stdout.includes(text)) {
                if (Date.now() >= deadline || child.exitCode !== null) {
                    throw new Error(`fake provider never printed ${JSON.stringify(text)}; stdout=${JSON.stringify(stdout)}`);
                }
                await new Promise(resolveSleep => setTimeout(resolveSleep, 20));
            }
            return Date.now();
        },
    };
    runs.push(run);
    return run;
}
async function waitUntil(done, diagnostics, timeoutMs = 10_000) {
    const deadline = Date.now() + timeoutMs;
    while (!(await done())) {
        if (Date.now() >= deadline)
            throw new Error(`timed out; stdout=${JSON.stringify(diagnostics())}`);
        await new Promise(resolveSleep => setTimeout(resolveSleep, 20));
    }
}
async function writeTaskInbox() {
    await writeFile(inboxPath, [
        '# Worker inbox',
        `omc team api claim-task --input '{"team_name":"t","task_id":"1","worker":"worker-1"}' --json`,
        `omc team api transition-task-status --input '{"team_name":"t","task_id":"1","from":"in_progress","to":"completed","claim_token":"<claim_token>"}' --json`,
    ].join('\n'));
}
function sendStartupTrigger(run) {
    run.send(`Read ${inboxPath}, execute now, report concrete progress.`);
}
async function shutDown(run) {
    await writeFile(inboxPath, `# Shutdown Request\nWrite your ack to: ${ackPath}\n`);
    expect(await run.exitCode).toBe(0);
    expect(JSON.parse(await readFile(ackPath, 'utf8'))).toMatchObject({ status: 'accept' });
}
async function runClaimLifecycle(run, completedFrame) {
    await writeTaskInbox();
    sendStartupTrigger(run);
    await waitUntil(async () => (await apiCalls()).length === 2 && run.output().endsWith(completedFrame), run.output);
    expect(await apiCalls()).toEqual([
        { operation: 'claim-task', input: { team_name: 't', task_id: '1', worker: 'worker-1' } },
        { operation: 'transition-task-status', input: expect.objectContaining({ to: 'completed', claim_token: 'tok-1' }) },
    ]);
    await shutDown(run);
}
beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'omc-fake-scenario-'));
    callsPath = join(root, 'api-calls.log');
    tracePath = join(root, 'trace.jsonl');
    inboxPath = join(root, 'inbox.md');
    ackPath = join(root, 'shutdown-ack.json');
    await mkdir(join(root, 'bin'));
    const stub = join(root, 'bin', 'omc');
    await writeFile(stub, [
        '#!/bin/sh',
        `printf '%s %s\\n' "$3" "$5" >> '${callsPath}'`,
        'case "$3" in',
        `  claim-task) echo '{"ok":true,"data":{"ok":true,"claimToken":"tok-1"}}' ;;`,
        `  *) echo '{"ok":true,"data":{"ok":true}}' ;;`,
        'esac',
    ].join('\n'));
    await chmod(stub, 0o755);
});
afterEach(async () => {
    for (const run of runs.splice(0)) {
        if (run.child.exitCode === null)
            run.child.kill('SIGKILL');
        await run.exitCode;
    }
    await rm(root, { recursive: true, force: true });
});
// The fake provider is POSIX-only: it matches the inbox by a forward-slash path and runs the team API through /bin/sh.
describe.skipIf(process.platform === 'win32')('fake team provider scenarios', () => {
    it('default: keeps the banner, the claim lifecycle and the trace step order', async () => {
        const run = startFake(undefined);
        await run.waitForOutput('fake-claude for omc team tmux smoke\n\n❯ ');
        await runClaimLifecycle(run, '\ntask completed\n❯ ');
        expect(await traceSteps()).toEqual([
            'banner', 'idle-prompt', 'await-startup-trigger', 'read-inbox', 'claim-task', 'complete-task',
            'idle-prompt', 'await-shutdown-request', 'write-shutdown-ack', 'exit',
        ]);
    });
    it('default: still fails on a recovery continuation inbox', async () => {
        const run = startFake(undefined);
        await run.waitForOutput('❯ ');
        await writeFile(inboxPath, '## Recovery Continuation\nYou own adopted task 1 at checkpoint sequence 1.\n');
        sendStartupTrigger(run);
        expect(await run.exitCode).toBe(1);
        expect(run.output()).toContain('fake-claude failed at read-inbox: inbox_lifecycle_commands_missing');
    });
    it.each([
        ['claude-trust', 'claude/2.1.325/trust.txt'],
        ['wrapped-trust-35col', 'claude/2.1.310/trust-35col.txt'],
    ])('%s: shows the trust dialog and draws the idle prompt only after Down then Enter', async (scenario, trustFile) => {
        const run = startFake(scenario);
        await run.waitForOutput(frame(trustFile));
        run.press('stray text');
        await new Promise(resolveSleep => setTimeout(resolveSleep, 300));
        expect(run.output()).not.toContain(frame('claude/2.1.325/idle.txt'));
        run.press(DOWN);
        await run.waitForOutput('❯ Yes, ');
        run.press('\r');
        await run.waitForOutput(frame('claude/2.1.325/idle.txt'));
        await runClaimLifecycle(run, '\ntask completed\n❯ ');
    });
    it('claude-trust: Down redraws the dialog exactly as Claude Code 2.1.328 does', async () => {
        const run = startFake('claude-trust');
        await run.waitForOutput(frame('claude/2.1.325/trust.txt'));
        run.press(DOWN);
        await run.waitForOutput('❯ Yes, ');
        const focusLines = (text) => text.split('\n').filter(line => /No, exit|Yes, I trust/.test(line));
        expect(focusLines(run.output().split('\x1b[H\x1b[J').at(-1)))
            .toEqual(focusLines(frame('claude/2.1.328/trust-yes-focused.txt')));
    });
    it('wrapped-trust-35col: prints a dialog already wrapped to 35 columns', () => {
        const lines = frame('claude/2.1.310/trust-35col.txt').split('\n');
        expect(Math.max(...lines.map(line => [...line].length))).toBeLessThanOrEqual(35);
    });
    it.each([
        ['Enter alone', ['\r']],
        ['Down and Enter in one read', [`${DOWN}\r`]],
    ])('claude-trust: %s takes the default "No, exit" and quits', async (_label, reads) => {
        const run = startFake('claude-trust');
        await run.waitForOutput(frame('claude/2.1.325/trust.txt'));
        for (const keys of reads)
            run.press(keys);
        expect(await run.exitCode).toBe(1);
        expect(run.output()).toContain('fake-claude failed at await-trust-answer: trust_declined');
    });
    it('claude-trust-ignores-early-keys: drops a Down sent right after the dialog draws, takes a later one', async () => {
        const run = startFake('claude-trust-ignores-early-keys');
        await run.waitForOutput(frame('claude/2.1.325/trust.txt'));
        run.press(DOWN);
        await new Promise(resolveSleep => setTimeout(resolveSleep, 800));
        expect(run.output()).not.toContain('❯ Yes, ');
        run.press(DOWN);
        await run.waitForOutput('❯ Yes, ');
        run.press('\r');
        await run.waitForOutput(frame('claude/2.1.325/idle.txt'));
    });
    it('claude-trust-busy-startup: keys sent while startup blocks are read together', async () => {
        const run = startFake('claude-trust-busy-startup');
        await run.waitForOutput(frame('claude/2.1.325/trust.txt'));
        run.press(DOWN);
        await new Promise(resolveSleep => setTimeout(resolveSleep, 120));
        run.press('\r');
        expect(await run.exitCode).toBe(1);
        expect(run.output()).toContain('fake-claude failed at await-trust-answer: trust_declined');
    });
    it('claude-onboarding: Enter on the theme picker answers onboarding and fails', async () => {
        const run = startFake('claude-onboarding');
        await run.waitForOutput(frame('claude/2.1.329/onboarding-theme.txt'));
        expect(await traceSteps()).not.toContain('selector-read');
        run.press('\r');
        expect(await run.exitCode).toBe(1);
        expect(run.output()).toContain('fake-claude failed at await-onboarding-answer: onboarding_answered');
    });
    it('claude-bypass-permissions: Enter alone takes the default "No, exit" and quits', async () => {
        const run = startFake('claude-bypass-permissions');
        await run.waitForOutput(frame('claude/2.1.328/bypass-permissions.txt'));
        run.press('\r');
        expect(await run.exitCode).toBe(1);
        expect(run.output()).toContain('fake-claude failed at await-bypass-answer: bypass_declined');
    });
    it('claude-bypass-permissions: draws the idle prompt only after Down then Enter, and traces every read', async () => {
        const run = startFake('claude-bypass-permissions');
        await run.waitForOutput(frame('claude/2.1.328/bypass-permissions.txt'));
        expect(await traceSteps()).not.toContain('selector-read');
        run.press(DOWN);
        await run.waitForOutput('❯ Yes, I accept');
        const focusLines = (text) => text.split('\n').filter(line => /No, exit|Yes, I accept/.test(line));
        expect(focusLines(run.output().split('\x1b[H\x1b[J').at(-1)))
            .toEqual(focusLines(frame('claude/2.1.328/bypass-permissions-yes-focused.txt')));
        run.press('\r');
        await run.waitForOutput(frame('claude/2.1.325/idle.txt'));
        expect((await traceSteps()).filter(step => step === 'selector-read')).toHaveLength(2);
    });
    it('claude-fullscreen-renderer: answers trust, then takes Not now only after Down, then runs the lifecycle', async () => {
        const run = startFake('claude-fullscreen-renderer');
        await run.waitForOutput(frame('claude/2.1.325/trust.txt'));
        run.press(DOWN);
        await run.waitForOutput('❯ Yes, ');
        run.press('\r');
        await run.waitForOutput(frame('claude/2.1.328/fullscreen-renderer.txt'));
        run.press(DOWN);
        await run.waitForOutput('❯ 2. Not now');
        const focusLines = (text) => text.split('\n').filter(line => /1\. Yes, try it|2\. Not now/.test(line));
        expect(focusLines(run.output().split('\x1b[H\x1b[J').at(-1)))
            .toEqual(focusLines(frame('claude/2.1.328/fullscreen-renderer-not-now-focused.txt')));
        run.press('\r');
        await run.waitForOutput(frame('claude/2.1.328/idle-after-fullscreen-renderer.txt'));
        await runClaimLifecycle(run, '\ntask completed\n❯ ');
    });
    it('claude-fullscreen-renderer: Enter on "1. Yes, try it" fails', async () => {
        const run = startFake('claude-fullscreen-renderer');
        await run.waitForOutput(frame('claude/2.1.325/trust.txt'));
        run.press(DOWN);
        await run.waitForOutput('❯ Yes, ');
        run.press('\r');
        await run.waitForOutput(frame('claude/2.1.328/fullscreen-renderer.txt'));
        run.press('\r');
        expect(await run.exitCode).toBe(1);
        expect(run.output()).toContain('fake-claude failed at await-renderer-answer: fullscreen_renderer_accepted');
    });
    it('claude-slow-banner: holds the bypass banner for seconds before the idle prompt', async () => {
        const run = startFake('claude-slow-banner');
        await run.waitForOutput(frame('claude/unversioned/startup-banner-bypass.txt'));
        await run.waitForOutput(frame('claude/2.1.325/idle.txt'));
        // The provider's own trace times, so a late read by this process cannot shorten the gap.
        const drawnAt = await traceTimes();
        expect(drawnAt['idle-prompt'] - drawnAt['startup-banner']).toBeGreaterThanOrEqual(2_500);
        await runClaimLifecycle(run, '\ntask completed\n❯ ');
    });
    it('claude-busy-spinner: shows the spinner between claim and completion, then the done frame', async () => {
        const run = startFake('claude-busy-spinner');
        await run.waitForOutput(frame('claude/2.1.325/idle.txt'));
        await writeTaskInbox();
        sendStartupTrigger(run);
        await run.waitForOutput(frame('claude/2.1.325/busy-spinner.txt'));
        expect((await apiCalls()).map(call => call.operation)).toEqual(['claim-task']);
        await run.waitForOutput(frame('claude/2.1.325/done.txt'));
        expect((await apiCalls()).map(call => call.operation)).toEqual(['claim-task', 'transition-task-status']);
        await shutDown(run);
    });
    it('codex-hooks-review: waits for choice 3 before drawing the codex idle prompt', async () => {
        const run = startFake('codex-hooks-review');
        await run.waitForOutput(frame('codex/unversioned/hooks-review.txt'));
        run.send('1');
        await new Promise(resolveSleep => setTimeout(resolveSleep, 300));
        expect(run.output()).not.toContain(frame('codex/0.167.0/idle.txt'));
        run.send('3');
        await run.waitForOutput(frame('codex/0.167.0/idle.txt'));
        await runClaimLifecycle(run, frame('codex/0.167.0/done.txt'));
    });
    it.each([
        ['cursor-arrow-prompt', 'cursor/unversioned/idle-arrow.txt'],
        ['loading-in-scrollback', 'claude/synthetic/loading-in-scrollback.txt'],
    ])('%s: idles on the corpus frame and runs the claim lifecycle', async (scenario, idleFile) => {
        const run = startFake(scenario);
        await run.waitForOutput(frame(idleFile));
        await runClaimLifecycle(run, scenario === 'cursor-arrow-prompt' ? frame(idleFile) : '\ntask completed\n❯ ');
    });
    it('prompt-glyph-in-output: streams quoted output before drawing the input box', async () => {
        const run = startFake('prompt-glyph-in-output');
        const quotedAt = await run.waitForOutput(frame('claude/synthetic/prompt-glyph-in-output.txt'));
        const idleAt = await run.waitForOutput(frame('claude/2.1.325/idle.txt'));
        expect(idleAt - quotedAt).toBeGreaterThanOrEqual(1_500);
        await runClaimLifecycle(run, '\ntask completed\n❯ ');
    });
    it('provider-exit-to-shell-prompt: exits on its own after drawing a shell prompt', async () => {
        const run = startFake('provider-exit-to-shell-prompt');
        await run.waitForOutput(frame('claude/2.1.325/idle.txt'));
        expect(await run.exitCode).toBe(0);
        expect(run.output().endsWith(frame('claude/synthetic/shell-prompt-after-exit-heavy-angle.txt'))).toBe(true);
        expect(await apiCalls()).toEqual([]);
    });
    it('provider-exit-before-prompt: exits at once, leaving only a shell prompt', async () => {
        const run = startFake('provider-exit-before-prompt');
        expect(await run.exitCode).toBe(0);
        expect(run.output().endsWith(frame('claude/synthetic/shell-prompt-after-exit-heavy-angle.txt'))).toBe(true);
        expect(run.output()).not.toContain(frame('claude/2.1.325/idle.txt'));
        expect(await apiCalls()).toEqual([]);
    });
    it('recovery-continuation: checkpoints and completes the adopted task without claiming it', async () => {
        vi.stubEnv('CLAUDE_PLUGIN_ROOT', '');
        const instruction = renderRecoveryContinuationInstruction({
            teamName: 't',
            workerName: 'worker-1',
            taskId: '7',
            claimToken: 'adopted-token',
            taskVersion: 4,
            sequence: 2,
            resumePayload: { step: 'tests' },
        });
        vi.unstubAllEnvs();
        expect(instruction.startsWith('## Recovery Continuation')).toBe(true);
        const run = startFake('recovery-continuation');
        await run.waitForOutput('❯ ');
        await writeFile(inboxPath, instruction);
        sendStartupTrigger(run);
        await run.waitForOutput('\ntask completed\n❯ ');
        expect(await apiCalls()).toEqual([
            {
                operation: 'write-task-checkpoint',
                input: { team_name: 't', task_id: '7', worker: 'worker-1', claim_token: 'adopted-token', task_version: 4, sequence: 3, resume_payload: {} },
            },
            {
                operation: 'transition-task-status',
                input: expect.objectContaining({ team_name: 't', task_id: '7', from: 'in_progress', to: 'completed', claim_token: 'adopted-token' }),
            },
        ]);
        await shutDown(run);
    });
    it('recovery-continuation: fails on a recovery section it cannot parse and calls no task API', async () => {
        const run = startFake('recovery-continuation');
        await run.waitForOutput('❯ ');
        await writeFile(inboxPath, '## Recovery Continuation\nYou own adopted task 1 at checkpoint sequence 1.\n');
        sendStartupTrigger(run);
        expect(await run.exitCode).toBe(1);
        expect(run.output()).toContain('fake-claude failed at read-inbox: recovery_continuation_unparseable');
        expect(await apiCalls()).toEqual([]);
    });
    it('recovery-continuation: claims a fresh task inbox like the default scenario', async () => {
        const run = startFake('recovery-continuation');
        await run.waitForOutput('❯ ');
        await runClaimLifecycle(run, '\ntask completed\n❯ ');
    });
    it('selects a scenario from OMC_FAKE_PROVIDER_SCENARIO', async () => {
        const run = startFake('cursor-arrow-prompt', 'env');
        await run.waitForOutput(frame('cursor/unversioned/idle-arrow.txt'));
        expect(run.output()).not.toContain('fake-claude for omc team tmux smoke');
    });
    it.each(['no-such-scenario', 'constructor'])('rejects the unknown scenario %s', async (scenario) => {
        const run = startFake(scenario);
        expect(await run.exitCode).toBe(2);
        expect(run.output()).toContain(`fake-claude: unknown scenario ${scenario}`);
    });
});
//# sourceMappingURL=fake-team-provider.scenarios.test.js.map