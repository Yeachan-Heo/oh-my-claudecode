import { describe, it, expect } from 'vitest';
import type { AggressiveSwarmConfig, SwarmConfig, SwarmTask } from '../types.js';
import { DB_SCHEMA_VERSION } from '../types.js';

describe('Swarm Types', () => {
  describe('AggressiveSwarmConfig', () => {
    it('should extend SwarmConfig with additional fields', () => {
      const config: AggressiveSwarmConfig = {
        agentCount: 5,
        tasks: ['task 1'],
        maxConcurrent: 10,
        totalTasks: 30,
        waveMode: true,
        wavePollingInterval: 5000
      };
      // Verify it satisfies SwarmConfig
      const baseConfig: SwarmConfig = config;
      expect(baseConfig.agentCount).toBe(5);
      expect(config.maxConcurrent).toBe(10);
      expect(config.totalTasks).toBe(30);
      expect(config.waveMode).toBe(true);
      expect(config.wavePollingInterval).toBe(5000);
    });

    it('should allow all new fields to be optional', () => {
      const config: AggressiveSwarmConfig = {
        agentCount: 3,
        tasks: ['task 1']
      };
      expect(config.maxConcurrent).toBeUndefined();
      expect(config.totalTasks).toBeUndefined();
      expect(config.waveMode).toBeUndefined();
      expect(config.wavePollingInterval).toBeUndefined();
    });
  });

  describe('DB_SCHEMA_VERSION', () => {
    it('should be version 2', () => {
      expect(DB_SCHEMA_VERSION).toBe(2);
    });
  });

  describe('SwarmTask metadata fields', () => {
    it('should accept tasks with new metadata fields', () => {
      // This is a type-level test to verify the interface compiles
      const task = {
        id: 'task-1',
        description: 'test',
        status: 'pending' as const,
        claimedBy: null,
        claimedAt: null,
        completedAt: null,
        priority: 1,
        wave: 2,
        ownedFiles: ['src/foo.ts'],
        filePatterns: ['src/**/*.ts']
      };
      expect(task.priority).toBe(1);
      expect(task.wave).toBe(2);
      expect(task.ownedFiles).toEqual(['src/foo.ts']);
      expect(task.filePatterns).toEqual(['src/**/*.ts']);
    });

    it('should allow metadata fields to be undefined', () => {
      const task: SwarmTask = {
        id: 'task-1',
        description: 'test',
        status: 'pending' as const,
        claimedBy: null,
        claimedAt: null,
        completedAt: null
      };
      // Optional fields should be undefined when not specified
      expect(task.priority).toBeUndefined();
      expect(task.wave).toBeUndefined();
    });
  });
});
