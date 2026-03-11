import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { describe, expect, it } from 'vitest';
const cliIndexSource = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'index.ts'), 'utf-8');
describe('session search help text', () => {
    it('documents the session search command examples', () => {
        expect(cliIndexSource).toContain('omc session search "team leader stale"');
        expect(cliIndexSource).toContain('omc session search notify-hook --since 7d');
        expect(cliIndexSource).toContain('omc session search provider-routing --project all --json');
    });
});
//# sourceMappingURL=session-search-help.test.js.map