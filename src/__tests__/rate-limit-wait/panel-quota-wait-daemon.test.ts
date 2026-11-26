/**
 * Tests for the opt-in provider quota wait of worker panels (panel-quota-wait.ts): the daemon entry point, the real reading and the monitor gate.
 * Offline: tmux is an injected fake (screens as data), the clock is set by the test, and the provider reading comes
 * from a loopback HTTP stub. The helpers are in panel-quota-wait-fixtures.ts.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createServer, type Server } from 'http';
import { type AddressInfo } from 'net';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { runDaemonPanelQuotaPass, type PanelEnv, type PanelTmux } from '../../features/rate-limit-wait/panel-quota-wait.js';
import { checkPanelQuotaStatus } from '../../features/rate-limit-wait/rate-limit-monitor.js';
import { BASE_MS, ERR_1308, H, KEY_A, ON, PANE_A, reading, screen } from './panel-quota-wait-fixtures.js';

describe('panel quota wait: daemon entry point and real reading', () => {
  let dir: string;
  let server: Server | null = null;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'panel-quota-wait-'));
  });

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve) => server?.close(() => resolve()));
      server = null;
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it('real reading over loopback: the key is sent as Bearer and never reaches state, journal or log', async () => {
    const SENTINEL = 'SENTINEL-KEY-7f3a91c2';
    const keyFile = join(dir, 'key');
    writeFileSync(keyFile, `${SENTINEL}\n`);
    const seen: string[] = [];
    server = createServer((req, res) => {
      seen.push(req.headers.authorization ?? '');
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ success: true, data: { limits: [{ unit: 3, percentage: 100, nextResetTime: BASE_MS + H }] } }));
    });
    await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', () => resolve()));
    const port = (server.address() as AddressInfo).port;
    const env: PanelEnv = {
      ...ON,
      OMC_PANEL_QUOTA_KEY_FILE: keyFile,
      OMC_PANEL_QUOTA_READ_URL: `http://127.0.0.1:${port}/quota`,
      OMC_PANEL_QUOTA_JOURNAL: join(dir, 'journal.jsonl'),
    };
    const log: string[] = [];
    const sent: string[] = [];
    const tmux: PanelTmux = {
      listPanes: () => [PANE_A],
      capture: () => screen(ERR_1308),
      sendContinue: (pane) => { sent.push(pane.id); return 'delivered'; },
      providerRunning: () => true,
    };
    const stateDir = join(dir, 'daemon');
    await runDaemonPanelQuotaPass({ stateDir, env, tmux, log: (t) => log.push(t), now: () => BASE_MS });
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    server = null;

    const stateText = readFileSync(join(stateDir, 'provider-quota-panels.json'), 'utf8');
    const journalText = existsSync(join(dir, 'journal.jsonl')) ? readFileSync(join(dir, 'journal.jsonl'), 'utf8') : '';
    expect(seen.length).toBeGreaterThanOrEqual(1);
    expect(seen[0]).toBe(`Bearer ${SENTINEL}`);
    expect(stateText).toContain('waiting_quota');
    expect(stateText + journalText + log.join('\n')).not.toContain(SENTINEL);
    expect(sent).toHaveLength(0);
  });

  it('switch off: runDaemonPanelQuotaPass writes nothing and returns null', async () => {
    const tmux: PanelTmux = {
      listPanes: () => [PANE_A],
      capture: () => screen(ERR_1308),
      sendContinue: () => 'delivered',
      providerRunning: () => true,
    };
    const offDir = join(dir, 'off');
    const out = await runDaemonPanelQuotaPass({ stateDir: offDir, env: {}, tmux, now: () => BASE_MS });
    expect(out).toBeNull();
    expect(existsSync(offDir)).toBe(false);
  });

  it('a missing key file gives no reading: the wait ends with class quota and no keys are sent', async () => {
    const sent: string[] = [];
    const tmux: PanelTmux = {
      listPanes: () => [PANE_A],
      capture: () => screen(ERR_1308),
      sendContinue: (pane) => { sent.push(pane.id); return 'delivered'; },
      providerRunning: () => true,
    };
    const env: PanelEnv = {
      ...ON,
      OMC_PANEL_QUOTA_KEY_FILE: join(dir, 'no-such-key'),
      OMC_PANEL_QUOTA_READ_URL: 'https://example.invalid/quota',
    };
    const state = await runDaemonPanelQuotaPass({ stateDir: join(dir, 'daemon'), env, tmux, now: () => BASE_MS });
    expect(state?.panes[KEY_A]?.state).toBe('quota-ended');
    expect(sent).toHaveLength(0);
  });
});

describe('panel quota wait: monitor reading is gated by the switch', () => {
  const MONITOR_VARS = ['OMC_PANEL_QUOTA_WAIT', 'OMC_PANEL_QUOTA_KEY_FILE', 'OMC_PANEL_QUOTA_READ_URL'];
  let dir: string;
  let server: Server | null = null;
  let requests = 0;
  let savedEnv: Record<string, string | undefined>;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'panel-quota-switch-'));
    savedEnv = Object.fromEntries(MONITOR_VARS.map((name) => [name, process.env[name]]));
    requests = 0;
    server = createServer((_req, res) => {
      requests += 1;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ success: true, data: { limits: [{ unit: 3, percentage: 100, nextResetTime: BASE_MS + H }] } }));
    });
    await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', () => resolve()));
    const keyFile = join(dir, 'key');
    writeFileSync(keyFile, 'SWITCH-TEST-KEY\n');
    // The URL and the key are set, so a read would really reach the stub: the null below comes from the switch alone.
    process.env.OMC_PANEL_QUOTA_KEY_FILE = keyFile;
    process.env.OMC_PANEL_QUOTA_READ_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/quota`;
  });

  afterEach(async () => {
    for (const name of MONITOR_VARS) {
      if (savedEnv[name] === undefined) delete process.env[name];
      else process.env[name] = savedEnv[name];
    }
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    server = null;
    rmSync(dir, { recursive: true, force: true });
  });

  it('switch off: null without reading, and no request reaches the provider', async () => {
    delete process.env.OMC_PANEL_QUOTA_WAIT;
    expect(await checkPanelQuotaStatus()).toBeNull();
    expect(requests).toBe(0);
  });

  it('switch on: the same setup reads once through the provider endpoint', async () => {
    process.env.OMC_PANEL_QUOTA_WAIT = '1';
    expect(await checkPanelQuotaStatus()).not.toBeNull();
    expect(requests).toBe(1);
  });
});
