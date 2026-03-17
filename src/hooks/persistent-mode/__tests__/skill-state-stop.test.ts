import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { execFileSync } from 'child_process';
import { checkPersistentModes } from '../index.js';

function makeTempProject(): string {
  const tempDir = mkdtempSync(join(tmpdir(), 'skill-stop-'));
  execFileSync('git', ['init'], { cwd: tempDir, stdio: 'pipe' });
  return tempDir;
}

function writeSkillState(
  tempDir: string,
  sessionId: string,
  skillName: string,
  overrides: Record<string, unknown> = {}
): void {
  const stateDir = join(tempDir, '.omc', 'state', 'sessions', sessionId);
  mkdirSync(stateDir, { recursive: true });

  writeFileSync(
    join(stateDir, 'skill-active-state.json'),
    JSON.stringify(
      {
        active: true,
        skill_name: skillName,
        session_id: sessionId,
        started_at: new Date().toISOString(),
        last_checked_at: new Date().toISOString(),
        reinforcement_count: 0,
        max_reinforcements: 5,
        stale_ttl_ms: 15 * 60 * 1000,
        ...overrides,
      },
      null,
      2
    )
  );
}

function writeSubagentTrackingState(
  tempDir: string,
  agents: Array<Record<string, unknown>>,
): void {
  const stateDir = join(tempDir, '.omc', 'state');
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(
    join(stateDir, 'subagent-tracking.json'),
    JSON.stringify(
      {
        agents,
        total_spawned: agents.length,
        total_completed: agents.filter((agent) => agent.status === 'completed').length,
        total_failed: agents.filter((agent) => agent.status === 'failed').length,
        last_updated: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
}

describe('persistent-mode skill-state stop integration (issue #1033)', () => {
  it('blocks stop when a skill is actively executing', async () => {
    const sessionId = 'session-skill-1033-block';
    const tempDir = makeTempProject();

    try {
      writeSkillState(tempDir, sessionId, 'code-review');

      const result = await checkPersistentModes(sessionId, tempDir);
      expect(result.shouldBlock).toBe(true);
      expect(result.message).toContain('code-review');
      expect(result.message).toContain('SKILL ACTIVE');
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('allows stop when no skill is active', async () => {
    const sessionId = 'session-skill-1033-allow';
    const tempDir = makeTempProject();

    try {
      const result = await checkPersistentModes(sessionId, tempDir);
      expect(result.shouldBlock).toBe(false);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('allows orchestrator idle when a skill is active but delegated subagents are still running', async () => {
    const sessionId = 'session-skill-1721-active-agents';
    const tempDir = makeTempProject();

    try {
      writeSkillState(tempDir, sessionId, 'ralplan');
      writeSubagentTrackingState(tempDir, [
        {
          agent_id: 'agent-1721',
          agent_type: 'explore',
          started_at: new Date().toISOString(),
          parent_mode: 'none',
          status: 'running',
        },
      ]);

      const result = await checkPersistentModes(sessionId, tempDir);
      expect(result.shouldBlock).toBe(false);

      const statePath = join(
        tempDir,
        '.omc',
        'state',
        'sessions',
        sessionId,
        'skill-active-state.json',
      );
      const persisted = JSON.parse(readFileSync(statePath, 'utf-8')) as {
        reinforcement_count?: number;
      };
      expect(persisted.reinforcement_count).toBe(0);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('allows stop when skill reinforcement limit is reached', async () => {
    const sessionId = 'session-skill-1033-limit';
    const tempDir = makeTempProject();

    try {
      writeSkillState(tempDir, sessionId, 'tdd', {
        reinforcement_count: 3,
        max_reinforcements: 3,
      });

      const result = await checkPersistentModes(sessionId, tempDir);
      expect(result.shouldBlock).toBe(false);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('allows stop when skill state is stale', async () => {
    const sessionId = 'session-skill-1033-stale';
    const tempDir = makeTempProject();

    try {
      const past = new Date(Date.now() - 30 * 60 * 1000).toISOString(); // 30 min ago
      writeSkillState(tempDir, sessionId, 'analyze', {
        started_at: past,
        last_checked_at: past,
        stale_ttl_ms: 5 * 60 * 1000, // 5 min TTL
      });

      const result = await checkPersistentModes(sessionId, tempDir);
      expect(result.shouldBlock).toBe(false);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('respects session isolation for skill state', async () => {
    const sessionId = 'session-skill-1033-iso-a';
    const tempDir = makeTempProject();

    try {
      // Write skill state for a DIFFERENT session
      writeSkillState(tempDir, 'session-skill-1033-iso-b', 'code-review');

      // Check with our session - should not be blocked
      const result = await checkPersistentModes(sessionId, tempDir);
      expect(result.shouldBlock).toBe(false);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('ralph takes priority over skill state', async () => {
    const sessionId = 'session-skill-1033-ralph';
    const tempDir = makeTempProject();

    try {
      // Write both ralph and skill state
      const stateDir = join(tempDir, '.omc', 'state', 'sessions', sessionId);
      mkdirSync(stateDir, { recursive: true });

      writeFileSync(
        join(stateDir, 'ralph-state.json'),
        JSON.stringify({
          active: true,
          iteration: 1,
          max_iterations: 10,
          started_at: new Date().toISOString(),
          last_checked_at: new Date().toISOString(),
          prompt: 'Test task',
          session_id: sessionId,
          project_path: tempDir,
          linked_ultrawork: false,
        }, null, 2)
      );

      writeSkillState(tempDir, sessionId, 'code-review');

      const result = await checkPersistentModes(sessionId, tempDir);
      // Ralph should take priority
      expect(result.shouldBlock).toBe(true);
      expect(result.mode).toBe('ralph');
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('does not block on context-limit stops even with active skill', async () => {
    const sessionId = 'session-skill-1033-ctx';
    const tempDir = makeTempProject();

    try {
      writeSkillState(tempDir, sessionId, 'security-review');

      const result = await checkPersistentModes(sessionId, tempDir, {
        stop_reason: 'context_limit',
      });
      expect(result.shouldBlock).toBe(false);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('does not block on user abort even with active skill', async () => {
    const sessionId = 'session-skill-1033-abort';
    const tempDir = makeTempProject();

    try {
      writeSkillState(tempDir, sessionId, 'plan');

      const result = await checkPersistentModes(sessionId, tempDir, {
        user_requested: true,
      });
      expect(result.shouldBlock).toBe(false);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
