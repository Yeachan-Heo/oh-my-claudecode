import { describe, it, expect } from 'vitest';
describe('BUG 4: session-start hooks clear timeout in finally', () => {
    it('templates/hooks/session-start.mjs uses finally for clearTimeout', async () => {
        const { readFileSync } = await import('fs');
        const { join } = await import('path');
        const source = readFileSync(join(process.cwd(), 'templates/hooks/session-start.mjs'), 'utf-8');
        // Find the checkForUpdates function
        const fnStart = source.indexOf('async function checkForUpdates');
        expect(fnStart).toBeGreaterThan(-1);
        const fnBody = source.slice(fnStart, fnStart + 1500);
        expect(fnBody).toMatch(/finally\s*\{[\s\S]*?clearTimeout/);
    });
    it('scripts/session-start.mjs uses finally for clearTimeout', async () => {
        const { readFileSync } = await import('fs');
        const { join } = await import('path');
        const source = readFileSync(join(process.cwd(), 'scripts/session-start.mjs'), 'utf-8');
        // The checkNpmUpdate function should use finally for clearTimeout
        // Look for the npm fetch section
        const fetchSection = source.indexOf('registry.npmjs.org');
        expect(fetchSection).toBeGreaterThan(-1);
        // Find the surrounding try/finally block
        const surroundingCode = source.slice(Math.max(0, fetchSection - 300), fetchSection + 800);
        expect(surroundingCode).toMatch(/finally\s*\{[\s\S]*?clearTimeout/);
    });
});
//# sourceMappingURL=session-start-timeout-cleanup.test.js.map