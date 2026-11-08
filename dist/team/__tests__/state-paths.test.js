import { describe, it, expect } from 'vitest';
import { TeamPaths, absPath, normalizeTaskFileStem } from '../state-paths.js';
describe('state-paths task/mailbox normalization', () => {
    it('normalizes numeric task ids to task-<id>.json', () => {
        expect(normalizeTaskFileStem('1')).toBe('task-1');
        expect(TeamPaths.taskFile('demo', '1')).toContain('/tasks/task-1.json');
    });
    it('keeps canonical task stem unchanged', () => {
        expect(normalizeTaskFileStem('task-42')).toBe('task-42');
        expect(TeamPaths.taskFile('demo', 'task-42')).toContain('/tasks/task-42.json');
    });
    it('uses canonical JSON mailbox path', () => {
        expect(TeamPaths.mailbox('demo', 'worker-1')).toBe('.omc/state/team/demo/mailbox/worker-1.json');
    });
    it('preserves absolute paths when resolving team state files', () => {
        expect(absPath('/workspace', '/already/absolute/path')).toBe('/already/absolute/path');
    });
});
//# sourceMappingURL=state-paths.test.js.map