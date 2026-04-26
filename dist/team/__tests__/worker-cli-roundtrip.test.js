import { describe, it, expect } from 'vitest';
/**
 * AC-9: WorkerInfo.worker_cli round-trip.
 * Ensures the new field is preserved through JSON serialize/deserialize without
 * loss, supports all three CLI variants, and remains optional for legacy entries.
 */
describe('WorkerInfo.worker_cli round-trip', () => {
    function roundtrip(w) {
        return JSON.parse(JSON.stringify(w));
    }
    it('preserves worker_cli=claude through JSON serialization', () => {
        const w = {
            name: 'worker-1',
            index: 1,
            role: 'executor',
            worker_cli: 'claude',
            assigned_tasks: ['1', '2'],
        };
        const out = roundtrip(w);
        expect(out.worker_cli).toBe('claude');
        expect(out.assigned_tasks).toEqual(['1', '2']);
    });
    it('preserves worker_cli=codex through JSON serialization', () => {
        const w = {
            name: 'worker-2',
            index: 2,
            role: 'critic',
            worker_cli: 'codex',
            assigned_tasks: [],
        };
        const out = roundtrip(w);
        expect(out.worker_cli).toBe('codex');
    });
    it('preserves worker_cli=gemini through JSON serialization', () => {
        const w = {
            name: 'worker-3',
            index: 3,
            role: 'code-reviewer',
            worker_cli: 'gemini',
            assigned_tasks: [],
        };
        const out = roundtrip(w);
        expect(out.worker_cli).toBe('gemini');
    });
    it('omits worker_cli when undefined (legacy entries)', () => {
        const w = {
            name: 'worker-legacy',
            index: 0,
            role: 'executor',
            assigned_tasks: [],
        };
        const json = JSON.stringify(w);
        expect(json).not.toContain('worker_cli');
        const out = roundtrip(w);
        expect(out.worker_cli).toBeUndefined();
    });
    it('preserves output_file alongside worker_cli', () => {
        const w = {
            name: 'worker-4',
            index: 4,
            role: 'critic',
            worker_cli: 'codex',
            assigned_tasks: ['7'],
            output_file: '.omc/state/team/x/workers/worker-4/verdict.json',
        };
        const out = roundtrip(w);
        expect(out.worker_cli).toBe('codex');
        expect(out.output_file).toBe('.omc/state/team/x/workers/worker-4/verdict.json');
    });
});
//# sourceMappingURL=worker-cli-roundtrip.test.js.map