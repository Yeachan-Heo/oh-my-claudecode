/**
 * Tests for the provider reading of the opt-in worker panel quota wait (panel-quota-reading.ts): a GET of
 * OMC_PANEL_QUOTA_READ_URL against a loopback HTTP stub, with the key from a temporary key file.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readProviderQuota } from '../../features/rate-limit-wait/panel-quota-reading.js';
import { planQuotaWait } from '../../features/rate-limit-wait/panel-quota-wait.js';
const cleanups = [];
afterEach(() => {
    while (cleanups.length)
        cleanups.pop()();
});
async function stub(status, body) {
    let auth;
    const server = createServer((req, res) => {
        auth = req.headers.authorization;
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(body);
    });
    // On every IPv4 address, so 127.0.0.2 (loopback, but not a listed loopback host) reaches it too.
    await new Promise((resolve) => server.listen(0, '0.0.0.0', resolve));
    cleanups.push(() => server.close());
    return { url: `http://127.0.0.1:${server.address().port}/quota`, auth: () => auth };
}
function keyFile(text) {
    const dir = mkdtempSync(join(tmpdir(), 'panel-quota-key-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const file = join(dir, 'key');
    writeFileSync(file, text);
    return file;
}
const LIMITS = { success: true, data: { limits: [{ unit: 3, percentage: 100, nextResetTime: 1 }] } };
describe('panel quota wait: provider reading', () => {
    it('returns the body of a 200 reading and sends the trimmed key as a bearer token', async () => {
        const s = await stub(200, JSON.stringify(LIMITS));
        const reading = await readProviderQuota({ OMC_PANEL_QUOTA_READ_URL: s.url, OMC_PANEL_QUOTA_KEY_FILE: keyFile('  k-123\n') });
        expect(reading).toEqual({ body: LIMITS });
        expect(s.auth()).toBe('Bearer k-123');
    });
    it('a non-2xx status is no reading, even when its body looks like limits', async () => {
        const s = await stub(500, JSON.stringify(LIMITS));
        expect(await readProviderQuota({ OMC_PANEL_QUOTA_READ_URL: s.url, OMC_PANEL_QUOTA_KEY_FILE: keyFile('k') })).toBeNull();
    });
    it('a body with success false is no reading, even with limits in it', async () => {
        const s = await stub(200, JSON.stringify({ ...LIMITS, success: false }));
        expect(await readProviderQuota({ OMC_PANEL_QUOTA_READ_URL: s.url, OMC_PANEL_QUOTA_KEY_FILE: keyFile('k') })).toBeNull();
    });
    it('no URL, no key file, an empty key, or plain http to a host outside the loopback list: no reading from a good stub', async () => {
        const s = await stub(200, JSON.stringify(LIMITS));
        const key = keyFile('k');
        // The stub answers a good reading, so each null below comes from the guard named in the case.
        expect(await readProviderQuota({ OMC_PANEL_QUOTA_READ_URL: s.url, OMC_PANEL_QUOTA_KEY_FILE: key })).toEqual({ body: LIMITS });
        expect(await readProviderQuota({ OMC_PANEL_QUOTA_KEY_FILE: key })).toBeNull();
        expect(await readProviderQuota({ OMC_PANEL_QUOTA_READ_URL: s.url })).toBeNull();
        expect(await readProviderQuota({ OMC_PANEL_QUOTA_READ_URL: s.url, OMC_PANEL_QUOTA_KEY_FILE: keyFile('  \n') })).toBeNull();
        expect(s.auth()).toBe('Bearer k');
        expect(await readProviderQuota({ OMC_PANEL_QUOTA_READ_URL: s.url.replace('127.0.0.1', '127.0.0.2'), OMC_PANEL_QUOTA_KEY_FILE: key })).toBeNull();
    });
    it('a body that is not JSON is no reading', async () => {
        const s = await stub(200, 'not json');
        expect(await readProviderQuota({ OMC_PANEL_QUOTA_READ_URL: s.url, OMC_PANEL_QUOTA_KEY_FILE: keyFile('k') })).toBeNull();
    });
});
describe('panel quota wait: the reading is validated before it can authorize a resume', () => {
    const NOW = 1_700_000_000_000;
    const SOON = NOW + 2 * 3600_000;
    // The decision a reading leads to: the real reader against the stub, then the plan on what the reader returned.
    async function decision(limits) {
        const s = await stub(200, JSON.stringify({ success: true, data: { limits } }));
        const reading = await readProviderQuota({ OMC_PANEL_QUOTA_READ_URL: s.url, OMC_PANEL_QUOTA_KEY_FILE: keyFile('k') });
        return reading !== null && planQuotaWait(reading.body, NOW).wait;
    }
    it('an exhausted weekly limit never waits, whether its unit is a number or the text of a number', async () => {
        expect(await decision([{ unit: 6, percentage: 100, nextResetTime: SOON }])).toBe(false);
        expect(await decision([{ unit: '6', percentage: 100, nextResetTime: SOON }])).toBe(false);
    });
    it('a 5 h limit with well-typed fields waits, also with fields the plan does not use', async () => {
        expect(await decision([{ type: 'TOKENS', unit: 3, number: 5, percentage: 100, nextResetTime: SOON }])).toBe(true);
    });
    it.each([
        ['a weekly limit whose unit is text', [{ unit: 3, percentage: 100, nextResetTime: SOON }, { unit: '6', percentage: 100, nextResetTime: SOON }]],
        ['a weekly limit whose unit is a one-element array', [{ unit: 3, percentage: 100, nextResetTime: SOON }, { unit: [6], percentage: 100, nextResetTime: SOON }]],
        ['a weekly limit whose percentage is text', [{ unit: 3, percentage: 100, nextResetTime: SOON }, { unit: 6, percentage: '100', nextResetTime: SOON }]],
        ['a limit whose unit is fractional', [{ unit: 3.5, percentage: 100, nextResetTime: SOON }]],
        ['a limit whose percentage is text', [{ unit: 3, percentage: '100', nextResetTime: SOON }]],
        ['a limit whose reset time is text', [{ unit: 3, percentage: 100, nextResetTime: String(SOON) }]],
        ['a limit that is not an object', [{ unit: 3, percentage: 100, nextResetTime: SOON }, 'weekly']],
        ['a limit that is null', [{ unit: 3, percentage: 100, nextResetTime: SOON }, null]],
    ])('%s refuses the whole reading', async (_name, limits) => {
        expect(await decision(limits)).toBe(false);
    });
    it.each([['the text "false"', 'false'], ['the text "true"', 'true'], ['the number 1', 1], ['null', null]])('a success flag that is %s is no reading, even with good limits', async (_name, flag) => {
        const s = await stub(200, JSON.stringify({ success: flag, data: { limits: [{ unit: 3, percentage: 100, nextResetTime: SOON }] } }));
        expect(await readProviderQuota({ OMC_PANEL_QUOTA_READ_URL: s.url, OMC_PANEL_QUOTA_KEY_FILE: keyFile('k') })).toBeNull();
    });
    it('a reading without a success flag is accepted, and a bare array of limits too', async () => {
        const limits = [{ unit: 3, percentage: 100, nextResetTime: SOON }];
        const bare = await stub(200, JSON.stringify(limits));
        expect(await readProviderQuota({ OMC_PANEL_QUOTA_READ_URL: bare.url, OMC_PANEL_QUOTA_KEY_FILE: keyFile('k') })).toEqual({ body: limits });
        const noFlag = await stub(200, JSON.stringify({ data: { limits } }));
        expect(await readProviderQuota({ OMC_PANEL_QUOTA_READ_URL: noFlag.url, OMC_PANEL_QUOTA_KEY_FILE: keyFile('k') })).toEqual({ body: { data: { limits } } });
    });
    it('the plan itself refuses a body whose fields are mistyped, whatever reader produced it', () => {
        const body = { data: { limits: [{ unit: '6', percentage: 100, nextResetTime: SOON }] } };
        expect(planQuotaWait(body, NOW).wait).toBe(false);
        expect(planQuotaWait([{ unit: 3, percentage: '100', nextResetTime: SOON }], NOW).wait).toBe(false);
        expect(planQuotaWait([{ unit: 3, percentage: 100, nextResetTime: SOON }], NOW).wait).toBe(true);
    });
});
//# sourceMappingURL=panel-quota-reading.test.js.map