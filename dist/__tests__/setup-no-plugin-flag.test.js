import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
/**
 * Source-level pinning for the `omc setup --no-plugin` wiring.
 *
 * After the PR3 setup-unification refactor, commander parses the outer
 * argv and hands `cmd.opts()` to `runSetupCommand`, which delegates the
 * flag-to-SetupOptions mapping to `flagsToPartial()` in
 * `src/setup/options.ts`. The actual boolean toggle (`plugin === false`
 * → `installerOptions.noPlugin = true`) now lives there, so we pin both
 * ends: the CLI file still advertises the flag, and options.ts still
 * performs the mapping. Behavioral coverage lives in
 * `src/cli/__tests__/setup-flags.test.ts` and
 * `src/cli/__tests__/setup-command-precedence.test.ts`.
 */
describe('omc setup --no-plugin flag wiring', () => {
    const cliSource = readFileSync(join(process.cwd(), 'src', 'cli', 'index.ts'), 'utf-8');
    const optionsSource = readFileSync(join(process.cwd(), 'src', 'setup', 'options.ts'), 'utf-8');
    it('documents the --no-plugin flag on the setup command', () => {
        expect(cliSource).toContain(".option('--no-plugin'");
        expect(cliSource).toMatch(/Install bundled skills from the current package/);
    });
    it('maps commander-negated `plugin: false` to installer noPlugin in options.ts', () => {
        expect(optionsSource).toContain("const pluginRaw = (flags as unknown as { plugin?: boolean }).plugin;");
        expect(optionsSource).toContain('if (pluginRaw === false) installerOptions.noPlugin = true;');
    });
});
//# sourceMappingURL=setup-no-plugin-flag.test.js.map