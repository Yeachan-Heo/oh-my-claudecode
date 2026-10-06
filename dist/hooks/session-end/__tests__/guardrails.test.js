import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { acquireChainSlot, releaseChainSlot, chainDayKey, DAILY_CHAIN_LIMIT, dailyChainLimit, readChainStopMarker, clearChainStopMarker, } from '../guardrails.js';
import { acquireFileLockSync, releaseFileLockSync } from '../../../lib/file-lock.js';
function permitOf(r) {
    if (!r.allowed)
        throw new Error(`expected permit, got ${r.reason}: ${r.detail}`);
    return r;
}
const tempRoots = [];
function tempStateRoot() {
    const dir = mkdtempSync(join(tmpdir(), 'omc-guardrails-'));
    tempRoots.push(dir);
    return dir;
}
afterEach(() => {
    for (const dir of tempRoots)
        rmSync(dir, { recursive: true, force: true });
    tempRoots.length = 0;
});
describe('chainDayKey', () => {
    it('formats the local calendar day', () => {
        expect(chainDayKey(new Date(2026, 8, 28, 23, 59, 59))).toBe('2026-09-28');
        expect(chainDayKey(new Date(2026, 8, 29, 0, 0, 0))).toBe('2026-09-29');
    });
});
describe('acquireChainSlot — serial single-session', () => {
    it('rejects an intentId with path metacharacters before any lock is taken', () => {
        const root = tempStateRoot();
        const result = acquireChainSlot('../../evil', root);
        expect(result.allowed).toBe(false);
        expect(result).toMatchObject({ reason: 'invalid-intent-id' });
    });
    it('rejects the second concurrent link while the first is active', () => {
        const root = tempStateRoot();
        const first = acquireChainSlot('intent-a', root);
        expect(first.allowed).toBe(true);
        const second = acquireChainSlot('intent-a', root);
        expect(second.allowed).toBe(false);
        if (!second.allowed) {
            expect(second.reason).toBe('serial-conflict');
            expect(second.detail).toContain('串行');
        }
        releaseChainSlot(permitOf(first));
    });
    it('admits the next link once the active one releases', () => {
        const root = tempStateRoot();
        const first = acquireChainSlot('intent-b', root);
        releaseChainSlot(permitOf(first));
        const second = acquireChainSlot('intent-b', root);
        expect(second.allowed).toBe(true);
        releaseChainSlot(permitOf(second));
    });
    it('keeps separate intents independent', () => {
        const root = tempStateRoot();
        const a = acquireChainSlot('intent-a', root);
        const b = acquireChainSlot('intent-b', root);
        expect(a.allowed).toBe(true);
        expect(b.allowed).toBe(true);
        releaseChainSlot(permitOf(a));
        releaseChainSlot(permitOf(b));
    });
});
describe('acquireChainSlot — daily N=10 cap', () => {
    it('rejects the 11th link of the day and leaves a stop marker', () => {
        const root = tempStateRoot();
        for (let i = 0; i < DAILY_CHAIN_LIMIT; i++) {
            const permit = acquireChainSlot('intent-c', root);
            expect(permit.allowed).toBe(true);
            releaseChainSlot(permitOf(permit));
        }
        const eleventh = acquireChainSlot('intent-c', root);
        expect(eleventh.allowed).toBe(false);
        if (!eleventh.allowed) {
            expect(eleventh.reason).toBe('daily-cap');
            expect(eleventh.detail).toContain('链停住');
        }
        const marker = readChainStopMarker('intent-c', root);
        expect(marker).toMatchObject({ intentId: 'intent-c', reason: 'daily-cap', count: DAILY_CHAIN_LIMIT });
    });
    it('resets across days', () => {
        const root = tempStateRoot();
        const yesterday = new Date(2026, 8, 27, 12, 0, 0);
        const today = new Date(2026, 8, 28, 12, 0, 0);
        for (let i = 0; i < DAILY_CHAIN_LIMIT; i++) {
            const permit = acquireChainSlot('intent-d', root, yesterday);
            expect(permit.allowed).toBe(true);
            releaseChainSlot(permitOf(permit));
        }
        const nextDay = acquireChainSlot('intent-d', root, today);
        expect(nextDay.allowed).toBe(true);
        releaseChainSlot(permitOf(nextDay));
    });
    it('daily cap of one intent does not touch another', () => {
        const root = tempStateRoot();
        for (let i = 0; i < DAILY_CHAIN_LIMIT; i++) {
            const permit = acquireChainSlot('intent-e', root);
            releaseChainSlot(permitOf(permit));
        }
        expect(acquireChainSlot('intent-f', root).allowed).toBe(true);
    });
    it('a serial-conflict rejection does not write the stop marker', () => {
        const root = tempStateRoot();
        const first = acquireChainSlot('intent-g', root);
        acquireChainSlot('intent-g', root);
        expect(readChainStopMarker('intent-g', root)).toBeNull();
        releaseChainSlot(permitOf(first));
    });
    it('clearing the stop marker removes the audit record', () => {
        const root = tempStateRoot();
        const dir = root;
        writeFileSync(join(dir, 'chain-intent-h.stopped.json'), JSON.stringify({ intentId: 'intent-h', reason: 'daily-cap', dateKey: '2026-09-28', count: 10, stoppedAt: 'x' }));
        expect(readChainStopMarker('intent-h', root)).not.toBeNull();
        clearChainStopMarker('intent-h', root);
        expect(existsSync(join(dir, 'chain-intent-h.stopped.json'))).toBe(false);
    });
    it('a daily-cap rejection releases the serial lock', () => {
        const root = tempStateRoot();
        for (let i = 0; i < DAILY_CHAIN_LIMIT; i++) {
            releaseChainSlot(permitOf(acquireChainSlot('intent-cap', root)));
        }
        expect(acquireChainSlot('intent-cap', root).allowed).toBe(false);
        const serialLock = acquireFileLockSync(join(root, 'chain-intent-cap.active.lock'), { staleLockMs: 24 * 60 * 60 * 1000 });
        expect(serialLock).not.toBeNull();
        if (serialLock)
            releaseFileLockSync(serialLock);
    });
    it('a held usage lock rejects without writing the counter or leaking the serial lock', () => {
        const root = tempStateRoot();
        const usageLock = acquireFileLockSync(join(root, 'chain-usage.json.lock'));
        expect(usageLock).not.toBeNull();
        const result = acquireChainSlot('intent-usage', root);
        expect(result.allowed).toBe(false);
        if (usageLock)
            releaseFileLockSync(usageLock);
        expect(existsSync(join(root, 'chain-usage.json'))).toBe(false);
        const retry = acquireChainSlot('intent-usage', root);
        expect(retry.allowed).toBe(true);
        if (retry.allowed)
            releaseChainSlot(retry);
    });
});
describe('dailyChainLimit', () => {
    it('returns the default when the env var is unset', () => {
        const saved = process.env.OMC_DAILY_CHAIN_LIMIT;
        delete process.env.OMC_DAILY_CHAIN_LIMIT;
        try {
            expect(dailyChainLimit()).toBe(DAILY_CHAIN_LIMIT);
        }
        finally {
            if (saved !== undefined)
                process.env.OMC_DAILY_CHAIN_LIMIT = saved;
        }
    });
    it('honours a positive env override', () => {
        const saved = process.env.OMC_DAILY_CHAIN_LIMIT;
        process.env.OMC_DAILY_CHAIN_LIMIT = '25';
        try {
            expect(dailyChainLimit()).toBe(25);
        }
        finally {
            if (saved !== undefined)
                process.env.OMC_DAILY_CHAIN_LIMIT = saved;
            else
                delete process.env.OMC_DAILY_CHAIN_LIMIT;
        }
    });
    it('falls back to the default for invalid values', () => {
        const saved = process.env.OMC_DAILY_CHAIN_LIMIT;
        process.env.OMC_DAILY_CHAIN_LIMIT = '-5';
        try {
            expect(dailyChainLimit()).toBe(DAILY_CHAIN_LIMIT);
        }
        finally {
            if (saved !== undefined)
                process.env.OMC_DAILY_CHAIN_LIMIT = saved;
            else
                delete process.env.OMC_DAILY_CHAIN_LIMIT;
        }
    });
});
//# sourceMappingURL=guardrails.test.js.map