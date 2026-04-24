/**
 * Guardrail: scripts/cleanup-orphans.mjs must not keep the Node event loop
 * alive with a refed 5s SIGKILL escalation timer, and main() must exit
 * explicitly.
 *
 * Rationale (see commit message): the script is invoked as a synchronous
 * subprocess from `/cancel` and `/team` skills — the invoker waits for it
 * to exit. If the SIGKILL escalation setTimeout is not .unref()ed and
 * main() does not call process.exit(0), every orphan that receives SIGTERM
 * causes the script to hang until the 5s timer fires, delaying the parent
 * skill UX.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..');
const SCRIPT_PATH = join(REPO_ROOT, 'scripts', 'cleanup-orphans.mjs');
describe('scripts/cleanup-orphans.mjs — SIGKILL escalation timer must not block event loop', () => {
    it('script file exists', () => {
        expect(existsSync(SCRIPT_PATH)).toBe(true);
    });
    const src = existsSync(SCRIPT_PATH) ? readFileSync(SCRIPT_PATH, 'utf8') : '';
    it('schedules a 5000ms setTimeout (existing SIGKILL escalation path)', () => {
        // Tolerant match across whitespace/newlines: setTimeout( ... , 5000 ) ...
        expect(src).toMatch(/setTimeout\s*\(/);
        expect(src).toMatch(/\b5000\s*\)/);
    });
    it('calls .unref() on the 5000ms SIGKILL escalation timer', () => {
        // Match the full setTimeout(...) call ending at `}, 5000)` followed by .unref()
        // (single-line; the `[\s\S]*?` allows the arrow body to span multiple lines).
        const pattern = /setTimeout\(\s*\(\)\s*=>\s*\{[\s\S]*?\},\s*5000\)\.unref\(\)/;
        expect(src).toMatch(pattern);
    });
    it('main() ends with an explicit process.exit(0)', () => {
        // The last line of main() before the closing brace must be process.exit(0);
        // We check that the success-path JSON print is followed by process.exit(0)
        // before the next top-level `main();` invocation.
        const mainEndPattern = /Cleaned up[^]*?process\.exit\(0\);\s*\}\s*main\(\);/;
        expect(src).toMatch(mainEndPattern);
    });
});
//# sourceMappingURL=cleanup-orphans-unref.test.js.map