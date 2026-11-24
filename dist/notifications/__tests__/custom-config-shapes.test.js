import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateCustomIntegration } from '../validation.js';
const validWebhook = {
    id: 'valid', type: 'webhook', enabled: true, events: ['session-end'],
    config: { url: 'https://example.invalid/hook', method: 'POST', headers: {}, bodyTemplate: '{}', timeout: 10000 },
};
const validCli = {
    id: 'valid-cli', type: 'cli', enabled: true, events: ['session-end'],
    config: { command: 'node', args: [], timeout: 5000 },
};
let configDir;
beforeEach(() => {
    vi.resetModules();
    configDir = mkdtempSync(join(tmpdir(), 'omc-custom-config-'));
    vi.stubEnv('CLAUDE_CONFIG_DIR', configDir);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.useRealTimers();
    rmSync(configDir, { recursive: true, force: true });
});
async function load(section) {
    writeFileSync(join(configDir, '.omc-config.json'), JSON.stringify({ customIntegrations: section }));
    const { getCustomIntegrationsConfig } = await import('../config.js');
    return getCustomIntegrationsConfig();
}
describe('custom integration raw configuration boundary', () => {
    it.each([
        null, 7, [], { ...validWebhook, config: null }, { ...validWebhook, config: undefined },
        { ...validCli, config: null },
        { ...validCli, config: { ...validCli.config, command: 7 } },
        { ...validCli, config: { ...validCli.config, args: [7] } },
        { ...validCli, config: { ...validCli.config, args: undefined } },
        { ...validWebhook, config: { ...validWebhook.config, bodyTemplate: 7 } },
        { ...validWebhook, config: { ...validWebhook.config, headers: null } },
        { ...validWebhook, config: { ...validWebhook.config, headers: [] } },
        { ...validWebhook, config: { ...validWebhook.config, headers: { 'Content-Type': 7 } } },
        { ...validWebhook, id: 123 }, { ...validWebhook, id: { toString: null } }, { ...validWebhook, id: { toString: 7 } }, { ...validWebhook, events: 'session-end' },
        { ...validWebhook, events: [7] },
        { ...validWebhook, config: { ...validWebhook.config, timeout: '10000' } },
    ])('filters malformed entry %# and keeps valid siblings', async (malformed) => {
        expect(await load({ enabled: true, integrations: [malformed, validWebhook] }))
            .toEqual({ enabled: true, integrations: [validWebhook] });
    });
    it.each([[], 7, 'bad', { enabled: true, integrations: {} }])('rejects malformed section %# without throwing', async (section) => {
        expect(await load(section)).toBeNull();
    });
    it('preserves string event names and an empty CLI argument array', async () => {
        const integration = { ...validCli, events: ['future-event'] };
        expect((await load({ integrations: [integration] }))?.integrations).toEqual([integration]);
    });
    it.each([NaN, Infinity, -Infinity])('rejects nonfinite supplied timeout %s in both integration types', timeout => {
        for (const integration of [validWebhook, validCli]) {
            expect(validateCustomIntegration({ ...integration, config: { ...integration.config, timeout } }).valid).toBe(false);
        }
    });
    it('does not immediately abort a webhook with the documented omitted-timeout default', async () => {
        const config = await load({ integrations: [{ ...validWebhook, config: { ...validWebhook.config, timeout: undefined } }] });
        const { sendCustomWebhook } = await import('../dispatcher.js');
        vi.useFakeTimers();
        vi.stubGlobal('fetch', vi.fn((_url, options) => new Promise((resolve, reject) => {
            options.signal?.addEventListener('abort', () => reject(new Error('aborted')));
            setTimeout(() => resolve(new Response(null, { status: 204 })), 20);
        })));
        const result = sendCustomWebhook(config.integrations[0], {
            event: 'session-end', sessionId: 'fixture', message: '', timestamp: '2026-10-10T00:00:00Z',
        });
        await vi.advanceTimersByTimeAsync(20);
        expect((await result).success).toBe(true);
    });
    it.each([validWebhook, validCli])('applies documented timeout default for $type when omitted', async (integration) => {
        const omitted = { ...integration, config: { ...integration.config, timeout: undefined } };
        expect((await load({ integrations: [omitted] }))?.integrations[0].config.timeout).toBe(integration.config.timeout);
    });
});
//# sourceMappingURL=custom-config-shapes.test.js.map