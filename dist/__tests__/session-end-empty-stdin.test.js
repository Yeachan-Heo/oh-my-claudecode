import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
const sessionEndScripts = [
    ['session-end', join(process.cwd(), 'scripts', 'session-end.mjs')],
    ['wiki-session-end', join(process.cwd(), 'scripts', 'wiki-session-end.mjs')],
];
const fallback = JSON.stringify({ continue: true, suppressOutput: true });
describe('SessionEnd hook stdin handling', () => {
    it.each(sessionEndScripts.flatMap(([name, script]) => [
        [name, 'empty stdin', script, ''],
        [name, 'whitespace stdin', script, '  \n\t  '],
    ]))('%s treats %s as a clean no-op', (_name, _label, script, input) => {
        const result = spawnSync(process.execPath, [script], {
            input,
            encoding: 'utf-8',
        });
        expect(result.status).toBe(0);
        expect(result.stderr).toBe('');
        expect(result.stdout.trim()).toBe(fallback);
    });
});
//# sourceMappingURL=session-end-empty-stdin.test.js.map