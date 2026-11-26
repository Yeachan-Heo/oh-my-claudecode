/**
 * Helpers of the panel quota wait tests: screens, readings and a fake tmux world with a clock the test sets.
 */
import { type PanelEnv, type PanelQuotaDeps, type PanePoint, type QuotaReading } from '../../features/rate-limit-wait/panel-quota-wait.js';
export declare const H = 3600000;
export declare const BASE_MS: number;
export declare const ERR_1308 = "API Error: 429 {\"error\":{\"code\":1308,\"message\":\"usage limit\"}}";
export declare const ERR_1310 = "{\"error\":{\"code\":\"1310\"}}";
export declare const ON: PanelEnv;
export declare const WRAPPER_LINE = "external wrapper: quota wait until the reset (attempt 1)";
export declare function screen(text: string, filler?: number): string;
export declare function reading(limits: Array<{
    unit: number;
    percentage: number;
    nextResetTime: number;
}>): QuotaReading;
export declare const exhausted5h: (resetMs: number) => QuotaReading;
export declare const exhaustedWeek: (resetMs: number) => QuotaReading;
export interface World {
    clock: {
        now: number;
    };
    /** null: the pane inventory cannot be read. */
    panes: PanePoint[] | null;
    /** Provider state by pane id; a pane that is not listed runs its provider. */
    running: Record<string, boolean | null>;
    screens: Record<string, string>;
    reading: {
        value: QuotaReading | null;
    };
    sent: string[];
    log: string[];
    journal: Array<Record<string, unknown>>;
    deps: PanelQuotaDeps;
}
export declare function world(init: {
    panes: PanePoint[];
    screens: Record<string, string>;
    readingValue: QuotaReading | null;
}): World;
export declare const PANE_A: PanePoint;
export declare const PANE_B: PanePoint;
export declare const KEY_A: string;
//# sourceMappingURL=panel-quota-wait-fixtures.d.ts.map