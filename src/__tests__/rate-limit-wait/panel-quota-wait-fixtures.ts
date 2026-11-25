/**
 * Helpers of the panel quota wait tests: screens, readings and a fake tmux world with a clock the test sets.
 */
import { paneKey, type PanelEnv, type PanelQuotaDeps, type PanePoint, type QuotaReading } from '../../features/rate-limit-wait/panel-quota-wait.js';


export const H = 3600_000;
export const BASE_MS = Date.parse('2026-11-16T06:00:00Z');
export const ERR_1308 = 'API Error: 429 {"error":{"code":1308,"message":"usage limit"}}';
export const ERR_1310 = '{"error":{"code":"1310"}}';
// Example preset: Z.ai codes 1308 (5 h window, waits) and 1310 (week or month, never resumed).
export const ON: PanelEnv = {
  OMC_PANEL_QUOTA_WAIT: '1',
  OMC_PANEL_QUOTA_WAIT_MARGIN_S: '0',
  OMC_PANEL_QUOTA_WAIT_CODES: '1308',
  OMC_PANEL_QUOTA_END_CODES: '1310',
};
export const WRAPPER_LINE = 'external wrapper: quota wait until the reset (attempt 1)';

export function screen(text: string, filler = 0): string {
  const lines: string[] = [];
  for (let i = 0; i < filler; i++) lines.push(`line ${i}`);
  lines.push(text);
  return lines.join('\n');
}

// Limits in the shape the provider reading uses: unit 3 = 5 h window, unit 6 = week.
export function reading(limits: Array<{ unit: number; percentage: number; nextResetTime: number }>): QuotaReading {
  return { body: { data: { limits } } };
}
export const exhausted5h = (resetMs: number): QuotaReading => reading([{ unit: 3, percentage: 100, nextResetTime: resetMs }]);
export const exhaustedWeek = (resetMs: number): QuotaReading => reading([{ unit: 6, percentage: 100, nextResetTime: resetMs }]);

export interface World {
  clock: { now: number };
  /** null: the pane inventory cannot be read. */
  panes: PanePoint[] | null;
  /** Provider state by pane id; a pane that is not listed runs its provider. */
  running: Record<string, boolean | null>;
  screens: Record<string, string>;
  reading: { value: QuotaReading | null };
  sent: string[];
  log: string[];
  journal: Array<Record<string, unknown>>;
  deps: PanelQuotaDeps;
}

export function world(init: { panes: PanePoint[]; screens: Record<string, string>; readingValue: QuotaReading | null }): World {
  const w: World = {
    clock: { now: BASE_MS },
    panes: init.panes,
    running: {},
    screens: init.screens,
    reading: { value: init.readingValue },
    sent: [],
    log: [],
    journal: [],
    deps: undefined as unknown as PanelQuotaDeps,
  };
  w.deps = {
    now: () => w.clock.now,
    listPanes: () => w.panes,
    capture: (pane) => (Object.prototype.hasOwnProperty.call(w.screens, pane.id) ? w.screens[pane.id] : null),
    sendContinue: (pane) => { w.sent.push(pane.id); return 'delivered'; },
    providerRunning: (pane) => (Object.prototype.hasOwnProperty.call(w.running, pane.id) ? w.running[pane.id] : true),
    readQuota: async () => w.reading.value,
    log: (t) => { w.log.push(t); },
    journal: (row) => { w.journal.push(row); },
  };
  return w;
}

export const PANE_A: PanePoint = { id: '%7', session: 'omc-team-a', windowIndex: 0, paneIndex: 1 };
export const PANE_B: PanePoint = { id: '%8', session: 'omc-team-a', windowIndex: 0, paneIndex: 2 };
export const KEY_A = paneKey(PANE_A);
