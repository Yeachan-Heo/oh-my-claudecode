/**
 * Tests for issue #3730: PreCompact checkpoint is write-only.
 *
 * Verifies:
 * 1. PreCompact writes a checkpoint with durable plan anchors (PRD / boulder)
 * 2. A restore path surfaces the newest matching checkpoint after compaction
 *    (SessionStart source=compact semantics)
 * 3. Restore is isolated per project directory, bounded by size and age,
 *    fail-open on malformed/missing checkpoints, and never replays the same
 *    checkpoint to the same session twice.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  existsSync,
  rmSync,
  readdirSync,
  writeFileSync,
  readFileSync,
} from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import {
  processPreCompact,
  createCompactCheckpoint,
  formatCompactSummary,
  type PreCompactInput,
  type CompactCheckpoint,
} from '../pre-compact/index.js';
import {
  findLatestCheckpointForRestore,
  formatCheckpointRestoreContext,
  markCheckpointRestored,
  CHECKPOINT_MAX_AGE_MS,
  CHECKPOINT_MAX_BYTES,
} from '../pre-compact/restore.js';

// ============================================================================
// Helpers
// ============================================================================

function createTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'precompact-restore-test-'));
  mkdirSync(join(dir, '.omc', 'state'), { recursive: true });
  return dir;
}

function makePreCompactInput(
  cwd: string,
  trigger: 'manual' | 'auto' = 'auto',
  sessionId = 'test-session',
): PreCompactInput {
  return {
    session_id: sessionId,
    transcript_path: join(cwd, 'transcript.json'),
    cwd,
    permission_mode: 'default',
    hook_event_name: 'PreCompact' as const,
    trigger,
  };
}

/** Write a valid checkpoint file with an explicit timestamp. */
function writeCheckpoint(
  dir: string,
  createdAt: string,
  overrides: Partial<CompactCheckpoint> = {},
): string {
  const checkpointDir = join(getOmcRootForTest(dir), 'state', 'checkpoints');
  mkdirSync(checkpointDir, { recursive: true });
  const stamp = createdAt.replace(/[:.]/g, '-');
  const file = join(checkpointDir, `checkpoint-${stamp}.json`);
  writeFileSync(
    file,
    JSON.stringify({
      created_at: createdAt,
      trigger: 'auto',
      active_modes: {},
      todo_summary: { pending: 0, in_progress: 0, completed: 0 },
      wisdom_exported: false,
      ...overrides,
    } satisfies Partial<CompactCheckpoint>),
    'utf-8',
  );
  return file;
}

/** Minimal mirror of getOmcRoot for tests (no OMC_STATE_DIR in test env). */
function getOmcRootForTest(dir: string): string {
  return join(dir, '.omc');
}

// ============================================================================
// Writer: schema carries plan anchors
// ============================================================================

describe('PreCompact writer - plan anchors (issue #3730)', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTempDir();
  });

  afterEach(() => {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      /* ignore cleanup errors */
    }
  });

  it('captures PRD anchors when a PRD is active', async () => {
    // Arrange: session-scoped PRD (ralph PRD mode)
    // PRD lives at .omc/state/sessions/{sessionId}/prd.json
    const prdDir = join(getOmcRootForTest(tempDir), 'state', 'sessions', 'test-session');
    mkdirSync(prdDir, { recursive: true });
    writeFileSync(
      join(prdDir, 'prd.json'),
      JSON.stringify({
        project: 'Fix the login bug',
        branchName: 'fix/login',
        description: 'Reproduce and fix the login bug',
        userStories: [
          {
            id: 'US-1',
            title: 'Reproduce',
            description: 'Reproduce the bug',
            acceptanceCriteria: ['bug reproduces'],
            priority: 1,
            passes: true,
          },
          {
            id: 'US-2',
            title: 'Fix',
            description: 'Fix the root cause',
            acceptanceCriteria: ['bug is fixed'],
            priority: 2,
            passes: false,
          },
        ],
      }),
      'utf-8',
    );

    const checkpoint = await createCompactCheckpoint(tempDir, 'auto', 'test-session');

    expect(checkpoint.plan_refs?.prd).toBeDefined();
    expect(checkpoint.plan_refs!.prd!.path).toContain('prd.json');
    expect(checkpoint.plan_refs!.prd!.title).toBe('Fix the login bug');
    expect(checkpoint.plan_refs!.prd!.status).toBe('in_progress');
    expect(checkpoint.plan_refs!.prd!.stories_total).toBe(2);
    expect(checkpoint.plan_refs!.prd!.stories_completed).toBe(1);
  });

  it('captures boulder plan anchors when a boulder is active', async () => {
    // Arrange: boulder.json pointing at a planner plan
    mkdirSync(join(getOmcRootForTest(tempDir), 'plans'), { recursive: true });
    writeFileSync(
      join(getOmcRootForTest(tempDir), 'plans', 'refactor.md'),
      '# Refactor\n\n- [x] step one\n- [ ] step two\n',
      'utf-8',
    );
    writeFileSync(
      join(getOmcRootForTest(tempDir), 'boulder.json'),
      JSON.stringify({
        active_plan: join(getOmcRootForTest(tempDir), 'plans', 'refactor.md'),
        started_at: new Date().toISOString(),
        session_ids: ['test-session'],
        plan_name: 'refactor',
        active: true,
        updatedAt: new Date().toISOString(),
      }),
      'utf-8',
    );

    const checkpoint = await createCompactCheckpoint(tempDir, 'auto');

    expect(checkpoint.plan_refs?.boulder).toBeDefined();
    expect(checkpoint.plan_refs!.boulder!.plan_name).toBe('refactor');
    expect(checkpoint.plan_refs!.boulder!.progress.total).toBe(2);
    expect(checkpoint.plan_refs!.boulder!.progress.completed).toBe(1);
    expect(typeof checkpoint.plan_refs!.boulder!.active_plan).toBe('string');
  });

  it('omits plan_refs entirely when no plan state exists', async () => {
    const checkpoint = await createCompactCheckpoint(tempDir, 'auto');
    // plan_refs is either absent or has no prd/boulder keys
    const refs = checkpoint.plan_refs;
    expect(refs?.prd).toBeUndefined();
    expect(refs?.boulder).toBeUndefined();
  });

  it('includes plan anchors in the pre-compact system message and checkpoint file', async () => {
    mkdirSync(join(getOmcRootForTest(tempDir), 'plans'), { recursive: true });
    writeFileSync(
      join(getOmcRootForTest(tempDir), 'plans', 'refactor.md'),
      '# Refactor\n\n- [x] step one\n- [ ] step two\n',
      'utf-8',
    );
    writeFileSync(
      join(getOmcRootForTest(tempDir), 'boulder.json'),
      JSON.stringify({
        active_plan: join(getOmcRootForTest(tempDir), 'plans', 'refactor.md'),
        started_at: new Date().toISOString(),
        session_ids: [],
        plan_name: 'refactor',
        active: true,
        updatedAt: new Date().toISOString(),
      }),
      'utf-8',
    );

    await processPreCompact(makePreCompactInput(tempDir));

    const checkpointDir = join(getOmcRootForTest(tempDir), 'state', 'checkpoints');
    const files = readdirSync(checkpointDir).filter((f) => f.startsWith('checkpoint-'));
    expect(files.length).toBe(1);
    const raw = JSON.parse(readFileSync(join(checkpointDir, files[0]), 'utf-8'));
    expect(raw.plan_refs.boulder.plan_name).toBe('refactor');

    const summary = formatCompactSummary(raw as CompactCheckpoint);
    expect(summary).toContain('refactor');
  });
});

// ============================================================================
// Restore: find + format + replay guard
// ============================================================================

describe('PreCompact restore (issue #3730)', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTempDir();
  });

  afterEach(() => {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      /* ignore cleanup errors */
    }
  });

  it('finds the newest matching checkpoint after compaction', async () => {
    const older = new Date(Date.now() - 60_000).toISOString();
    const newer = new Date(Date.now() - 10_000).toISOString();
    writeCheckpoint(tempDir, older, {
      todo_summary: { pending: 1, in_progress: 0, completed: 0 },
    });
    writeCheckpoint(tempDir, newer, {
      todo_summary: { pending: 3, in_progress: 2, completed: 0 },
    });

    const candidate = await findLatestCheckpointForRestore(tempDir, 'test-session');
    expect(candidate.ok).toBe(true);
    if (candidate.ok) {
      expect(candidate.checkpoint.created_at).toBe(newer);
      expect(candidate.path).toMatch(/checkpoint-/);
    }
  });

  it('isolates restore per project directory', async () => {
    const dirB = createTempDir();
    try {
      writeCheckpoint(tempDir, new Date().toISOString());
      // dir B has no checkpoints
      const candidateB = await findLatestCheckpointForRestore(dirB, 'test-session');
      expect(candidateB.ok).toBe(false);
    } finally {
      rmSync(dirB, { recursive: true, force: true });
    }
  });

  it('rejects checkpoints older than the age bound', async () => {
    const stale = new Date(Date.now() - CHECKPOINT_MAX_AGE_MS - 5_000).toISOString();
    writeCheckpoint(tempDir, stale);

    const candidate = await findLatestCheckpointForRestore(tempDir, 'test-session');
    expect(candidate.ok).toBe(false);
  });

  it('rejects oversized checkpoint files', async () => {
    const checkpointDir = join(getOmcRootForTest(tempDir), 'state', 'checkpoints');
    mkdirSync(checkpointDir, { recursive: true });
    writeFileSync(
      join(checkpointDir, 'checkpoint-huge.json'),
      'x'.repeat(CHECKPOINT_MAX_BYTES + 1),
      'utf-8',
    );

    const candidate = await findLatestCheckpointForRestore(tempDir, 'test-session');
    expect(candidate.ok).toBe(false);
  });

  it('fails open on malformed JSON', async () => {
    const checkpointDir = join(getOmcRootForTest(tempDir), 'state', 'checkpoints');
    mkdirSync(checkpointDir, { recursive: true });
    writeFileSync(join(checkpointDir, 'checkpoint-bad.json'), '{not json', 'utf-8');

    const candidate = await findLatestCheckpointForRestore(tempDir, 'test-session');
    expect(candidate.ok).toBe(false);
    if (!candidate.ok) {
      expect(candidate.reason).toBeDefined();
    }
  });

  it('fails open when no checkpoint directory exists', async () => {
    const candidate = await findLatestCheckpointForRestore(tempDir, 'test-session');
    expect(candidate.ok).toBe(false);
    if (!candidate.ok) {
      expect(['missing', 'no_checkpoints'].includes(candidate.reason)).toBe(true);
    }
  });

  it('ignores non-checkpoint files in the directory', async () => {
    const checkpointDir = join(getOmcRootForTest(tempDir), 'state', 'checkpoints');
    mkdirSync(checkpointDir, { recursive: true });
    writeFileSync(join(checkpointDir, 'wisdom-some.md'), 'not a checkpoint', 'utf-8');
    writeFileSync(join(checkpointDir, 'readme.txt'), 'nope', 'utf-8');

    const candidate = await findLatestCheckpointForRestore(tempDir, 'test-session');
    expect(candidate.ok).toBe(false);
  });

  it('ignores checkpoint files outside the expected naming pattern', async () => {
    const checkpointDir = join(getOmcRootForTest(tempDir), 'state', 'checkpoints');
    mkdirSync(checkpointDir, { recursive: true });
    // Wrong prefix: must not be picked up
    writeFileSync(join(checkpointDir, 'notacheckpoint.json'), '{"created_at":1}', 'utf-8');

    const candidate = await findLatestCheckpointForRestore(tempDir, 'test-session');
    expect(candidate.ok).toBe(false);
  });

  it('formats a bounded restore context containing plan anchors', async () => {
    writeCheckpoint(tempDir, new Date().toISOString(), {
      active_modes: {
        ralph: { iteration: 3, prompt: 'fix the failing tests' },
      },
      plan_refs: {
        prd: {
          path: '/repo/.omc/state/session/s1/prd.json',
          title: 'Fix the login bug',
          status: 'in_progress',
          stories_total: 4,
          stories_completed: 2,
        },
        boulder: {
          active_plan: '/repo/.omc/plans/refactor.md',
          plan_name: 'refactor',
          progress: { total: 6, completed: 3, isComplete: false },
        },
      },
    } as Partial<CompactCheckpoint>);

    const candidate = await findLatestCheckpointForRestore(tempDir, 'test-session');
    expect(candidate.ok).toBe(true);
    if (candidate.ok) {
      const text = formatCheckpointRestoreContext(candidate.checkpoint, candidate.path);
      expect(text).toContain('PRECOMPACT CHECKPOINT RESTORED');
      expect(text).toContain('Fix the login bug');
      expect(text).toContain('refactor');
      expect(text).toContain('ralph');
      expect(text.length).toBeLessThanOrEqual(6000);
    }
  });

  it('does not replay a checkpoint already restored for the same session', async () => {
    writeCheckpoint(tempDir, new Date().toISOString());

    const first = await findLatestCheckpointForRestore(tempDir, 'test-session');
    expect(first.ok).toBe(true);

    if (first.ok) {
      markCheckpointRestored(tempDir, 'test-session', first.path);

      const second = await findLatestCheckpointForRestore(tempDir, 'test-session');
      expect(second.ok).toBe(false);
    }
  });

  it('replay guard is session-scoped: a different session still restores', async () => {
    writeCheckpoint(tempDir, new Date().toISOString());

    const first = await findLatestCheckpointForRestore(tempDir, 'session-a');
    expect(first.ok).toBe(true);

    if (first.ok) {
      markCheckpointRestored(tempDir, 'session-a', first.path);

      const other = await findLatestCheckpointForRestore(tempDir, 'session-b');
      expect(other.ok).toBe(true);
    }
  });

  it('a newer checkpoint is restorable after an older one was consumed', async () => {
    const t1 = new Date(Date.now() - 30_000).toISOString();
    const t2 = new Date(Date.now() - 1_000).toISOString();
    writeCheckpoint(tempDir, t1);
    writeCheckpoint(tempDir, t2);

    const first = await findLatestCheckpointForRestore(tempDir, 'test-session');
    expect(first.ok).toBe(true);
    if (first.ok) {
      expect(first.checkpoint.created_at).toBe(t2);
      markCheckpointRestored(tempDir, 'test-session', first.path);
    }

    // Newest is consumed; the older one is still valid (not replay, different file)
    const second = await findLatestCheckpointForRestore(tempDir, 'test-session');
    expect(second.ok).toBe(true);
    if (second.ok) {
      expect(second.checkpoint.created_at).toBe(t1);
    }
  });
});

// ============================================================================
// Writer → restore lifecycle
// ============================================================================

describe('writer → restore lifecycle (issue #3730)', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTempDir();
  });

  afterEach(() => {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      /* ignore cleanup errors */
    }
  });

  it('end to end: PreCompact write, then SessionStart-style restore', async () => {
    // Arrange plan state that must survive compaction
    const omcRoot = getOmcRootForTest(tempDir);
    mkdirSync(join(omcRoot, 'plans'), { recursive: true });
    writeFileSync(
      join(omcRoot, 'plans', 'epic.md'),
      '# Epic\n\n- [x] a\n- [x] b\n- [ ] c\n',
      'utf-8',
    );
    writeFileSync(
      join(omcRoot, 'boulder.json'),
      JSON.stringify({
        active_plan: join(omcRoot, 'plans', 'epic.md'),
        started_at: new Date().toISOString(),
        session_ids: ['test-session'],
        plan_name: 'epic',
        active: true,
        updatedAt: new Date().toISOString(),
      }),
      'utf-8',
    );

    // Act: compaction fires
    const out = await processPreCompact(makePreCompactInput(tempDir));
    expect(out.continue).toBe(true);

    // Assert: the same directory/session can restore the checkpoint
    const candidate = await findLatestCheckpointForRestore(tempDir, 'test-session');
    expect(candidate.ok).toBe(true);
    if (candidate.ok) {
      expect(candidate.checkpoint.plan_refs?.boulder?.plan_name).toBe('epic');
      const text = formatCheckpointRestoreContext(candidate.checkpoint, candidate.path);
      expect(text).toContain('epic');
    }
  });

  it('rejects a traversal session ID at restore (P1 security)', async () => {
    writeCheckpoint(tempDir, new Date().toISOString());

    const evil = '../../../../../../tmp/escaped-3730-tsfail';
    const candidate = await findLatestCheckpointForRestore(tempDir, evil);
    expect(candidate.ok).toBe(false);
    if (!candidate.ok) {
      expect(candidate.reason).toBe('invalid_session_id');
    }
    // No marker was written outside the omc root
    expect(existsSync('/tmp/escaped-3730-tsfail/restored.json')).toBe(false);
  });

  it('rejects empty and separator session IDs at restore', async () => {
    writeCheckpoint(tempDir, new Date().toISOString());
    for (const bad of ['', 'a/b', 'a\\b', 'a..b', 'a b']) {
      const candidate = await findLatestCheckpointForRestore(tempDir, bad);
      expect(candidate.ok).toBe(false);
      if (!candidate.ok) {
        expect(candidate.reason).toBe('invalid_session_id');
      }
    }
  });

  it('markCheckpointRestored is a no-op for an invalid session ID', async () => {
    writeCheckpoint(tempDir, new Date().toISOString());
    const evil = '../../tmp/escaped-3730-markfail';
    // Should not throw and should not write anywhere
    markCheckpointRestored(tempDir, evil, join(tempDir, 'fake.json'));
    expect(existsSync('/tmp/escaped-3730-markfail/restored.json')).toBe(false);
  });
});
