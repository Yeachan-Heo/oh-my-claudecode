import { describe, expect, it, afterEach, beforeEach } from 'vitest';
import { createHmac } from 'crypto';
import fs, { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { CI_ROUTE_TABLE, buildDiagnosePrompt, processCheckFailureEvent, routeCheckFailure, startListener, stopListener, } from '../listener.js';
import { AFK_ALLOWED_TOOLS, AFK_SPAWN_FLAGS, factoryLinkArgv } from '../../hooks/session-end/spawn-next.js';
import { getOmcRoot } from '../../lib/worktree-paths.js';
const SECRET = 'test-secret';
const WHITELIST = ['pangpang778/factory-demo'];
const tempCwds = [];
let previousOmcStateDir;
let stateRoot;
beforeEach(() => {
    previousOmcStateDir = process.env.OMC_STATE_DIR;
    stateRoot = mkdtempSync(join(tmpdir(), 'omc-factory-state-'));
    tempCwds.push(stateRoot);
    process.env.OMC_STATE_DIR = stateRoot;
});
function tempCwd() {
    const dir = mkdtempSync(join(tmpdir(), 'omc-checkrun-'));
    tempCwds.push(dir);
    return dir;
}
function config(overrides = {}) {
    return { port: 0, secret: SECRET, whitelist: WHITELIST, cwd: tempCwd(), ...overrides };
}
afterEach(() => {
    if (previousOmcStateDir === undefined)
        delete process.env.OMC_STATE_DIR;
    else
        process.env.OMC_STATE_DIR = previousOmcStateDir;
    for (const dir of tempCwds)
        rmSync(dir, { recursive: true, force: true });
    tempCwds.length = 0;
});
function checkEvent(overrides = {}) {
    return {
        action: 'completed',
        check_suite: { conclusion: 'failure', head_branch: 'main' },
        repository: { full_name: 'pangpang778/factory-demo' },
        ...overrides,
    };
}
function signedBody(payload) {
    const body = JSON.stringify(payload);
    return { body, signature: `sha256=${createHmac('sha256', SECRET).update(body, 'utf8').digest('hex')}` };
}
describe('CI_ROUTE_TABLE', () => {
    it('routes failed:ci to the diagnose stage', () => {
        expect(CI_ROUTE_TABLE).toEqual({ 'failed:ci': { stage: 'diagnose', skill: 'diagnose' } });
    });
});
describe('routeCheckFailure', () => {
    it('routes a completed failure to the diagnose directive', () => {
        const r = routeCheckFailure(checkEvent(), WHITELIST);
        expect(r).toEqual({ kind: 'routed', directive: { stage: 'diagnose', skill: 'diagnose' } });
    });
    it('discards a successful check run', () => {
        const r = routeCheckFailure(checkEvent({ check_suite: { conclusion: 'success', head_branch: 'main' } }), WHITELIST);
        expect(r.kind).toBe('discarded');
        expect(r).toMatchObject({ reason: expect.stringContaining('not a failed check run') });
    });
    it('discards a non-completed action', () => {
        const r = routeCheckFailure(checkEvent({ action: 'requested' }), WHITELIST);
        expect(r.kind).toBe('discarded');
    });
    it('rejects repos outside the whitelist', () => {
        const r = routeCheckFailure(checkEvent({ repository: { full_name: 'someone/else' } }), WHITELIST);
        expect(r).toEqual({ kind: 'rejected', status: 403, reason: 'repository outside whitelist: someone/else' });
    });
    it('discards when the route table has no ci directive', () => {
        const r = routeCheckFailure(checkEvent(), WHITELIST, {});
        expect(r.kind).toBe('discarded');
    });
});
describe('processCheckFailureEvent', () => {
    it('spawns a headless diagnose session with the same narrow AFK tool profile', () => {
        const cfg = config();
        const spawned = [];
        const result = processCheckFailureEvent(checkEvent(), cfg, { spawner: (cmd, args, ctx) => spawned.push({ cmd, args, ctx }) });
        expect(result).toMatchObject({ status: 202, kind: 'accepted', detail: 'spawned diagnose session (diagnose)' });
        expect(spawned).toHaveLength(1);
        expect(spawned[0].cmd).toBe('claude');
        const args = spawned[0].args;
        expect(args[0]).toBe('-p');
        const sessionId = args[3];
        expect(sessionId).toMatch(/^[0-9a-f-]{36}$/);
        // Identical link argv shape and AFK permission profile as every other chain link.
        expect(args).toEqual(factoryLinkArgv(args[1], sessionId));
        expect(args.slice(4)).toEqual(AFK_SPAWN_FLAGS);
        const allowedIdx = args.indexOf('--allowedTools');
        expect(args[allowedIdx + 1]).toBe(AFK_ALLOWED_TOOLS);
        expect(spawned[0].ctx).toEqual({ cwd: cfg.cwd });
    });
    it('builds the diagnose prompt for the failing repo and branch', () => {
        const spawned = [];
        processCheckFailureEvent(checkEvent(), config(), { spawner: (cmd, args) => spawned.push([cmd, args]) });
        expect(spawned[0][1][1]).toBe(buildDiagnosePrompt({ stage: 'diagnose', skill: 'diagnose' }, 'pangpang778/factory-demo', 'main'));
    });
    it('pre-writes a diagnose ledger without tracker fields', () => {
        const cfg = config();
        const spawned = [];
        processCheckFailureEvent(checkEvent(), cfg, { spawner: (cmd, args) => spawned.push([cmd, args]) });
        const sessionId = spawned[0][1][3];
        const ledgerPath = join(getOmcRoot(cfg.cwd), 'state', 'factory', `chain-${sessionId}.json`);
        const ledger = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));
        expect(ledger.stage).toBe('diagnose');
        expect(ledger.intentId).toBe('pangpang778-factory-demo-ci-main');
        expect(ledger.tracker).toBeUndefined();
    });
    it('rejects out-of-whitelist repos with an audit record and no spawn', () => {
        const audits = [];
        const spawned = [];
        const result = processCheckFailureEvent(checkEvent({ repository: { full_name: 'someone/else' } }), config(), {
            spawner: (cmd, args) => spawned.push([cmd, args]),
            audit: (r) => audits.push(r),
        });
        expect(result).toMatchObject({ status: 403, kind: 'rejected' });
        expect(spawned).toEqual([]);
        expect(audits).toEqual([{ kind: 'rejected', status: 403, reason: 'repository outside whitelist: someone/else' }]);
    });
    it('discards successful conclusions without spawning', () => {
        const spawned = [];
        const result = processCheckFailureEvent(checkEvent({ check_suite: { conclusion: 'success', head_branch: 'main' } }), config(), {
            spawner: (cmd, args) => spawned.push([cmd, args]),
        });
        expect(result).toMatchObject({ status: 204, kind: 'discarded' });
        expect(spawned).toEqual([]);
    });
});
describe('check-run listener route', () => {
    it('spawns a diagnose session for a signed check-suite failure end to end', async () => {
        const spawned = [];
        const cfg = config({ port: 0 });
        const server = await startListener(cfg, { spawner: (cmd, args, ctx) => spawned.push({ cmd, args, ctx }) });
        try {
            const port = server.address().port;
            const { body, signature } = signedBody(checkEvent());
            const res = await fetch(`http://127.0.0.1:${port}`, { method: 'POST', headers: { 'x-hub-signature-256': signature }, body });
            expect(res.status).toBe(202);
            expect((await res.json()).detail).toBe('spawned diagnose session (diagnose)');
            expect(spawned).toHaveLength(1);
            expect(spawned[0].args.slice(4)).toEqual(AFK_SPAWN_FLAGS);
            expect(spawned[0].ctx).toEqual({ cwd: cfg.cwd });
        }
        finally {
            stopListener(server, cfg.cwd);
        }
    });
    it('discards a signed success conclusion with 204 and never spawns', async () => {
        const spawned = [];
        const cfg = config({ port: 0 });
        const server = await startListener(cfg, { spawner: (cmd, args) => spawned.push([cmd, args]) });
        try {
            const port = server.address().port;
            const { body, signature } = signedBody(checkEvent({ check_suite: { conclusion: 'success', head_branch: 'main' } }));
            const res = await fetch(`http://127.0.0.1:${port}`, { method: 'POST', headers: { 'x-hub-signature-256': signature }, body });
            expect(res.status).toBe(204);
            expect(spawned).toEqual([]);
        }
        finally {
            stopListener(server, cfg.cwd);
        }
    });
    it('rejects a signed failure from a non-whitelisted repo with 403', async () => {
        const spawned = [];
        const cfg = config({ port: 0 });
        const server = await startListener(cfg, { spawner: (cmd, args) => spawned.push([cmd, args]) });
        try {
            const port = server.address().port;
            const { body, signature } = signedBody(checkEvent({ repository: { full_name: 'someone/else' } }));
            const res = await fetch(`http://127.0.0.1:${port}`, { method: 'POST', headers: { 'x-hub-signature-256': signature }, body });
            expect(res.status).toBe(403);
            expect(spawned).toEqual([]);
        }
        finally {
            stopListener(server, cfg.cwd);
        }
    });
});
//# sourceMappingURL=check-run.test.js.map