import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
describe('team-server job ID entropy', () => {
    const serverSource = readFileSync(join(__dirname, '..', 'mcp', 'team-server.ts'), 'utf-8');
    it('imports randomUUID from node:crypto', () => {
        expect(serverSource).toMatch(/import\s*\{[^}]*randomUUID[^}]*\}\s*from\s*['"]node:crypto['"]/);
    });
    it('uses randomUUID in job ID generation', () => {
        expect(serverSource).toMatch(/randomUUID\(\)\.slice\(0,\s*8\)/);
    });
    it('generates unique IDs even at the same timestamp', () => {
        const { randomUUID } = require('node:crypto');
        const now = Date.now();
        const ids = new Set();
        for (let i = 0; i < 100; i++) {
            ids.add(`omc-${now.toString(36)}${randomUUID().slice(0, 8)}`);
        }
        expect(ids.size).toBe(100);
    });
    it('generates IDs matching the validation pattern', () => {
        const { randomUUID } = require('node:crypto');
        const jobId = `omc-${Date.now().toString(36)}${randomUUID().slice(0, 8)}`;
        expect(jobId).toMatch(/^omc-[a-z0-9]{1,16}$/);
    });
});
//# sourceMappingURL=team-server-jobid.test.js.map