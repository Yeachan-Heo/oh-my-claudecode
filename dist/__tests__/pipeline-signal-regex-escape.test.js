import { describe, it, expect } from "vitest";
describe('BUG 8: detectPipelineSignal escapes regex', () => {
    it('source escapes regex metacharacters before creating RegExp', async () => {
        const { readFileSync } = await import('fs');
        const { join } = await import('path');
        const source = readFileSync(join(process.cwd(), 'src/hooks/autopilot/enforcement.ts'), 'utf-8');
        // Find the detectPipelineSignal function
        const fnStart = source.indexOf('function detectPipelineSignal');
        expect(fnStart).toBeGreaterThan(-1);
        const fnBody = source.slice(fnStart, fnStart + 500);
        // Should escape special regex chars before passing to RegExp
        expect(fnBody).toContain('.replace(');
        expect(fnBody).toContain('\\$&');
    });
    it('escaped regex does not match unintended text', () => {
        const signal = 'stage.complete(1)';
        const escaped = signal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const pattern = new RegExp(escaped, 'i');
        // Should match the exact signal
        expect(pattern.test('The stage.complete(1) was reached')).toBe(true);
        // Should NOT match variations that would match an unescaped regex
        expect(pattern.test('stagexcomplete11')).toBe(false);
    });
    it('handles signals with multiple regex metacharacters', () => {
        const signal = '[DONE] pipeline.finished()';
        const escaped = signal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const pattern = new RegExp(escaped, 'i');
        expect(pattern.test('The [DONE] pipeline.finished() was emitted')).toBe(true);
        expect(pattern.test('DONE_ pipelinexfinished__')).toBe(false);
    });
});
//# sourceMappingURL=pipeline-signal-regex-escape.test.js.map