import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { initDb, closeDb, initSession, addTasks, getHeartbeats } from '../state.js';
import { claimTask, cleanupStaleClaims, heartbeat } from '../claiming.js';
describe('Swarm Claiming', () => {
    let testDir;
    beforeEach(async () => {
        testDir = mkdtempSync(join(tmpdir(), 'swarm-claiming-test-'));
        await initDb(testDir);
    });
    afterEach(() => {
        closeDb();
        rmSync(testDir, { recursive: true, force: true });
    });
    describe('claimTask', () => {
        it('should successfully claim a pending task', () => {
            initSession('test-session', 3);
            addTasks([
                { id: 'task-1', description: 'First task' }
            ]);
            const result = claimTask('agent-1');
            expect(result.success).toBe(true);
            expect(result.taskId).toBe('task-1');
            expect(result.description).toBe('First task');
        });
        it('should allow sequential claims for different tasks', () => {
            initSession('test-session', 3);
            addTasks([
                { id: 'task-1', description: 'First task' },
                { id: 'task-2', description: 'Second task' },
                { id: 'task-3', description: 'Third task' }
            ]);
            const result1 = claimTask('agent-1');
            const result2 = claimTask('agent-2');
            const result3 = claimTask('agent-3');
            expect(result1.success).toBe(true);
            expect(result1.taskId).toBe('task-1');
            expect(result2.success).toBe(true);
            expect(result2.taskId).toBe('task-2');
            expect(result3.success).toBe(true);
            expect(result3.taskId).toBe('task-3');
        });
        it('should handle duplicate claims correctly when only one task available', () => {
            initSession('test-session', 2);
            addTasks([
                { id: 'task-1', description: 'Only task' }
            ]);
            const result1 = claimTask('agent-1');
            const result2 = claimTask('agent-2');
            expect(result1.success).toBe(true);
            expect(result1.taskId).toBe('task-1');
            expect(result2.success).toBe(false);
            expect(result2.taskId).toBeNull();
        });
        it('should fail with appropriate message when no pending tasks available', () => {
            initSession('test-session', 2);
            // No tasks added
            const result = claimTask('agent-1');
            expect(result.success).toBe(false);
            expect(result.taskId).toBeNull();
            expect(result.reason).toBe('No pending tasks available');
        });
        it('should update heartbeat when claiming a task', () => {
            initSession('test-session', 1);
            addTasks([
                { id: 'task-1', description: 'First task' }
            ]);
            claimTask('agent-1');
            const heartbeats = getHeartbeats();
            expect(heartbeats).toHaveLength(1);
            expect(heartbeats[0].agentId).toBe('agent-1');
            expect(heartbeats[0].currentTaskId).toBe('task-1');
            expect(heartbeats[0].lastHeartbeat).toBeGreaterThan(Date.now() - 1000);
        });
    });
    describe('cleanupStaleClaims', () => {
        it('should return 0 when no stale claims exist', () => {
            initSession('test-session', 1);
            addTasks([
                { id: 'task-1', description: 'First task' }
            ]);
            const released = cleanupStaleClaims(5 * 60 * 1000); // 5 minutes
            expect(released).toBe(0);
        });
        it('should release stale claim without heartbeat', () => {
            vi.useFakeTimers();
            const now = Date.now();
            vi.setSystemTime(now);
            initSession('test-session', 1);
            addTasks([
                { id: 'task-1', description: 'First task' }
            ]);
            // Claim task
            claimTask('agent-1');
            // Advance time by 6 minutes
            vi.setSystemTime(now + 6 * 60 * 1000);
            // Cleanup stale claims
            const released = cleanupStaleClaims(5 * 60 * 1000);
            expect(released).toBe(1);
            vi.useRealTimers();
        });
        it('should not release claim with fresh heartbeat', () => {
            vi.useFakeTimers();
            const now = Date.now();
            vi.setSystemTime(now);
            initSession('test-session', 1);
            addTasks([
                { id: 'task-1', description: 'First task' }
            ]);
            // Claim task
            claimTask('agent-1');
            // Advance time by 3 minutes
            vi.setSystemTime(now + 3 * 60 * 1000);
            // Send heartbeat
            heartbeat('agent-1');
            // Advance time by another 3 minutes (6 minutes total, but heartbeat is only 3 minutes old)
            vi.setSystemTime(now + 6 * 60 * 1000);
            // Cleanup stale claims
            const released = cleanupStaleClaims(5 * 60 * 1000);
            expect(released).toBe(0);
            vi.useRealTimers();
        });
        it('should release multiple stale claims', () => {
            vi.useFakeTimers();
            const now = Date.now();
            vi.setSystemTime(now);
            initSession('test-session', 3);
            addTasks([
                { id: 'task-1', description: 'First task' },
                { id: 'task-2', description: 'Second task' },
                { id: 'task-3', description: 'Third task' }
            ]);
            // All agents claim tasks
            claimTask('agent-1');
            claimTask('agent-2');
            claimTask('agent-3');
            // Advance time by 6 minutes
            vi.setSystemTime(now + 6 * 60 * 1000);
            // Cleanup stale claims
            const released = cleanupStaleClaims(5 * 60 * 1000);
            expect(released).toBe(3);
            vi.useRealTimers();
        });
        it('should remove stale heartbeat records during cleanup', () => {
            vi.useFakeTimers();
            const now = Date.now();
            vi.setSystemTime(now);
            initSession('test-session', 1);
            addTasks([
                { id: 'task-1', description: 'First task' }
            ]);
            // Claim task
            claimTask('agent-1');
            // Verify heartbeat exists
            let heartbeats = getHeartbeats();
            expect(heartbeats).toHaveLength(1);
            // Advance time by 6 minutes
            vi.setSystemTime(now + 6 * 60 * 1000);
            // Cleanup stale claims
            cleanupStaleClaims(5 * 60 * 1000);
            // Verify heartbeat was removed
            heartbeats = getHeartbeats();
            expect(heartbeats).toHaveLength(0);
            vi.useRealTimers();
        });
    });
});
//# sourceMappingURL=claiming.test.js.map