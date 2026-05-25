import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
const sessionEndScript = join(process.cwd(), 'scripts', 'session-end.mjs');
const fallback = JSON.stringify({ continue: true, suppressOutput: true });
describe('session-end hook stdin handling', () => {
    it.each([
        ['empty stdin', ''],
        ['whitespace stdin', '  \n\t  '],
    ])('treats %s as a clean no-op', (_label, input) => {
        const result = spawnSync(process.execPath, [sessionEndScript], {
            input,
            encoding: 'utf-8',
        });
        expect(result.status).toBe(0);
        expect(result.stderr).toBe('');
        expect(result.stdout.trim()).toBe(fallback);
    });
});
//# sourceMappingURL=session-end-empty-stdin.test.js.map