/**
 * What the panel quota wait saves is only valid for what it was saved for. A state file that cannot be read is not an
 * empty one (the saved resume intents guard a key that cannot be taken back), and a saved wait belongs to a pane id of
 * one tmux server run (after a restart the same id can name an unrelated worker). The daemon entry point runs against a
 * real state file in a temporary directory; tmux, the clock and the provider reading are fakes.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  loadState,
  runDaemonPanelQuotaPass,
  type PanelEntry,
  type PanelEnv,
  type PanelState,
  type PanelTmux,
  type PanePoint,
  type QuotaReading,
} from '../../features/rate-limit-wait/panel-quota-wait.js';

const H = 3600_000;
const BASE_MS = Date.parse('2026-11-16T06:00:00Z');
const ERR_1308 = 'API Error: 429 {"error":{"code":1308,"message":"usage limit"}}';
const PANE: PanePoint = { id: '%7', session: 'omc-team-a', windowIndex: 0, paneIndex: 1, server: '4100:1795000000' };
const RESUMING: PanelEntry = {
  key: '%7', pane: '%7', session: 'omc-team-a', windowIndex: 0, paneIndex: 1, server: '4100:1795000000', waits: 1,
  state: 'resuming', resumedAt: BASE_MS + 2 * H, untilMs: BASE_MS + 2 * H, resetMs: BASE_MS + 2 * H,
};
const readingAt = (resetMs: number): QuotaReading => ({ body: { data: { limits: [{ unit: 3, percentage: 100, nextResetTime: resetMs }] } } });

describe('panel quota wait: saved state is checked before it is trusted', () => {
  let dir: string;
  let file: string;
  let env: PanelEnv;
  let sent: string[];
  let logs: string[];
  let reads: number;
  let panes: PanePoint[];
  let screen: string;
  let reading: QuotaReading;

  const tmux = (): PanelTmux => ({
    listPanes: () => panes,
    capture: () => screen,
    sendContinue: (pane) => { sent.push(pane.id); return 'delivered'; },
    providerRunning: () => true,
  });
  const pass = (nowMs: number) =>
    runDaemonPanelQuotaPass({
      stateDir: join(dir, 'daemon'),
      env,
      tmux: tmux(),
      readQuota: async () => { reads++; return reading; },
      log: (text) => logs.push(text),
      now: () => nowMs,
    });
  const stateOnDisk = (): PanelState => JSON.parse(readFileSync(file, 'utf8')) as PanelState;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'panel-quota-state-'));
    mkdirSync(join(dir, 'daemon'));
    file = join(dir, 'daemon', 'provider-quota-panels.json');
    env = { OMC_PANEL_QUOTA_WAIT: '1', OMC_PANEL_QUOTA_WAIT_MARGIN_S: '0', OMC_PANEL_QUOTA_WAIT_CODES: '1308' };
    sent = [];
    logs = [];
    reads = 0;
    panes = [PANE];
    screen = ERR_1308;
    reading = readingAt(BASE_MS + 2 * H);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  describe('a state file that cannot be read', () => {
    const unreadable: Array<[string, () => void]> = [
      ['a record cut off in the middle', () => writeFileSync(file, JSON.stringify({ panes: { '%7': RESUMING } }).slice(0, 60))],
      ['a JSON value that is not a state', () => writeFileSync(file, '[1,2,3]\n')],
      ['a state whose panes are not an object', () => writeFileSync(file, '{"panes":"none"}\n')],
      ['a state whose panes are an array', () => writeFileSync(file, '{"panes":[]}\n')],
      ['a wait without a reset time', () => writeFileSync(file, JSON.stringify({ panes: { '%7': { ...RESUMING, state: 'waiting_quota', untilMs: undefined } } }))],
      ['a wait whose reset time is not a number', () => writeFileSync(file, JSON.stringify({ panes: { '%7': { ...RESUMING, state: 'waiting_quota', untilMs: '2026-11-16' } } }))],
      ['a pane entry with an unknown state', () => writeFileSync(file, JSON.stringify({ panes: { '%7': { ...RESUMING, state: 'paused' } } }))],
      ['a pane entry whose wait count is not a number', () => writeFileSync(file, JSON.stringify({ panes: { '%7': { ...RESUMING, waits: 'one' } } }))],
      ['a cursor that is not a pane key', () => writeFileSync(file, JSON.stringify({ panes: {}, cursor: 7 }))],
      ['a path that cannot be read as a file', () => mkdirSync(file)],
    ];

    for (const [name, make] of unreadable) {
      it(`${name}: the pass stops, the file is left as it was, nothing is read or sent`, async () => {
        make();
        const before = existsSync(file) && !readFileSyncIsDirectory(file) ? readFileSync(file, 'utf8') : null;
        const result = await pass(BASE_MS + 2 * H);
        expect(result).toBeNull();
        expect(sent).toEqual([]);
        expect(reads).toBe(0);
        expect(logs.join('\n')).toContain('cannot be read');
        if (before !== null) expect(readFileSync(file, 'utf8'), 'the unreadable file was overwritten').toBe(before);
        // The same on the next poll: still nothing, still untouched.
        expect(await pass(BASE_MS + 2 * H + 60_000)).toBeNull();
        expect(sent).toEqual([]);
      });
    }

    it('a damaged file does not repeat a key that was recorded before it was damaged', async () => {
      writeFileSync(file, JSON.stringify({ panes: { '%7': RESUMING } }));
      const whole = readFileSync(file, 'utf8');
      writeFileSync(file, whole.slice(0, whole.length - 5));
      await pass(BASE_MS + 3 * H);
      expect(sent, 'the continue key went out again').toEqual([]);
      expect(readFileSync(file, 'utf8')).toBe(whole.slice(0, whole.length - 5));
    });

    it('only a missing file is an empty state: the pass runs and creates it', async () => {
      expect(loadState(file)).toEqual({ panes: {} });
      const result = await pass(BASE_MS);
      expect(result?.panes['%7'].state).toBe('waiting_quota');
      expect(stateOnDisk().panes['%7'].state).toBe('waiting_quota');
    });
  });

  describe('a wait is bound to the tmux server run that listed its pane', () => {
    beforeEach(async () => {
      await pass(BASE_MS);
      expect(stateOnDisk().panes['%7']).toMatchObject({ state: 'waiting_quota', server: '4100:1795000000' });
      expect(reads).toBe(1);
    });

    it('after a server restart the same pane id does not inherit the wait: no key, the new worker is read on its own', async () => {
      // The server restarted; %7 is a new worker whose reset is far away. The old wait would be due at BASE + 2 h.
      panes = [{ ...PANE, server: '9900:1795009999' }];
      reading = readingAt(BASE_MS + 4 * H + 30 * 60_000);
      const due = BASE_MS + 2 * H;
      const result = await pass(due);
      expect(sent, 'the new worker got the continue key of the old one').toEqual([]);
      expect(reads, 'the new worker was not read').toBe(2);
      expect(result?.panes['%7']).toMatchObject({ state: 'waiting_quota', server: '9900:1795009999', untilMs: BASE_MS + 4 * H + 30 * 60_000, waits: 1 });
      await pass(due + 60_000);
      expect(sent).toEqual([]);
    });

    it('after a server restart the new worker that shows no error loses the entry and gets no key', async () => {
      panes = [{ ...PANE, server: '9900:1795009999' }];
      screen = 'a clean screen';
      await pass(BASE_MS + 2 * H);
      expect(sent).toEqual([]);
      expect(stateOnDisk().panes['%7']).toBeUndefined();
    });

    it('a resume that was recorded under the old server run is not carried to the new one', async () => {
      const saved = stateOnDisk();
      saved.panes['%7'] = { ...saved.panes['%7'], state: 'resuming' };
      writeFileSync(file, JSON.stringify(saved));
      panes = [{ ...PANE, server: '9900:1795009999' }];
      screen = 'a clean screen';
      await pass(BASE_MS + 2 * H);
      expect(sent).toEqual([]);
      expect(stateOnDisk().panes['%7']).toBeUndefined();
    });

    it('the same server run keeps the wait when the pane moves or its session is renamed, and resumes once', async () => {
      panes = [{ ...PANE, session: 'omc-team-b', windowIndex: 2, paneIndex: 0 }];
      await pass(BASE_MS + 2 * H);
      expect(sent).toEqual(['%7']);
      expect(reads, 'a wait that was kept must not be read again').toBe(1);
    });

    it('an entry saved without a server value is not trusted once the listing carries one', async () => {
      const saved = stateOnDisk();
      delete saved.panes['%7'].server;
      writeFileSync(file, JSON.stringify(saved));
      await pass(BASE_MS + 2 * H);
      expect(sent).toEqual([]);
      expect(reads).toBe(2);
    });

    it('a listing without a server value cannot tell, and keeps the wait', async () => {
      panes = [{ id: '%7', session: 'omc-team-a', windowIndex: 0, paneIndex: 1 }];
      await pass(BASE_MS + 2 * H);
      expect(sent).toEqual(['%7']);
    });
  });
});

function readFileSyncIsDirectory(path: string): boolean {
  try {
    readFileSync(path);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EISDIR';
  }
}
