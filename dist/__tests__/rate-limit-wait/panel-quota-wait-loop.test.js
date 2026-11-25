/**
 * Integration of the panel quota pass with the real daemon poll loop (daemon.ts, pollLoopWithConfigFile).
 * Tmux is replaced by a fake. The provider reading is a fake, except in the one test that turns on the
 * real reading, which goes through a loopback HTTP stub. The Claude limit check is stubbed to null, so
 * no real tmux, no real key and no live provider are used. Fake timers drive the poll interval.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createServer } from 'http';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
// Captured before any fake timers are installed, so the test can wait on real I/O.
const realSetTimeout = globalThis.setTimeout;
const fake = vi.hoisted(() => ({
    panes: [],
    screen: '',
    sent: [],
    reads: 0,
    listCalls: 0,
    realReading: false,
}));
vi.mock('../../features/rate-limit-wait/tmux-detector.js', async (importOriginal) => ({
    ...(await importOriginal()),
    panelQuotaTmux: {
        listPanes: () => {
            fake.listCalls++;
            return fake.panes;
        },
        capture: () => fake.screen,
        sendContinue: (pane) => {
            fake.sent.push(pane.id);
            return 'delivered';
        },
    },
}));
vi.mock('../../features/rate-limit-wait/rate-limit-monitor.js', async (importOriginal) => {
    const original = await importOriginal();
    return {
        ...original,
        checkRateLimitStatus: async () => null,
        checkPanelQuotaStatus: async () => {
            if (fake.realReading)
                return original.checkPanelQuotaStatus();
            fake.reads++;
            return { body: { data: { limits: [{ unit: 3, percentage: 100, nextResetTime: Date.now() + 3600_000 }] } } };
        },
    };
});
const ERR_1308 = 'API Error: 429 {"error":{"code":1308,"message":"usage limit"}}';
const PANE = { id: '%7', session: 'omc-team-a', windowIndex: 0, paneIndex: 1 };
const SWITCH_VARS = [
    'OMC_PANEL_QUOTA_WAIT',
    'OMC_PANEL_QUOTA_WAIT_CODES',
    'OMC_PANEL_QUOTA_END_CODES',
    'OMC_PANEL_QUOTA_JOURNAL',
    'OMC_PANEL_QUOTA_KEY_FILE',
    'OMC_PANEL_QUOTA_READ_URL',
];
let dir;
let savedEnv;
function configFile() {
    const path = join(dir, 'config.json');
    writeFileSync(path, JSON.stringify({
        pollIntervalMs: 500,
        stateFilePath: join(dir, 'state', 'rate-limit-daemon.json'),
        pidFilePath: join(dir, 'state', 'rate-limit-daemon.pid'),
        logFilePath: join(dir, 'state', 'rate-limit-daemon.log'),
        paneLinesToCapture: 15,
        verbose: false,
    }));
    return path;
}
function readIfExists(path) {
    return existsSync(path) ? readFileSync(path, 'utf8') : '';
}
const logPath = () => join(dir, 'state', 'rate-limit-daemon.log');
const statePath = () => join(dir, 'state', 'provider-quota-panels.json');
const journalPath = () => join(dir, 'journal.jsonl');
/** Starts the real poll loop on fake timers and lets it run for two poll intervals. */
async function runPollLoop() {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    vi.setSystemTime(new Date('2026-11-16T06:00:00Z'));
    const { pollLoopWithConfigFile } = await import('../../features/rate-limit-wait/daemon.js');
    void pollLoopWithConfigFile(configFile());
    await vi.advanceTimersByTimeAsync(600);
}
beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'panel-quota-loop-'));
    savedEnv = Object.fromEntries(SWITCH_VARS.map((name) => [name, process.env[name]]));
    fake.panes = [PANE];
    fake.screen = `working...\n${ERR_1308}`;
    fake.sent = [];
    fake.reads = 0;
    fake.listCalls = 0;
    fake.realReading = false;
});
afterEach(() => {
    vi.useRealTimers();
    for (const name of SWITCH_VARS) {
        if (savedEnv[name] === undefined)
            delete process.env[name];
        else
            process.env[name] = savedEnv[name];
    }
    rmSync(dir, { recursive: true, force: true });
});
describe('panel quota pass in the daemon poll loop', () => {
    it('switch on: the loop starts, runs the pass, the 1308 pane waits, and no key is sent', async () => {
        process.env.OMC_PANEL_QUOTA_WAIT = '1';
        process.env.OMC_PANEL_QUOTA_WAIT_CODES = '1308';
        process.env.OMC_PANEL_QUOTA_END_CODES = '1310';
        process.env.OMC_PANEL_QUOTA_JOURNAL = journalPath();
        await runPollLoop();
        const log = readIfExists(logPath());
        expect(log, 'the daemon log has the loop start line').toContain('Starting poll loop');
        expect(log).not.toContain('Panel quota pass failed');
        expect(existsSync(statePath())).toBe(true);
        const state = JSON.parse(readFileSync(statePath(), 'utf8'));
        const entries = Object.values(state.panes);
        expect(entries).toHaveLength(1);
        expect(entries[0].state).toBe('waiting_quota');
        expect(entries[0].waits).toBe(1);
        expect(readIfExists(journalPath())).toContain('"result":"quota-wait"');
        expect(fake.reads).toBeGreaterThanOrEqual(1);
        expect(fake.reads, 'one reading per detection, not per poll').toBeLessThanOrEqual(4);
        expect(fake.listCalls, 'the pass lists the panes through tmux').toBeGreaterThan(0);
        expect(fake.sent).toHaveLength(0);
    });
    it('switch on, real reading: the key goes only to the provider endpoint, never to the state, journal or log', async () => {
        const SENTINEL = 'LOOP-SENTINEL-KEY-2c9d';
        const keyFile = join(dir, 'key');
        writeFileSync(keyFile, `${SENTINEL}\n`);
        const seen = [];
        const server = createServer((req, res) => {
            seen.push(req.headers.authorization ?? '');
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ success: true, data: { limits: [{ unit: 3, percentage: 100, nextResetTime: Date.now() + 3600_000 }] } }));
        });
        await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
        try {
            fake.realReading = true;
            process.env.OMC_PANEL_QUOTA_WAIT = '1';
            process.env.OMC_PANEL_QUOTA_WAIT_CODES = '1308';
            process.env.OMC_PANEL_QUOTA_END_CODES = '1310';
            process.env.OMC_PANEL_QUOTA_JOURNAL = journalPath();
            process.env.OMC_PANEL_QUOTA_KEY_FILE = keyFile;
            process.env.OMC_PANEL_QUOTA_READ_URL = `http://127.0.0.1:${server.address().port}/quota`;
            await runPollLoop();
            // The reading is real I/O: wait for the pass to write its decision before checking the files.
            for (let i = 0; i < 100 && !readIfExists(statePath()).includes('waiting_quota'); i++) {
                await new Promise((resolve) => realSetTimeout(resolve, 20));
            }
            expect(seen.length, 'the provider stub was asked').toBeGreaterThanOrEqual(1);
            expect(seen.length, 'one reading per detection, not per poll').toBeLessThanOrEqual(4);
            expect(seen[0]).toBe(`Bearer ${SENTINEL}`);
            expect(readIfExists(statePath())).toContain('waiting_quota');
            expect(readIfExists(journalPath())).toContain('"result":"quota-wait"');
            expect(readIfExists(logPath()) + readIfExists(statePath()) + readIfExists(journalPath())).not.toContain(SENTINEL);
            expect(fake.sent).toHaveLength(0);
        }
        finally {
            await new Promise((resolve) => server.close(() => resolve()));
        }
    });
    it('switch off: the loop starts but reads nothing, writes no panel state or journal rows, and sends no keys', async () => {
        delete process.env.OMC_PANEL_QUOTA_WAIT;
        process.env.OMC_PANEL_QUOTA_WAIT_CODES = '1308';
        process.env.OMC_PANEL_QUOTA_JOURNAL = journalPath();
        await runPollLoop();
        const log = readIfExists(logPath());
        expect(log).toContain('Starting poll loop');
        expect(log).not.toContain('Panel quota pass failed');
        expect(existsSync(statePath())).toBe(false);
        expect(existsSync(journalPath()), 'journal rows with the switch off').toBe(false);
        expect(fake.reads).toBe(0);
        expect(fake.listCalls, 'tmux is not called with the switch off').toBe(0);
        expect(fake.sent).toHaveLength(0);
    });
});
//# sourceMappingURL=panel-quota-wait-loop.test.js.map