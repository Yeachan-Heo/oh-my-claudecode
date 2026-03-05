import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { processHook } from '../bridge.js';

describe('team-worker pre-tool guardrails', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv, OMC_TEAM_WORKER: 'demo-team/worker-1' };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('blocks Task tool delegation inside worker context', async () => {
    const result = await processHook('pre-tool-use', {
      toolName: 'Task',
      toolInput: { description: 'spawn helper' },
    });

    expect(result.continue).toBe(false);
    expect(result.reason).toBe('team-worker-task-blocked');
  });

  it('blocks Skill tool usage inside worker context', async () => {
    const result = await processHook('pre-tool-use', {
      toolName: 'Skill',
      toolInput: { skill: 'oh-my-claudecode:team' },
    });

    expect(result.continue).toBe(false);
    expect(result.reason).toBe('team-worker-skill-blocked');
  });

  it('blocks tmux split/new session commands in Bash', async () => {
    const result = await processHook('pre-tool-use', {
      toolName: 'Bash',
      toolInput: { command: 'tmux split-window -h' },
    });

    expect(result.continue).toBe(false);
    expect(result.reason).toBe('team-worker-bash-blocked');
  });

  it('blocks team spawn commands in Bash', async () => {
    const result = await processHook('pre-tool-use', {
      toolName: 'Bash',
      toolInput: { command: 'omc team 3:executor "do work"' },
    });

    expect(result.continue).toBe(false);
    expect(result.reason).toBe('team-worker-bash-blocked');
  });

  it('allows worker-safe omc team api commands', async () => {
    const result = await processHook('pre-tool-use', {
      toolName: 'Bash',
      toolInput: { command: 'omc team api claim-task --input \'{"team_name":"demo-team","task_id":"1","worker":"worker-1"}\' --json' },
    });

    expect(result.continue).toBe(true);
    expect(result.reason).not.toBe('team-worker-bash-blocked');
  });
});
