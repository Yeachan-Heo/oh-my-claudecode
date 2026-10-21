import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runDirectoryDiagnostics } from '../index.js';
const fixtures = [];
function project(config, code) {
    const directory = mkdtempSync(join(tmpdir(), 'omc-tsc-failure-'));
    fixtures.push(directory);
    writeFileSync(join(directory, 'tsconfig.json'), JSON.stringify(config));
    if (code !== undefined)
        writeFileSync(join(directory, 'input.ts'), code);
    return directory;
}
afterEach(() => {
    for (const directory of fixtures.splice(0))
        rmSync(directory, { recursive: true, force: true });
});
describe('real compiler invocation failures', () => {
    it('reports project-level TS18003 instead of a clean project', async () => {
        const directory = project({ include: ['nonexistent/**/*.ts'] });
        const result = await runDirectoryDiagnostics(directory, 'tsc');
        expect(result.success).toBe(false);
        expect(result.errorCount).toBeGreaterThan(0);
        expect(result.diagnostics).toContain('TS18003');
        expect(result.summary).toContain('failed');
        expect(result.diagnostics).not.toContain('All files are clean');
    });
    it('reports a missing compiler instead of successful verification', async () => {
        const directory = project({ files: ['input.ts'] }, 'const value = 1;');
        const previousPath = process.env.PATH;
        process.env.PATH = directory;
        try {
            const result = await runDirectoryDiagnostics(directory, 'tsc');
            expect(result.success).toBe(false);
            expect(result.errorCount).toBeGreaterThan(0);
            expect(result.diagnostics).toContain('tsc not found');
            expect(result.summary).toContain('failed');
        }
        finally {
            if (previousPath === undefined)
                delete process.env.PATH;
            else
                process.env.PATH = previousPath;
        }
    });
    it('preserves actual clean and file-located compiler diagnostics', async () => {
        const clean = project({ files: ['input.ts'], compilerOptions: { types: [] } }, 'const value: number = 1;');
        expect(await runDirectoryDiagnostics(clean, 'tsc')).toMatchObject({ success: true, errorCount: 0 });
        const broken = project({ files: ['input.ts'], compilerOptions: { types: [] } }, 'const value: number = "wrong";');
        const result = await runDirectoryDiagnostics(broken, 'tsc');
        expect(result.success).toBe(false);
        expect(result.diagnostics).toContain('input.ts');
        expect(result.diagnostics).toContain('TS2322');
    });
});
//# sourceMappingURL=tsc-project-failures.test.js.map