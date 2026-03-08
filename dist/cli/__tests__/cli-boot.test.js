/**
 * CLI boot regression tests
 *
 * Ensures the CLI can load and parse without crashing.
 * Regression guard for duplicate command registration (e.g. 'team' registered twice).
 */
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI_ENTRY = join(__dirname, '../../../bridge/cli.cjs');
const CLI_SOURCE = join(__dirname, '../index.ts');
// ---------------------------------------------------------------------------
// Static: no duplicate command names in src/cli/index.ts
// ---------------------------------------------------------------------------
describe('CLI command registration — no duplicates', () => {
    it('has no duplicate .command() names in src/cli/index.ts', () => {
        const source = readFileSync(CLI_SOURCE, 'utf-8');
        // Match program.command('name') or .command('name') — capture the command name
        const commandPattern = /\.command\(\s*['"]([^'"[\s]+)/g;
        const names = [];
        let match;
        while ((match = commandPattern.exec(source)) !== null) {
            names.push(match[1]);
        }
        const seen = new Set();
        const duplicates = [];
        for (const name of names) {
            if (seen.has(name)) {
                duplicates.push(name);
            }
            seen.add(name);
        }
        expect(duplicates, `Duplicate command names found: ${duplicates.join(', ')}`).toEqual([]);
    });
});
// ---------------------------------------------------------------------------
// Runtime: CLI boots without crashing
// ---------------------------------------------------------------------------
describe('CLI runtime boot', () => {
    it('omc --help exits cleanly (no duplicate command error)', () => {
        const result = execFileSync('node', [CLI_ENTRY, '--help'], {
            timeout: 10_000,
            encoding: 'utf-8',
            env: { ...process.env, NODE_NO_WARNINGS: '1' },
        });
        expect(result).toContain('Usage:');
        expect(result).toContain('omc');
    });
    it('omc --version exits cleanly', () => {
        const result = execFileSync('node', [CLI_ENTRY, '--version'], {
            timeout: 10_000,
            encoding: 'utf-8',
            env: { ...process.env, NODE_NO_WARNINGS: '1' },
        });
        // Should output a semver-like version string
        expect(result.trim()).toMatch(/^\d+\.\d+\.\d+/);
    });
    it('omc --madmax does not throw duplicate command error', () => {
        // --madmax maps to --dangerously-skip-permissions for claude launch.
        // In test env, claude binary isn't available so it may fail for other reasons,
        // but it must NOT fail with "cannot add command 'X' as already have command 'X'".
        try {
            execFileSync('node', [CLI_ENTRY, '--madmax'], {
                timeout: 10_000,
                encoding: 'utf-8',
                env: { ...process.env, NODE_NO_WARNINGS: '1' },
                stdio: ['pipe', 'pipe', 'pipe'],
            });
        }
        catch (err) {
            const error = err;
            const output = `${error.stderr ?? ''} ${error.stdout ?? ''} ${error.message ?? ''}`;
            // Must not contain the duplicate command registration error
            expect(output).not.toContain('cannot add command');
            expect(output).not.toContain('as already have command');
        }
    });
});
//# sourceMappingURL=cli-boot.test.js.map