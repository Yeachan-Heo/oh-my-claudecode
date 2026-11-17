import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
describe('omc setup --no-plugin flag wiring', () => {
    const cliSource = readFileSync(join(process.cwd(), 'src', 'cli', 'index.ts'), 'utf-8');
    it('documents the --no-plugin flag on the setup command', () => {
        expect(cliSource).toContain(".option('--no-plugin'");
        expect(cliSource).toContain('Force local bundled skill installation');
    });
    it('maps commander negated option state to installer noPlugin', () => {
        expect(cliSource).toContain('const useLocalBundledSkills = options.plugin === false;');
        expect(cliSource).toContain('noPlugin: useLocalBundledSkills');
    });
});
//# sourceMappingURL=setup-no-plugin-flag.test.js.map