import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  startSwarm,
  stopSwarm,
  claimTask,
  completeTask,
  failTask,
  addMoreTasks,
  getAvailableSlots,
  getSwarmStats,
  getAllTasks,
  hasPendingWork,
  isSwarmComplete
} from '../index.js';

describe('Aggressive Swarm Integration', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'swarm-aggressive-test-'));
  });

  afterEach(() => {
    try { stopSwarm(true); } catch { /* ignore */ }
    rmSync(testDir, { recursive: true, force: true });
  });

  it('should handle 25 tasks with wave-based processing', async () => {
    // Create 25 tasks (simulating aggressive mode)
    const taskDescriptions = Array.from({ length: 25 }, (_, i) =>
      `Fix TypeScript errors in file-${i + 1}.ts`
    );

    const started = await startSwarm({
      agentCount: 5,
      tasks: taskDescriptions,
      cwd: testDir
    });
    expect(started).toBe(true);

    // Verify all 25 tasks created
    const stats = getSwarmStats();
    expect(stats?.totalTasks).toBe(25);
    expect(stats?.pendingTasks).toBe(25);

    // Simulate wave 1: 5 agents each claim a task
    const maxConcurrent = 5;
    const agents: string[] = [];

    for (let i = 0; i < maxConcurrent; i++) {
      const agentId = `agent-${i + 1}`;
      agents.push(agentId);
      const claim = claimTask(agentId);
      expect(claim.success).toBe(true);
    }

    // After wave 1 claims: 5 claimed, 20 pending
    expect(getAvailableSlots(maxConcurrent)).toBe(0);
    expect(getSwarmStats()?.claimedTasks).toBe(5);
    expect(getSwarmStats()?.pendingTasks).toBe(20);

    // Wave 1 completes: agents finish their tasks
    const allTasks = getAllTasks();
    for (const agent of agents) {
      const agentTasks = allTasks.filter(t => t.claimedBy === agent && t.status === 'claimed');
      for (const task of agentTasks) {
        completeTask(agent, task.id, `Fixed ${task.id}`);
      }
    }

    // After wave 1: 5 done, 20 pending, 5 slots available
    expect(getAvailableSlots(maxConcurrent)).toBe(5);
    expect(getSwarmStats()?.doneTasks).toBe(5);

    // Simulate remaining waves
    let waveCount = 1;
    while (hasPendingWork()) {
      waveCount++;
      const slots = getAvailableSlots(maxConcurrent);
      for (let i = 0; i < slots; i++) {
        const agentId = `agent-w${waveCount}-${i + 1}`;
        const claim = claimTask(agentId);
        if (claim.success) {
          completeTask(agentId, claim.taskId!, `Completed in wave ${waveCount}`);
        }
      }
    }

    // All tasks should be complete
    expect(isSwarmComplete()).toBe(true);
    const finalStats = getSwarmStats();
    expect(finalStats?.doneTasks).toBe(25);
    expect(finalStats?.pendingTasks).toBe(0);
    expect(finalStats?.failedTasks).toBe(0);
  });

  it('should support adding tasks mid-execution', async () => {
    // Start with 10 tasks
    const initialTasks = Array.from({ length: 10 }, (_, i) => `Task ${i + 1}`);

    await startSwarm({
      agentCount: 5,
      tasks: initialTasks,
      cwd: testDir
    });

    // Complete 5 tasks
    for (let i = 0; i < 5; i++) {
      const claim = claimTask(`agent-${i}`);
      expect(claim.success).toBe(true);
      completeTask(`agent-${i}`, claim.taskId!);
    }

    expect(getSwarmStats()?.doneTasks).toBe(5);
    expect(getSwarmStats()?.pendingTasks).toBe(5);

    // Add 5 more tasks mid-execution
    const result = addMoreTasks([
      { description: 'Dynamic task 1', priority: 0 },
      { description: 'Dynamic task 2', priority: 0 },
      { description: 'Dynamic task 3', priority: 0 },
      { description: 'Dynamic task 4', priority: 0 },
      { description: 'Dynamic task 5', priority: 0 }
    ]);

    expect(result.added).toBe(5);
    expect(result.startingId).toBe(11);

    // Now there should be 15 total, 5 done, 10 pending
    expect(getSwarmStats()?.totalTasks).toBe(15);
    expect(getSwarmStats()?.pendingTasks).toBe(10);

    // Complete remaining tasks
    while (hasPendingWork()) {
      const claim = claimTask('agent-finisher');
      if (claim.success) {
        completeTask('agent-finisher', claim.taskId!);
      }
    }

    expect(isSwarmComplete()).toBe(true);
    expect(getSwarmStats()?.doneTasks).toBe(15);
  });

  it('should verify no task is processed twice', async () => {
    const tasks = Array.from({ length: 20 }, (_, i) => `Task ${i + 1}`);

    await startSwarm({
      agentCount: 5,
      tasks,
      cwd: testDir
    });

    const processedTaskIds = new Set<string>();

    // Multiple agents claim and complete tasks
    while (hasPendingWork()) {
      for (let agentNum = 1; agentNum <= 5; agentNum++) {
        const claim = claimTask(`agent-${agentNum}`);
        if (claim.success) {
          // Verify this task wasn't already processed
          expect(processedTaskIds.has(claim.taskId!)).toBe(false);
          processedTaskIds.add(claim.taskId!);
          completeTask(`agent-${agentNum}`, claim.taskId!);
        }
      }
    }

    // All 20 tasks should have been processed exactly once
    expect(processedTaskIds.size).toBe(20);
    expect(isSwarmComplete()).toBe(true);
  });

  it('should handle mixed success and failure', async () => {
    const tasks = Array.from({ length: 10 }, (_, i) => `Task ${i + 1}`);

    await startSwarm({
      agentCount: 3,
      tasks,
      cwd: testDir
    });

    let taskNum = 0;
    while (hasPendingWork()) {
      const claim = claimTask('agent-1');
      if (claim.success) {
        taskNum++;
        if (taskNum % 3 === 0) {
          // Every 3rd task fails
          failTask('agent-1', claim.taskId!, 'Simulated failure');
        } else {
          completeTask('agent-1', claim.taskId!);
        }
      }
    }

    const stats = getSwarmStats();
    expect(stats?.totalTasks).toBe(10);
    expect((stats?.doneTasks ?? 0) + (stats?.failedTasks ?? 0)).toBe(10);
    expect(stats?.failedTasks).toBeGreaterThan(0);
    expect(isSwarmComplete()).toBe(true);
  });

  it('should handle rapid claiming by multiple agents', async () => {
    const tasks = Array.from({ length: 50 }, (_, i) => `Rapid task ${i + 1}`);

    await startSwarm({
      agentCount: 10,
      tasks,
      cwd: testDir
    });

    const claimedByAgent: Map<string, string[]> = new Map();

    // Simulate 10 agents rapidly claiming tasks
    while (hasPendingWork()) {
      Array.from({ length: 10 }, (_, i) => {
        const agentId = `rapid-agent-${i}`;
        const claim = claimTask(agentId);
        if (claim.success) {
          if (!claimedByAgent.has(agentId)) {
            claimedByAgent.set(agentId, []);
          }
          claimedByAgent.get(agentId)!.push(claim.taskId!);
          completeTask(agentId, claim.taskId!);
        }
        return claim;
      });
    }

    expect(isSwarmComplete()).toBe(true);
    expect(getSwarmStats()?.doneTasks).toBe(50);

    // Verify each task was only claimed once
    const allClaimedTasks: string[] = [];
    for (const tasks of claimedByAgent.values()) {
      allClaimedTasks.push(...tasks);
    }
    const uniqueTasks = new Set(allClaimedTasks);
    expect(uniqueTasks.size).toBe(allClaimedTasks.length);
  });

  it('should correctly track stats through entire lifecycle', async () => {
    await startSwarm({
      agentCount: 3,
      tasks: ['task 1', 'task 2', 'task 3', 'task 4', 'task 5'],
      cwd: testDir
    });

    // Initial state
    let stats = getSwarmStats();
    expect(stats?.totalTasks).toBe(5);
    expect(stats?.pendingTasks).toBe(5);
    expect(stats?.claimedTasks).toBe(0);
    expect(stats?.doneTasks).toBe(0);
    expect(stats?.failedTasks).toBe(0);

    // Claim 2 tasks
    const claim1 = claimTask('agent-1');
    const claim2 = claimTask('agent-2');

    stats = getSwarmStats();
    expect(stats?.pendingTasks).toBe(3);
    expect(stats?.claimedTasks).toBe(2);

    // Complete 1, fail 1
    completeTask('agent-1', claim1.taskId!);
    failTask('agent-2', claim2.taskId!, 'Test failure');

    stats = getSwarmStats();
    expect(stats?.pendingTasks).toBe(3);
    expect(stats?.claimedTasks).toBe(0);
    expect(stats?.doneTasks).toBe(1);
    expect(stats?.failedTasks).toBe(1);

    // Add more tasks
    addMoreTasks([
      { description: 'added task 1' },
      { description: 'added task 2' }
    ]);

    stats = getSwarmStats();
    expect(stats?.totalTasks).toBe(7);
    expect(stats?.pendingTasks).toBe(5);

    // Complete all remaining
    while (hasPendingWork()) {
      const claim = claimTask('finisher');
      if (claim.success) {
        completeTask('finisher', claim.taskId!);
      }
    }

    stats = getSwarmStats();
    expect(stats?.totalTasks).toBe(7);
    expect(stats?.doneTasks).toBe(6); // 1 original + 5 remaining
    expect(stats?.failedTasks).toBe(1);
    expect(isSwarmComplete()).toBe(true);
  });

  it('should handle priority-based claiming in aggressive mode', async () => {
    // Start with low priority tasks
    const lowPriorityTasks = Array.from({ length: 5 }, (_, i) => `Low priority task ${i + 1}`);

    await startSwarm({
      agentCount: 5,
      tasks: lowPriorityTasks,
      cwd: testDir
    });

    // Add high priority tasks mid-execution
    addMoreTasks([
      { description: 'URGENT: Critical fix 1', priority: 0 },
      { description: 'URGENT: Critical fix 2', priority: 0 }
    ]);

    // The next claims should get the high priority tasks first
    // (since they have priority 0, lower than default which is also 0 but added later)
    // Actually all have priority 0, so order is by id - high priority tasks are task-6, task-7
    // But original tasks are task-1 through task-5, so they come first by id order

    // To properly test priority, let's add tasks with explicit lower priority number
    addMoreTasks([
      { description: 'SUPER URGENT', priority: -1 }
    ]);

    // This task should be claimed next due to lowest priority number
    const claim = claimTask('priority-agent');
    expect(claim.success).toBe(true);
    expect(claim.description).toBe('SUPER URGENT');
  });
});
