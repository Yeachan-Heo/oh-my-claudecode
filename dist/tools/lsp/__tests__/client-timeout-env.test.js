import { describe, it, expect, afterEach, vi } from 'vitest';
describe('DEFAULT_LSP_REQUEST_TIMEOUT_MS', () => {
    afterEach(() => {
        vi.restoreAllMocks();
        vi.resetModules();
        delete process.env.OMC_LSP_TIMEOUT_MS;
    });
    async function importTimeout() {
        vi.resetModules();
        const mod = await import('../client.js');
        return mod.DEFAULT_LSP_REQUEST_TIMEOUT_MS;
    }
    it('should default to 15000 when env var is not set', async () => {
        delete process.env.OMC_LSP_TIMEOUT_MS;
        const timeout = await importTimeout();
        expect(timeout).toBe(15_000);
    });
    it('should use env var value when set to a valid number', async () => {
        process.env.OMC_LSP_TIMEOUT_MS = '30000';
        const timeout = await importTimeout();
        expect(timeout).toBe(30_000);
    });
    it('should fall back to 15000 for non-numeric env var', async () => {
        process.env.OMC_LSP_TIMEOUT_MS = 'not-a-number';
        const timeout = await importTimeout();
        expect(timeout).toBe(15_000);
    });
    it('should fall back to 15000 for zero', async () => {
        process.env.OMC_LSP_TIMEOUT_MS = '0';
        const timeout = await importTimeout();
        expect(timeout).toBe(15_000);
    });
    it('should fall back to 15000 for negative values', async () => {
        process.env.OMC_LSP_TIMEOUT_MS = '-5000';
        const timeout = await importTimeout();
        expect(timeout).toBe(15_000);
    });
});
//# sourceMappingURL=client-timeout-env.test.js.map