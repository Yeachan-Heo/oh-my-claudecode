import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  startSwarm,
  stopSwarm,
  addMoreTasks,
  getAvailableSlots,
  getAllTasks,
  claimTask,
  completeTask,
  getTasksForWave
} from '../index.js';

describe('Dynamic Task Addition', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'swarm-addmore-test-'));
  });

  afterEach(() => {
    try { stopSwarm(true); } catch { /* ignore */ }
    rmSync(testDir, { recursive: true, force: true });
  });

  describe('addMoreTasks', () => {
    it('should add tasks to a running swarm', async () => {
      await startSwarm({
        agentCount: 3,
        tasks: ['task A', 'task B'],
        cwd: testDir
      });

      const result = addMoreTasks([
        { description: 'task C' },
        { description: 'task D' }
      ]);

      expect(result.added).toBe(2);
      expect(result.startingId).toBe(3); // Starts after existing task-1, task-2

      const allTasks = getAllTasks();
      expect(allTasks).toHaveLength(4);
    });

    it('should generate correct IDs using MAX(id)', async () => {
      await startSwarm({
        agentCount: 3,
        tasks: ['task A', 'task B', 'task C'],
        cwd: testDir
      });

      // Claim and complete first task (creating a gap if deleted)
      const claim = claimTask('agent-1');
      expect(claim.success).toBe(true);
      completeTask('agent-1', claim.taskId!);

      // Add more tasks - IDs should be based on MAX, not count
      const result = addMoreTasks([
        { description: 'task D' }
      ]);

      expect(result.startingId).toBe(4); // MAX is task-3 -> 3, so next is 4
      expect(result.added).toBe(1);

      const allTasks = getAllTasks();
      const newTask = allTasks.find(t => t.id === 'task-4');
      expect(newTask).toBeDefined();
      expect(newTask?.description).toBe('task D');
    });

    it('should support metadata on added tasks', async () => {
      await startSwarm({
        agentCount: 2,
        tasks: ['initial task'],
        cwd: testDir
      });

      addMoreTasks([
        { description: 'priority task', priority: 1, wave: 2, ownedFiles: ['src/foo.ts'] },
        { description: 'normal task', priority: 5, wave: 2 }
      ]);

      const allTasks = getAllTasks();
      const priorityTask = allTasks.find(t => t.description === 'priority task');
      expect(priorityTask?.priority).toBe(1);
      expect(priorityTask?.wave).toBe(2);
      expect(priorityTask?.ownedFiles).toEqual(['src/foo.ts']);
    });

    it('should return -1 startingId when swarm not initialized', () => {
      // Don't start swarm
      const result = addMoreTasks([{ description: 'orphan task' }]);
      expect(result.added).toBe(0);
      expect(result.startingId).toBe(-1);
    });

    it('should handle adding many tasks at once', async () => {
      await startSwarm({
        agentCount: 5,
        tasks: ['initial'],
        cwd: testDir
      });

      const newTasks = Array.from({ length: 20 }, (_, i) => ({
        description: `Batch task ${i + 1}`,
        priority: i % 5,
        wave: Math.floor(i / 5) + 1
      }));

      const result = addMoreTasks(newTasks);
      expect(result.added).toBe(20);
      expect(result.startingId).toBe(2);

      const allTasks = getAllTasks();
      expect(allTasks).toHaveLength(21);
    });
  });

  describe('getAvailableSlots', () => {
    it('should return maxConcurrent when no tasks are claimed', async () => {
      await startSwarm({
        agentCount: 5,
        tasks: ['task 1', 'task 2', 'task 3'],
        cwd: testDir
      });

      const slots = getAvailableSlots(5);
      expect(slots).toBe(5);
    });

    it('should decrease as tasks are claimed', async () => {
      await startSwarm({
        agentCount: 5,
        tasks: ['task 1', 'task 2', 'task 3'],
        cwd: testDir
      });

      claimTask('agent-1');
      claimTask('agent-2');

      const slots = getAvailableSlots(5);
      expect(slots).toBe(3);
    });

    it('should increase as tasks are completed', async () => {
      await startSwarm({
        agentCount: 5,
        tasks: ['task 1', 'task 2', 'task 3'],
        cwd: testDir
      });

      const claim1 = claimTask('agent-1');
      claimTask('agent-2');

      expect(getAvailableSlots(5)).toBe(3);

      completeTask('agent-1', claim1.taskId!);

      expect(getAvailableSlots(5)).toBe(4);
    });

    it('should respect custom maxConcurrent', async () => {
      await startSwarm({
        agentCount: 10,
        tasks: ['task 1'],
        cwd: testDir
      });

      expect(getAvailableSlots(10)).toBe(10);
      expect(getAvailableSlots(20)).toBe(20);
    });

    it('should return 0 when not initialized', () => {
      const slots = getAvailableSlots(5);
      expect(slots).toBe(0);
    });

    it('should never return negative values', async () => {
      await startSwarm({
        agentCount: 2,
        tasks: ['task 1', 'task 2', 'task 3'],
        cwd: testDir
      });

      claimTask('agent-1');
      claimTask('agent-2');
      claimTask('agent-3');

      // 3 claimed, maxConcurrent is 2 - should clamp to 0
      const slots = getAvailableSlots(2);
      expect(slots).toBe(0);
    });
  });

  describe('getTasksForWave', () => {
    it('should return tasks filtered by wave number', async () => {
      await startSwarm({
        agentCount: 3,
        tasks: ['task 1'],
        cwd: testDir
      });

      // Add tasks with different waves
      addMoreTasks([
        { description: 'wave 2 task A', wave: 2 },
        { description: 'wave 2 task B', wave: 2 },
        { description: 'wave 3 task', wave: 3 }
      ]);

      const wave1 = getTasksForWave(1);
      expect(wave1).toHaveLength(1); // Original task

      const wave2 = getTasksForWave(2);
      expect(wave2).toHaveLength(2);

      const wave3 = getTasksForWave(3);
      expect(wave3).toHaveLength(1);
    });

    it('should return empty array for non-existent wave', async () => {
      await startSwarm({
        agentCount: 2,
        tasks: ['task 1'],
        cwd: testDir
      });

      const wave99 = getTasksForWave(99);
      expect(wave99).toHaveLength(0);
    });

    it('should order wave tasks by priority', async () => {
      await startSwarm({
        agentCount: 2,
        tasks: ['initial'],
        cwd: testDir
      });

      addMoreTasks([
        { description: 'low priority', wave: 2, priority: 10 },
        { description: 'high priority', wave: 2, priority: 1 },
        { description: 'medium priority', wave: 2, priority: 5 }
      ]);

      const wave2 = getTasksForWave(2);
      expect(wave2).toHaveLength(3);
      expect(wave2[0].description).toBe('high priority');
      expect(wave2[1].description).toBe('medium priority');
      expect(wave2[2].description).toBe('low priority');
    });
  });
});
