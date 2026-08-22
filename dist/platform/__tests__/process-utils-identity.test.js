import { describe, expect, it, vi } from 'vitest';
import { dmtfCreationDateToTicks, terminateOwnedProcessGroup } from '../process-utils.js';
describe('Windows process start identity formats', () => {
    it('converts DMTF creation dates to ticks with full 100ns precision', () => {
        // 2024-01-15 12:30:45.123456 UTC
        // Unix ms for 2024-01-15T12:30:45Z = Date.UTC(2024,0,15,12,30,45)
        // ticks = wholeMs * 10000 + micros * 10 + 621355968000000000
        const dmtf = '20240115123045.123456+000';
        const identity = dmtfCreationDateToTicks(dmtf);
        expect(identity).toBeTruthy();
        const ticks = BigInt(identity.slice('ticks:'.length));
        const wholeMs = BigInt(Date.UTC(2024, 0, 15, 12, 30, 45));
        const expected = wholeMs * 10000n + 123456n * 10n + 621355968000000000n;
        expect(ticks).toBe(expected);
        // Must not floor to milliseconds (old bug produced ...123000)
        expect(identity).not.toMatch(/123000$/);
        expect(identity.endsWith('1234560') || identity.includes('123456')).toBe(true);
    });
    it('exact repro: 20240115123045.123456+000 preserves microseconds', () => {
        const identity = dmtfCreationDateToTicks('20240115123045.123456+000');
        // ticks must end with fractional contribution of 1234560 (micros*10)
        expect(identity).toMatch(/^ticks:\d+$/);
        const frac = BigInt(identity.slice(6)) % 10000000n; // last 7 digits include us*10
        // micros 123456 * 10 = 1234560
        expect(Number(BigInt(identity.slice(6)) % 10000000n)).toBe(1234560);
    });
    it('rejects invalid calendar dates (no JS normalization)', () => {
        expect(dmtfCreationDateToTicks('20240230123045.000000+000')).toBeNull(); // Feb 30
        expect(dmtfCreationDateToTicks('20240431123045.000000+000')).toBeNull(); // Apr 31
        expect(dmtfCreationDateToTicks('20240115123045.000000+999')).toBeNull(); // offset out of range
        expect(dmtfCreationDateToTicks('20240115253045.000000+000')).toBeNull(); // hour 25
        expect(dmtfCreationDateToTicks('20240115126145.000000+000')).toBeNull(); // minute 61
    });
    it('accepts leap day and rejects non-leap Feb 29', () => {
        expect(dmtfCreationDateToTicks('20240229123045.000000+000')).toMatch(/^ticks:/); // 2024 leap
        expect(dmtfCreationDateToTicks('20230229123045.000000+000')).toBeNull(); // 2023 not leap
    });
    it('rejects malformed DMTF strings fail-closed', () => {
        expect(dmtfCreationDateToTicks('not-a-dmtf')).toBeNull();
        expect(dmtfCreationDateToTicks('20240115123045')).toBeNull();
        expect(dmtfCreationDateToTicks('')).toBeNull();
        expect(dmtfCreationDateToTicks('20240115123045.12345+000')).toBeNull(); // 5 fractional digits
    });
    it('applies DMTF timezone offsets when converting to ticks', () => {
        const utc = dmtfCreationDateToTicks('20240115123045.000000+000');
        const plus60 = dmtfCreationDateToTicks('20240115133045.000000+060'); // local = UTC+60min → same UTC
        expect(utc).toBeTruthy();
        expect(plus60).toBe(utc);
    });
});
describe('launch-owned process-group termination authority', () => {
    const deadlineAt = () => new Date(Date.now() + 1_000).toISOString();
    it('refuses a reused leader identity without signaling its group', async () => {
        if (process.platform === 'win32')
            return;
        const result = await terminateOwnedProcessGroup({
            pid: process.pid,
            expectedStartIdentity: 'reused-process-identity',
            processGroupId: process.pid,
            deadlineAt: deadlineAt(),
            force: true,
        });
        expect(result).toBe('identity-mismatch');
    });
    it('refuses an unknown or mismatched process group without PID fallback', async () => {
        if (process.platform === 'win32')
            return;
        const result = await terminateOwnedProcessGroup({
            pid: process.pid,
            expectedStartIdentity: 'reused-process-identity',
            processGroupId: 2_147_483_647,
            deadlineAt: deadlineAt(),
        });
        expect(['identity-mismatch', 'unknown']).toContain(result);
    });
    it('refuses insecure Windows launch-owned fallback', async () => {
        const platform = vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
        try {
            await expect(terminateOwnedProcessGroup({
                pid: process.pid,
                expectedStartIdentity: 'ticks:1',
                processGroupId: process.pid,
                deadlineAt: deadlineAt(),
            })).resolves.toBe('unknown');
        }
        finally {
            platform.mockRestore();
        }
    });
});
//# sourceMappingURL=process-utils-identity.test.js.map