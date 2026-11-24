import { describe, it, expect } from "vitest";
// ============================================================================
// BUG 3: Dispatcher webhook timeout leak
// ============================================================================
describe('BUG 3: sendCustomWebhook clears timeout on error', () => {
    it('source uses finally block to clear timeout', async () => {
        const { readFileSync } = await import('fs');
        const { join } = await import('path');
        const source = readFileSync(join(process.cwd(), 'src/notifications/dispatcher.ts'), 'utf-8');
        // Find the sendCustomWebhook function
        const fnStart = source.indexOf('export async function sendCustomWebhook');
        expect(fnStart).toBeGreaterThan(-1);
        const fnBody = source.slice(fnStart, fnStart + 2000);
        // clearTimeout should appear inside a finally block
        expect(fnBody).toMatch(/finally\s*\{[\s\S]*?clearTimeout/);
    });
});
//# sourceMappingURL=webhook-timeout-cleanup.test.js.map