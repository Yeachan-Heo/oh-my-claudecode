import { describe, expect, it } from 'vitest';
import { canonicalizeWorkers, canonicalizeTeamConfigWorkers } from '../worker-canonicalization.js';
describe('canonicalizeWorkers', () => {
    it('prefers pane identity, backfills metadata, and unions assigned tasks', () => {
        const result = canonicalizeWorkers([
            {
                name: 'worker-2',
                index: 2,
                role: 'executor',
                assigned_tasks: ['1'],
                working_dir: '/tmp/a',
            },
            {
                name: 'worker-2',
                index: 0,
                role: '',
                assigned_tasks: ['2', '1'],
                pane_id: '%5',
                pid: 1234,
            },
        ]);
        expect(result.duplicateNames).toEqual(['worker-2']);
        expect(result.workers).toHaveLength(1);
        expect(result.workers[0]).toMatchObject({
            name: 'worker-2',
            pane_id: '%5',
            pid: 1234,
            role: 'executor',
            index: 2,
            working_dir: '/tmp/a',
            assigned_tasks: ['2', '1'],
        });
    });
    it('syncs worker_count with deduplicated workers array', () => {
        const config = {
            name: 'test-team',
            task: 'demo',
            worker_count: 3,
            workers: [
                { name: 'worker-1', index: 1, role: 'executor', assigned_tasks: ['1'] },
                { name: 'worker-1', index: 0, role: '', assigned_tasks: [] },
                { name: 'worker-2', index: 2, role: 'executor', assigned_tasks: [] },
            ],
        };
        const result = canonicalizeTeamConfigWorkers(config);
        expect(result.workers).toHaveLength(2);
        expect(result.worker_count).toBe(2);
    });
});
//# sourceMappingURL=worker-canonicalization.test.js.map