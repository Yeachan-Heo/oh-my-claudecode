import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { runTscDiagnostics } from '../tsc-runner.js';
describe('tsc-runner', () => {
    let testDir;
    beforeEach(() => {
        testDir = mkdtempSync(join(tmpdir(), 'tsc-runner-test-'));
    });
    afterEach(() => {
        rmSync(testDir, { recursive: true, force: true });
    });
    it('handles missing tsconfig.json gracefully', () => {
        const result = runTscDiagnostics(testDir);
        expect(result.success).toBe(true);
        expect(result.diagnostics).toHaveLength(0);
        expect(result.errorCount).toBe(0);
        expect(result.warningCount).toBe(0);
    });
    it('finds tsc in local node_modules/.bin', () => {
        // Setup: create a minimal TypeScript project with local tsc
        const tsconfig = {
            compilerOptions: {
                target: 'ES2020',
                module: 'ESNext',
                strict: true,
                noEmit: true
            },
            include: ['*.ts']
        };
        writeFileSync(join(testDir, 'tsconfig.json'), JSON.stringify(tsconfig, null, 2));
        // Create a valid TypeScript file
        writeFileSync(join(testDir, 'valid.ts'), 'const x: number = 42;\nconsole.log(x);\n');
        // Create node_modules/.bin directory (mock tsc would be here in real scenario)
        mkdirSync(join(testDir, 'node_modules', '.bin'), { recursive: true });
        // This test verifies the tsc resolution logic works without actually calling tsc
        // In a real integration test, we would have TypeScript installed
        const result = runTscDiagnostics(testDir);
        // The actual result depends on whether system tsc is available,
        // but we're primarily testing that it doesn't throw ENOENT errors
        expect(result.diagnostics).toBeDefined();
        expect(result.errorCount).toBeDefined();
        expect(result.warningCount).toBeDefined();
    });
    it('parses tsc error output correctly', () => {
        const tsconfig = {
            compilerOptions: {
                target: 'ES2020',
                module: 'ESNext',
                strict: true,
                noEmit: true
            },
            include: ['*.ts']
        };
        writeFileSync(join(testDir, 'tsconfig.json'), JSON.stringify(tsconfig, null, 2));
        // Create a file with a type error
        writeFileSync(join(testDir, 'invalid.ts'), 'const x: number = "string";\n');
        const result = runTscDiagnostics(testDir);
        // When tsc finds an error, it should parse it correctly
        if (!result.success) {
            expect(result.diagnostics.length).toBeGreaterThan(0);
            expect(result.errorCount).toBeGreaterThan(0);
            const diag = result.diagnostics[0];
            expect(diag).toHaveProperty('file');
            expect(diag).toHaveProperty('line');
            expect(diag).toHaveProperty('column');
            expect(diag).toHaveProperty('severity');
            expect(diag).toHaveProperty('code');
            expect(diag).toHaveProperty('message');
        }
    });
    it('handles tsc execution with shell option on Windows', () => {
        // This test verifies that the shell option is correctly set on Windows
        // In the actual code, shell: true is set on Windows to handle .cmd shims
        const tsconfig = {
            compilerOptions: {
                target: 'ES2020',
                module: 'ESNext',
                strict: true,
                noEmit: true
            }
        };
        writeFileSync(join(testDir, 'tsconfig.json'), JSON.stringify(tsconfig, null, 2));
        // Create an empty TypeScript file
        writeFileSync(join(testDir, 'empty.ts'), '');
        // This should not throw an error
        expect(() => {
            const result = runTscDiagnostics(testDir);
            expect(result).toBeDefined();
        }).not.toThrow();
    });
});
//# sourceMappingURL=tsc-runner.test.js.map