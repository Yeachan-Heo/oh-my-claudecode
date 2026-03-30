import { describe, it, expect, vi, beforeEach } from 'vitest';
// Mock all dependencies before importing the module under test
vi.mock('../utils/paths.js', () => ({
    getClaudeConfigDir: vi.fn(() => '/tmp/test-claude-config'),
}));
vi.mock('../team/team-registration.js', () => ({
    listMcpWorkers: vi.fn(() => []),
}));
vi.mock('../team/heartbeat.js', () => ({
    readHeartbeat: vi.fn(() => null),
    isWorkerAlive: vi.fn(() => false),
}));
vi.mock('../team/tmux-session.js', () => ({
    sanitizeName: vi.fn((name) => name),
}));
vi.mock('../team/usage-tracker.js', () => ({
    generateUsageReport: vi.fn(() => ({
        teamName: 'test',
        totalWallClockMs: 0,
        taskCount: 0,
        workers: [],
    })),
}));
// Store tasks to control from test
let mockTasks = [];
vi.mock('../team/task-file-ops.js', () => ({
    listTaskIds: vi.fn(() => mockTasks.map(t => t.id)),
    readTask: vi.fn((_, id) => mockTasks.find(t => t.id === id) || null),
}));
import { getTeamStatus } from '../team/team-status.js';
describe('team-status failed count', () => {
    beforeEach(() => {
        mockTasks = [];
    });
    it('should count status=failed tasks in taskSummary.failed', () => {
        // BUG FIX: taskSummary.failed only counted completed+permanentlyFailed,
        // missing tasks with status === 'failed'. This caused total !== sum of parts.
        mockTasks = [
            { id: '1', status: 'completed' },
            { id: '2', status: 'failed' },
            { id: '3', status: 'pending' },
            { id: '4', status: 'in_progress' },
        ];
        const status = getTeamStatus('test-team', '/tmp/test', 30000, { includeUsage: false });
        expect(status.taskSummary.total).toBe(4);
        expect(status.taskSummary.completed).toBe(1);
        expect(status.taskSummary.failed).toBe(1);
        expect(status.taskSummary.pending).toBe(1);
        expect(status.taskSummary.inProgress).toBe(1);
        // Verify sum equals total
        const sum = status.taskSummary.completed + status.taskSummary.failed +
            status.taskSummary.pending + status.taskSummary.inProgress;
        expect(sum).toBe(status.taskSummary.total);
    });
    it('should count both status=failed and permanentlyFailed in taskSummary.failed', () => {
        mockTasks = [
            { id: '1', status: 'completed' },
            { id: '2', status: 'completed', metadata: { permanentlyFailed: true } },
            { id: '3', status: 'failed' },
            { id: '4', status: 'pending' },
            { id: '5', status: 'in_progress' },
        ];
        const status = getTeamStatus('test-team', '/tmp/test', 30000, { includeUsage: false });
        expect(status.taskSummary.total).toBe(5);
        expect(status.taskSummary.completed).toBe(1); // only clean completions
        expect(status.taskSummary.failed).toBe(2); // 1 failed + 1 permanentlyFailed
        expect(status.taskSummary.pending).toBe(1);
        expect(status.taskSummary.inProgress).toBe(1);
        // Verify sum equals total
        const sum = status.taskSummary.completed + status.taskSummary.failed +
            status.taskSummary.pending + status.taskSummary.inProgress;
        expect(sum).toBe(status.taskSummary.total);
    });
    it('should handle no failed tasks correctly', () => {
        mockTasks = [
            { id: '1', status: 'completed' },
            { id: '2', status: 'completed' },
            { id: '3', status: 'pending' },
        ];
        const status = getTeamStatus('test-team', '/tmp/test', 30000, { includeUsage: false });
        expect(status.taskSummary.total).toBe(3);
        expect(status.taskSummary.completed).toBe(2);
        expect(status.taskSummary.failed).toBe(0);
        expect(status.taskSummary.pending).toBe(1);
        expect(status.taskSummary.inProgress).toBe(0);
        const sum = status.taskSummary.completed + status.taskSummary.failed +
            status.taskSummary.pending + status.taskSummary.inProgress;
        expect(sum).toBe(status.taskSummary.total);
    });
});
//# sourceMappingURL=team-status-failed-count.test.js.map