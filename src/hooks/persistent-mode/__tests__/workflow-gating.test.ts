import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { execFileSync } from 'child_process';
import { checkPersistentModes } from '../index.js';

function makeTempProject(): string {
  const tempDir = mkdtempSync(join(tmpdir(), 'wf-gate-'));
  execFileSync('git', ['init'], { cwd: tempDir, stdio: 'pipe' });
  return tempDir;
}

function writeWorkflowLedger(
  tempDir: string,
  sessionId: string,
  slots: Record<string, { completedAt?: string }>,
): void {
  const active_skills: Record<string, unknown> = {};
  for (const [skill, opts] of Object.entries(slots)) {
    active_skills[skill] = {
      skill_name: skill,
      started_at: new Date(Date.now() - 60_000).toISOString(),
      completed_at: opts.completedAt ?? null,
      session_id: sessionId,
      mode_state_path: `${skill}-state.json`,
      initialized_mode: skill,
      initialized_state_path: join(tempDir, '.omc', 'state', 'skill-active-state.json'),
      initialized_session_state_path: join(tempDir, '.omc', 'state', 'sessions', sessionId, 'skill-active-state.json'),
    };
  }
  const payload = JSON.stringify({ version: 2, active_skills }, null, 2);

  const rootDir = join(tempDir, '.omc', 'state');
  mkdirSync(rootDir, { recursive: true });
  writeFileSync(join(rootDir, 'skill-active-state.json'), payload);

  const sessionDir = join(rootDir, 'sessions', sessionId);
  mkdirSync(sessionDir, { recursive: true });
  writeFileSync(join(sessionDir, 'skill-active-state.json'), payload);
}

function writeRalphState(tempDir: string, sessionId: string): void {
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
    }, null, 2),
  );
}

function writeModeState(
  tempDir: string,
  sessionId: string,
  mode: 'autopilot' | 'ralph' | 'ralplan',
  state: Record<string, unknown>,
): void {
  const stateDir = join(tempDir, '.omc', 'state', 'sessions', sessionId);
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, `${mode}-state.json`), JSON.stringify(state, null, 2));
}

function readSessionWorkflowLedger(tempDir: string, sessionId: string): {
  active_skills: Record<string, { completed_at?: string | null }>;
} {
  return JSON.parse(
    readFileSync(
      join(tempDir, '.omc', 'state', 'sessions', sessionId, 'skill-active-state.json'),
      'utf-8',
    ),
  );
}

function readRootWorkflowLedger(tempDir: string): {
  active_skills: Record<string, { completed_at?: string | null }>;
} {
  return JSON.parse(
    readFileSync(join(tempDir, '.omc', 'state', 'skill-active-state.json'), 'utf-8'),
  );
}

describe('workflow-gating: kill switches (spec i)', () => {
  let savedDisableOmc: string | undefined;
  let savedSkipHooks: string | undefined;

  beforeEach(() => {
    savedDisableOmc = process.env.DISABLE_OMC;
    savedSkipHooks = process.env.OMC_SKIP_HOOKS;
  });

  afterEach(() => {
    if (savedDisableOmc === undefined) {
      delete process.env.DISABLE_OMC;
    } else {
      process.env.DISABLE_OMC = savedDisableOmc;
    }
    if (savedSkipHooks === undefined) {
      delete process.env.OMC_SKIP_HOOKS;
    } else {
      process.env.OMC_SKIP_HOOKS = savedSkipHooks;
    }
  });

  it('DISABLE_OMC=1 bypasses all stop gating', async () => {
    process.env.DISABLE_OMC = '1';
    const result = await checkPersistentModes('kill-sw-1', undefined);
    expect(result.shouldBlock).toBe(false);
    expect(result.mode).toBe('none');
  });

  it('DISABLE_OMC=true bypasses all stop gating', async () => {
    process.env.DISABLE_OMC = 'true';
    const result = await checkPersistentModes('kill-sw-2', undefined);
    expect(result.shouldBlock).toBe(false);
  });

  it('OMC_SKIP_HOOKS=persistent-mode bypasses stop gating', async () => {
    process.env.OMC_SKIP_HOOKS = 'persistent-mode';
    const result = await checkPersistentModes('kill-sw-3', undefined);
    expect(result.shouldBlock).toBe(false);
    expect(result.mode).toBe('none');
  });

  it('OMC_SKIP_HOOKS=stop-continuation bypasses stop gating', async () => {
    process.env.OMC_SKIP_HOOKS = 'stop-continuation';
    const result = await checkPersistentModes('kill-sw-4', undefined);
    expect(result.shouldBlock).toBe(false);
  });

  it('OMC_SKIP_HOOKS with comma-separated list bypasses when persistent-mode is included', async () => {
    process.env.OMC_SKIP_HOOKS = 'some-hook,persistent-mode,other-hook';
    const result = await checkPersistentModes('kill-sw-5', undefined);
    expect(result.shouldBlock).toBe(false);
  });
});

describe('workflow-gating: tombstoned slot suppresses stale mode files (spec j)', () => {
  it('tombstoned ralph slot suppresses ralph-state.json check', async () => {
    const sessionId = 'tomb-ralph-01';
    const tempDir = makeTempProject();

    try {
      // Write a ralph-state.json that would block if the workflow slot were live
      writeRalphState(tempDir, sessionId);

      // Write workflow ledger with ralph slot tombstoned
      writeWorkflowLedger(tempDir, sessionId, {
        'ralph': { completedAt: new Date(Date.now() - 60_000).toISOString() },
      });

      const result = await checkPersistentModes(sessionId, tempDir);
      // Tombstoned ralph slot → runRalphPriority() returns null → no block
      expect(result.shouldBlock).toBe(false);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('tombstoned autopilot slot suppresses autopilot mode check', async () => {
    const sessionId = 'tomb-auto-01';
    const tempDir = makeTempProject();

    try {
      // Write autopilot-state.json in session state dir
      const stateDir = join(tempDir, '.omc', 'state', 'sessions', sessionId);
      mkdirSync(stateDir, { recursive: true });
      writeFileSync(
        join(stateDir, 'autopilot-state.json'),
        JSON.stringify({
          active: true,
          iteration: 1,
          max_iterations: 5,
          started_at: new Date().toISOString(),
          last_checked_at: new Date().toISOString(),
          session_id: sessionId,
          project_path: tempDir,
          phase: 'plan',
          prd: { stories: [] },
        }, null, 2),
      );

      // Tombstone the autopilot slot
      writeWorkflowLedger(tempDir, sessionId, {
        'autopilot': { completedAt: new Date(Date.now() - 60_000).toISOString() },
      });

      const result = await checkPersistentModes(sessionId, tempDir);
      expect(result.shouldBlock).toBe(false);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('tombstoned ralplan slot suppresses ralplan mode check', async () => {
    const sessionId = 'tomb-ralplan-01';
    const tempDir = makeTempProject();

    try {
      const stateDir = join(tempDir, '.omc', 'state', 'sessions', sessionId);
      mkdirSync(stateDir, { recursive: true });
      writeFileSync(
        join(stateDir, 'ralplan-state.json'),
        JSON.stringify({
          active: true,
          phase: 'planner',
          session_id: sessionId,
          started_at: new Date().toISOString(),
          last_checked_at: new Date().toISOString(),
          awaiting_confirmation: false,
        }, null, 2),
      );

      writeWorkflowLedger(tempDir, sessionId, {
        'ralplan': { completedAt: new Date(Date.now() - 60_000).toISOString() },
      });

      const result = await checkPersistentModes(sessionId, tempDir);
      expect(result.shouldBlock).toBe(false);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('tombstoned ultrawork slot suppresses ultrawork mode check', async () => {
    const sessionId = 'tomb-ulw-01';
    const tempDir = makeTempProject();

    try {
      const stateDir = join(tempDir, '.omc', 'state', 'sessions', sessionId);
      mkdirSync(stateDir, { recursive: true });
      writeFileSync(
        join(stateDir, 'ultrawork-state.json'),
        JSON.stringify({
          active: true,
          session_id: sessionId,
          started_at: new Date().toISOString(),
          last_checked_at: new Date().toISOString(),
          awaiting_confirmation: false,
          tasks: [],
          current_task_index: 0,
        }, null, 2),
      );

      writeWorkflowLedger(tempDir, sessionId, {
        'ultrawork': { completedAt: new Date(Date.now() - 60_000).toISOString() },
      });

      const result = await checkPersistentModes(sessionId, tempDir);
      expect(result.shouldBlock).toBe(false);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('live ralph slot without tombstone blocks (control: tombstone guard is doing the work)', async () => {
    const sessionId = 'tomb-ctrl-01';
    const tempDir = makeTempProject();

    try {
      writeRalphState(tempDir, sessionId);

      // Write workflow ledger with ralph slot LIVE (no completed_at)
      writeWorkflowLedger(tempDir, sessionId, {
        'ralph': {},
      });

      const result = await checkPersistentModes(sessionId, tempDir);
      // Ralph-state.json is active + slot is live → should block
      expect(result.shouldBlock).toBe(true);
      expect(result.mode).toBe('ralph');
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

describe('workflow-gating: terminal mode state tombstones stale workflow slots (issue #2960)', () => {
  it('tombstones a live autopilot slot when autopilot state is terminal', async () => {
    const sessionId = 'terminal-autopilot-2960';
    const tempDir = makeTempProject();

    try {
      writeWorkflowLedger(tempDir, sessionId, { autopilot: {} });
      writeModeState(tempDir, sessionId, 'autopilot', {
        active: false,
        phase: 'complete',
        completed_at: new Date().toISOString(),
        session_id: sessionId,
      });

      const result = await checkPersistentModes(sessionId, tempDir);
      expect(result.shouldBlock).toBe(false);

      const sessionLedger = readSessionWorkflowLedger(tempDir, sessionId);
      const rootLedger = readRootWorkflowLedger(tempDir);
      expect(sessionLedger.active_skills.autopilot?.completed_at).toEqual(expect.any(String));
      expect(rootLedger.active_skills.autopilot?.completed_at).toEqual(expect.any(String));
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('tombstones a live ralplan slot when ralplan state is terminal', async () => {
    const sessionId = 'terminal-ralplan-2960';
    const tempDir = makeTempProject();

    try {
      writeWorkflowLedger(tempDir, sessionId, { ralplan: {} });
      writeModeState(tempDir, sessionId, 'ralplan', {
        active: false,
        current_phase: 'complete',
        completed_at: new Date().toISOString(),
        session_id: sessionId,
      });

      const result = await checkPersistentModes(sessionId, tempDir);
      expect(result.shouldBlock).toBe(false);

      const sessionLedger = readSessionWorkflowLedger(tempDir, sessionId);
      const rootLedger = readRootWorkflowLedger(tempDir);
      expect(sessionLedger.active_skills.ralplan?.completed_at).toEqual(expect.any(String));
      expect(rootLedger.active_skills.ralplan?.completed_at).toEqual(expect.any(String));
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('tombstones a live ralph slot when ralph state is inactive', async () => {
    const sessionId = 'terminal-ralph-2960';
    const tempDir = makeTempProject();

    try {
      writeWorkflowLedger(tempDir, sessionId, { ralph: {} });
      writeModeState(tempDir, sessionId, 'ralph', {
        active: false,
        iteration: 3,
        max_iterations: 10,
        started_at: new Date().toISOString(),
        last_checked_at: new Date().toISOString(),
        session_id: sessionId,
      });

      const result = await checkPersistentModes(sessionId, tempDir);
      expect(result.shouldBlock).toBe(false);

      const sessionLedger = readSessionWorkflowLedger(tempDir, sessionId);
      const rootLedger = readRootWorkflowLedger(tempDir);
      expect(sessionLedger.active_skills.ralph?.completed_at).toEqual(expect.any(String));
      expect(rootLedger.active_skills.ralph?.completed_at).toEqual(expect.any(String));
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

describe('workflow-gating: authority-first ordering for nested skills (spec f)', () => {
  it('returns shouldBlock=false when no active mode state files exist regardless of empty ledger', async () => {
    const sessionId = 'auth-empty-01';
    const tempDir = makeTempProject();

    try {
      const result = await checkPersistentModes(sessionId, tempDir);
      expect(result.shouldBlock).toBe(false);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('autopilot workflow authority resolved from ledger root slot (spec f invariant)', async () => {
    const sessionId = 'auth-ap-01';
    const tempDir = makeTempProject();

    try {
      // Write autopilot as root with ralph as tombstoned child — ledger authority = autopilot
      writeWorkflowLedger(tempDir, sessionId, {
        'autopilot': {},
        'ralph': { completedAt: new Date(Date.now() - 30_000).toISOString() },
      });

      // No mode state files → no actual blocking (tests the routing path, not blocking)
      const result = await checkPersistentModes(sessionId, tempDir);
      // Without autopilot-state.json, autopilot check returns null → result is shouldBlock=false
      expect(result.shouldBlock).toBe(false);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
