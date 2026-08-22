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
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, existsSync, linkSync, rmSync, readdirSync, renameSync, symlinkSync, statSync, unlinkSync, utimesSync, writeFileSync, readFileSync, } from 'fs';
import * as nodeFs from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
vi.mock('fs', async () => {
    const actual = await vi.importActual('fs');
    return { ...actual };
});
import { processPreCompact, createCompactCheckpoint, formatCompactSummary, } from '../pre-compact/index.js';
import { findLatestCheckpointForRestore, restorePreCompactCheckpoint, formatCheckpointRestoreContext, markCheckpointRestored, CHECKPOINT_MAX_AGE_MS, CHECKPOINT_MAX_BYTES, } from '../pre-compact/restore.js';
const SECURE_MARKER_SUPPORTED = process.platform === 'linux';
// ============================================================================
// Helpers
// ============================================================================
function createTempDir() {
    const dir = mkdtempSync(join(tmpdir(), 'precompact-restore-test-'));
    mkdirSync(join(dir, '.omc', 'state'), { recursive: true });
    return dir;
}
function makePreCompactInput(cwd, trigger = 'auto', sessionId = 'test-session') {
    return {
        session_id: sessionId,
        transcript_path: join(cwd, 'transcript.json'),
        cwd,
        permission_mode: 'default',
        hook_event_name: 'PreCompact',
        trigger,
    };
}
/** Write a valid checkpoint file with an explicit timestamp. */
function writeCheckpoint(dir, createdAt, overrides = {}) {
    const checkpointDir = join(getOmcRootForTest(dir), 'state', 'checkpoints');
    mkdirSync(checkpointDir, { recursive: true });
    const stamp = createdAt.replace(/[:.]/g, '-');
    const file = join(checkpointDir, `checkpoint-${stamp}.json`);
    writeFileSync(file, JSON.stringify({
        created_at: createdAt,
        session_id: 'test-session',
        trigger: 'auto',
        active_modes: {},
        todo_summary: { pending: 0, in_progress: 0, completed: 0 },
        wisdom_exported: false,
        ...overrides,
    }), 'utf-8');
    return file;
}
/** Minimal mirror of getOmcRoot for tests (no OMC_STATE_DIR in test env). */
function getOmcRootForTest(dir) {
    return join(dir, '.omc');
}
// ============================================================================
// Writer: schema carries plan anchors
// ============================================================================
describe('PreCompact writer - plan anchors (issue #3730)', () => {
    let tempDir;
    beforeEach(() => {
        tempDir = createTempDir();
    });
    afterEach(() => {
        try {
            rmSync(tempDir, { recursive: true, force: true });
        }
        catch {
            /* ignore cleanup errors */
        }
    });
    it('captures PRD anchors when a PRD is active', async () => {
        // Arrange: session-scoped PRD (ralph PRD mode)
        // PRD lives at .omc/state/sessions/{sessionId}/prd.json
        const prdDir = join(getOmcRootForTest(tempDir), 'state', 'sessions', 'test-session');
        mkdirSync(prdDir, { recursive: true });
        writeFileSync(join(prdDir, 'prd.json'), JSON.stringify({
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
        }), 'utf-8');
        const checkpoint = await createCompactCheckpoint(tempDir, 'auto', 'test-session');
        expect(checkpoint.session_id).toBe('test-session');
        expect(checkpoint.plan_refs?.prd).toBeDefined();
        expect(checkpoint.plan_refs.prd.path).toContain('prd.json');
        expect(checkpoint.plan_refs.prd.title).toBe('Fix the login bug');
        expect(checkpoint.plan_refs.prd.status).toBe('in_progress');
        expect(checkpoint.plan_refs.prd.stories_total).toBe(2);
        expect(checkpoint.plan_refs.prd.stories_completed).toBe(1);
    });
    it('captures boulder plan anchors when a boulder is active', async () => {
        // Arrange: boulder.json pointing at a planner plan
        mkdirSync(join(getOmcRootForTest(tempDir), 'plans'), { recursive: true });
        writeFileSync(join(getOmcRootForTest(tempDir), 'plans', 'refactor.md'), '# Refactor\n\n- [x] step one\n- [ ] step two\n', 'utf-8');
        writeFileSync(join(getOmcRootForTest(tempDir), 'boulder.json'), JSON.stringify({
            active_plan: join(getOmcRootForTest(tempDir), 'plans', 'refactor.md'),
            started_at: new Date().toISOString(),
            session_ids: ['test-session'],
            plan_name: 'refactor',
            active: true,
            updatedAt: new Date().toISOString(),
        }), 'utf-8');
        const checkpoint = await createCompactCheckpoint(tempDir, 'auto');
        expect(checkpoint.plan_refs?.boulder).toBeDefined();
        expect(checkpoint.plan_refs.boulder.plan_name).toBe('refactor');
        expect(checkpoint.plan_refs.boulder.progress.total).toBe(2);
        expect(checkpoint.plan_refs.boulder.progress.completed).toBe(1);
        expect(typeof checkpoint.plan_refs.boulder.active_plan).toBe('string');
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
        writeFileSync(join(getOmcRootForTest(tempDir), 'plans', 'refactor.md'), '# Refactor\n\n- [x] step one\n- [ ] step two\n', 'utf-8');
        writeFileSync(join(getOmcRootForTest(tempDir), 'boulder.json'), JSON.stringify({
            active_plan: join(getOmcRootForTest(tempDir), 'plans', 'refactor.md'),
            started_at: new Date().toISOString(),
            session_ids: [],
            plan_name: 'refactor',
            active: true,
            updatedAt: new Date().toISOString(),
        }), 'utf-8');
        await processPreCompact(makePreCompactInput(tempDir));
        const checkpointDir = join(getOmcRootForTest(tempDir), 'state', 'checkpoints');
        const files = readdirSync(checkpointDir).filter((f) => f.startsWith('checkpoint-'));
        expect(files.length).toBe(1);
        const raw = JSON.parse(readFileSync(join(checkpointDir, files[0]), 'utf-8'));
        expect(raw.plan_refs.boulder.plan_name).toBe('refactor');
        const summary = formatCompactSummary(raw);
        expect(summary).toContain('refactor');
    });
});
// ============================================================================
// Restore: find + format + replay guard
// ============================================================================
describe('PreCompact restore (issue #3730)', () => {
    let tempDir;
    beforeEach(() => {
        tempDir = createTempDir();
    });
    afterEach(() => {
        try {
            rmSync(tempDir, { recursive: true, force: true });
        }
        catch {
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
    it('returns restore text only after marker publication and suppresses repeats', async () => {
        writeCheckpoint(tempDir, new Date().toISOString(), { session_id: 'marker-gated-session' });
        const first = restorePreCompactCheckpoint(tempDir, 'marker-gated-session');
        if (SECURE_MARKER_SUPPORTED) {
            expect(first).not.toBeNull();
            expect(first?.marker_status).toBe('written');
            expect(first?.text).toContain('PRECOMPACT CHECKPOINT RESTORED');
        }
        else {
            expect(first).toBeNull();
        }
        expect(restorePreCompactCheckpoint(tempDir, 'marker-gated-session')).toBeNull();
    });
    it('isolates restore per project directory', async () => {
        const dirB = createTempDir();
        try {
            writeCheckpoint(tempDir, new Date().toISOString());
            // dir B has no checkpoints
            const candidateB = await findLatestCheckpointForRestore(dirB, 'test-session');
            expect(candidateB.ok).toBe(false);
        }
        finally {
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
        writeFileSync(join(checkpointDir, 'checkpoint-huge.json'), 'x'.repeat(CHECKPOINT_MAX_BYTES + 1), 'utf-8');
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
    it('rejects an in-directory symlink to external JSON without restoring or marking it', async () => {
        const checkpointDir = join(getOmcRootForTest(tempDir), 'state', 'checkpoints');
        mkdirSync(checkpointDir, { recursive: true });
        const marker = 'EXTERNAL_SYMLINK_CHECKPOINT_MARKER';
        const externalPath = join(tempDir, 'external-checkpoint.json');
        writeFileSync(externalPath, JSON.stringify({
            created_at: new Date().toISOString(),
            trigger: 'auto',
            active_modes: {},
            todo_summary: { pending: 1, in_progress: 0, completed: 0 },
            wisdom_exported: false,
            plan_refs: { prd: { title: marker } },
        }), 'utf-8');
        const linkedPath = join(checkpointDir, 'checkpoint-external.json');
        symlinkSync(externalPath, linkedPath);
        const candidate = await findLatestCheckpointForRestore(tempDir, 'test-session');
        expect(candidate.ok).toBe(false);
        expect(candidate.ok ? formatCheckpointRestoreContext(candidate.checkpoint, candidate.path) : '')
            .not.toContain(marker);
        if (candidate.ok) {
            markCheckpointRestored(tempDir, 'test-session', candidate.path);
        }
        expect(existsSync(join(getOmcRootForTest(tempDir), 'state', 'checkpoints-restored', 'test-session', 'restored.json'))).toBe(false);
    });
    it('rejects a checkpoint hard link whose inode has an external link', async () => {
        const checkpointDir = join(getOmcRootForTest(tempDir), 'state', 'checkpoints');
        mkdirSync(checkpointDir, { recursive: true });
        const externalPath = join(tempDir, 'external-hard-linked-checkpoint.json');
        writeFileSync(externalPath, JSON.stringify({
            created_at: new Date().toISOString(),
            trigger: 'auto',
            active_modes: {},
            todo_summary: { pending: 1, in_progress: 0, completed: 0 },
            wisdom_exported: false,
            plan_refs: { prd: { title: 'EXTERNAL_HARD_LINK_CHECKPOINT_MARKER' } },
        }), 'utf-8');
        linkSync(externalPath, join(checkpointDir, 'checkpoint-hard-linked.json'));
        const candidate = await findLatestCheckpointForRestore(tempDir, 'hard-link-session');
        expect(candidate.ok).toBe(false);
        expect(candidate.ok ? formatCheckpointRestoreContext(candidate.checkpoint, candidate.path) : '')
            .not.toContain('EXTERNAL_HARD_LINK_CHECKPOINT_MARKER');
    });
    it('rejects a symlinked .omc/state ancestor before reading external checkpoints', async () => {
        const omcRoot = getOmcRootForTest(tempDir);
        const statePath = join(omcRoot, 'state');
        rmSync(statePath, { recursive: true, force: true });
        const marker = 'EXTERNAL_STATE_SYMLINK_CHECKPOINT_MARKER';
        const externalState = join(tempDir, 'external-state');
        const externalCheckpointDir = join(externalState, 'checkpoints');
        mkdirSync(externalCheckpointDir, { recursive: true });
        writeFileSync(join(externalCheckpointDir, 'checkpoint-external.json'), JSON.stringify({
            created_at: new Date().toISOString(),
            trigger: 'auto',
            active_modes: {},
            todo_summary: { pending: 1, in_progress: 0, completed: 0 },
            wisdom_exported: false,
            plan_refs: { prd: { title: marker } },
        }), 'utf-8');
        symlinkSync(externalState, statePath, 'dir');
        const candidate = await findLatestCheckpointForRestore(tempDir, 'test-session');
        expect(candidate.ok).toBe(false);
        expect(existsSync(join(externalState, 'checkpoints-restored', 'test-session', 'restored.json'))).toBe(false);
        expect(candidate.ok ? formatCheckpointRestoreContext(candidate.checkpoint, candidate.path) : '')
            .not.toContain(marker);
    });
    it('does not write a replay marker through a symlinked marker parent', async () => {
        const checkpointPath = writeCheckpoint(tempDir, new Date().toISOString(), { session_id: 'marker-parent-symlink' });
        const markerRoot = join(getOmcRootForTest(tempDir), 'state', 'checkpoints-restored');
        const externalMarkerRoot = join(tempDir, 'external-marker-root');
        mkdirSync(externalMarkerRoot, { recursive: true });
        symlinkSync(externalMarkerRoot, markerRoot, 'dir');
        const first = await findLatestCheckpointForRestore(tempDir, 'marker-parent-symlink');
        expect(first.ok).toBe(true);
        if (first.ok) {
            expect(markCheckpointRestored(tempDir, 'marker-parent-symlink', checkpointPath)).toBe('unsupported');
        }
        expect(existsSync(join(externalMarkerRoot, 'marker-parent-symlink', 'restored.json'))).toBe(false);
        const second = await findLatestCheckpointForRestore(tempDir, 'marker-parent-symlink');
        expect(second.ok).toBe(true);
    });
    it('does not expose restore text when marker publication is unsupported, including repeats', async () => {
        writeCheckpoint(tempDir, new Date().toISOString(), { session_id: 'unsupported-marker-session' });
        const markerRoot = join(getOmcRootForTest(tempDir), 'state', 'checkpoints-restored');
        const externalMarkerRoot = join(tempDir, 'external-unsupported-marker-root');
        mkdirSync(externalMarkerRoot, { recursive: true });
        symlinkSync(externalMarkerRoot, markerRoot, 'dir');
        expect(restorePreCompactCheckpoint(tempDir, 'unsupported-marker-session')).toBeNull();
        expect(restorePreCompactCheckpoint(tempDir, 'unsupported-marker-session')).toBeNull();
        expect(existsSync(join(externalMarkerRoot, 'unsupported-marker-session', 'restored.json'))).toBe(false);
    });
    it('rejects a symlinked replay marker file without reading or overwriting the target', async () => {
        const checkpointPath = writeCheckpoint(tempDir, new Date().toISOString(), { session_id: 'marker-file-symlink' });
        const markerParent = join(getOmcRootForTest(tempDir), 'state', 'checkpoints-restored', 'marker-file-symlink');
        const externalMarker = join(tempDir, 'external-restored.json');
        mkdirSync(markerParent, { recursive: true });
        writeFileSync(externalMarker, JSON.stringify({ checkpoint: checkpointPath, restored_at: new Date().toISOString() }), 'utf-8');
        symlinkSync(externalMarker, join(markerParent, 'restored.json'));
        const first = await findLatestCheckpointForRestore(tempDir, 'marker-file-symlink');
        expect(first.ok).toBe(true);
        if (first.ok) {
            expect(markCheckpointRestored(tempDir, 'marker-file-symlink', checkpointPath)).toBe('existing');
        }
        expect(JSON.parse(readFileSync(externalMarker, 'utf-8')).checkpoint).toBe(checkpointPath);
    });
    it('fails closed when the marker parent is replaced after descriptor validation', async () => {
        const checkpointPath = writeCheckpoint(tempDir, new Date().toISOString());
        const markerParent = join(getOmcRootForTest(tempDir), 'state', 'checkpoints-restored', 'marker-parent-race');
        const markerParentBackup = `${markerParent}.backup`;
        const externalMarkerParent = join(tempDir, 'external-marker-parent-race');
        mkdirSync(markerParent, { recursive: true });
        mkdirSync(externalMarkerParent, { recursive: true });
        let swapped = false;
        const originalOpenSync = nodeFs.openSync;
        const openSpy = vi.spyOn(nodeFs, 'openSync').mockImplementation((path, flags, mode) => {
            if (!swapped && String(path) === markerParent) {
                const fd = originalOpenSync(path, flags, mode);
                swapped = true;
                renameSync(markerParent, markerParentBackup);
                symlinkSync(externalMarkerParent, markerParent, 'dir');
                return fd;
            }
            return originalOpenSync(path, flags, mode);
        });
        try {
            expect(markCheckpointRestored(tempDir, 'marker-parent-race', checkpointPath)).toBe('failed');
            expect(restorePreCompactCheckpoint(tempDir, 'marker-parent-race')).toBeNull();
            expect(swapped).toBe(true);
            expect(existsSync(join(externalMarkerParent, 'restored.json'))).toBe(false);
        }
        finally {
            openSpy.mockRestore();
            if (existsSync(markerParent))
                unlinkSync(markerParent);
            if (existsSync(markerParentBackup))
                renameSync(markerParentBackup, markerParent);
        }
    });
    it('keeps reading the opened checkpoint when its pathname is swapped during read', async () => {
        const checkpointPath = writeCheckpoint(tempDir, new Date().toISOString(), {
            plan_refs: {
                prd: {
                    path: '/repo/prd.json',
                    title: 'IN_ROOT_CHECKPOINT',
                    status: 'in_progress',
                    stories_total: 1,
                    stories_completed: 0,
                },
            },
        });
        const backupPath = `${checkpointPath}.original`;
        const externalPath = join(tempDir, 'external-mutated-checkpoint.json');
        const marker = 'EXTERNAL_MUTATION_CHECKPOINT_MARKER';
        writeFileSync(externalPath, JSON.stringify({
            created_at: new Date().toISOString(),
            trigger: 'auto',
            active_modes: {},
            todo_summary: { pending: 1, in_progress: 0, completed: 0 },
            wisdom_exported: false,
            plan_refs: { prd: { title: marker } },
        }), 'utf-8');
        let swapped = false;
        const originalReadSync = nodeFs.readSync;
        const readSpy = vi.spyOn(nodeFs, 'readSync').mockImplementation(((fd, buffer, offset, length, position) => {
            if (!swapped) {
                swapped = true;
                renameSync(checkpointPath, backupPath);
                symlinkSync(externalPath, checkpointPath);
            }
            return originalReadSync(fd, buffer, offset, length, position);
        }));
        try {
            const candidate = await findLatestCheckpointForRestore(tempDir, 'test-session');
            expect(swapped).toBe(true);
            expect(candidate.ok).toBe(false);
        }
        finally {
            readSpy.mockRestore();
            rmSync(checkpointPath, { force: true });
            renameSync(backupPath, checkpointPath);
        }
    });
    it('rejects an ancestor redirect between verification and open', async () => {
        const checkpointPath = writeCheckpoint(tempDir, new Date().toISOString());
        const checkpointName = checkpointPath.slice(checkpointPath.lastIndexOf('/') + 1);
        const omcRoot = getOmcRootForTest(tempDir);
        const statePath = join(omcRoot, 'state');
        const stateBackupPath = `${statePath}.verified-backup`;
        const externalState = join(tempDir, 'external-state-redirect');
        const externalCheckpointDir = join(externalState, 'checkpoints');
        const marker = 'EXTERNAL_ANCESTOR_REDIRECT_CHECKPOINT_MARKER';
        mkdirSync(externalCheckpointDir, { recursive: true });
        writeFileSync(join(externalCheckpointDir, checkpointName), JSON.stringify({
            created_at: new Date().toISOString(),
            trigger: 'auto',
            active_modes: {},
            todo_summary: { pending: 1, in_progress: 0, completed: 0 },
            wisdom_exported: false,
            plan_refs: { prd: { title: marker } },
        }), 'utf-8');
        let redirected = false;
        const originalOpenSync = nodeFs.openSync;
        const openSpy = vi.spyOn(nodeFs, 'openSync').mockImplementation((path, flags, mode) => {
            if (!redirected && String(path) === checkpointPath) {
                redirected = true;
                renameSync(statePath, stateBackupPath);
                symlinkSync(externalState, statePath, 'dir');
                try {
                    return originalOpenSync(path, flags, mode);
                }
                finally {
                    unlinkSync(statePath);
                    renameSync(stateBackupPath, statePath);
                }
            }
            return originalOpenSync(path, flags, mode);
        });
        try {
            const candidate = await findLatestCheckpointForRestore(tempDir, 'test-session');
            expect(redirected).toBe(true);
            expect(candidate.ok).toBe(false);
            expect(existsSync(join(omcRoot, 'state', 'checkpoints-restored', 'test-session', 'restored.json'))).toBe(false);
            expect(existsSync(join(externalState, 'checkpoints-restored', 'test-session', 'restored.json'))).toBe(false);
            expect(candidate.ok ? formatCheckpointRestoreContext(candidate.checkpoint, candidate.path) : '')
                .not.toContain(marker);
        }
        finally {
            openSpy.mockRestore();
            if (existsSync(stateBackupPath)) {
                if (existsSync(statePath))
                    unlinkSync(statePath);
                renameSync(stateBackupPath, statePath);
            }
        }
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
        });
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
            expect(markCheckpointRestored(tempDir, 'test-session', first.path)).toBe('written');
            const second = await findLatestCheckpointForRestore(tempDir, 'test-session');
            expect(second.ok).toBe(false);
        }
    });
    it('does not restore a checkpoint into a different session', async () => {
        writeCheckpoint(tempDir, new Date().toISOString(), { session_id: 'session-a' });
        const first = await findLatestCheckpointForRestore(tempDir, 'session-a');
        expect(first.ok).toBe(true);
        if (first.ok) {
            markCheckpointRestored(tempDir, 'session-a', first.path);
            const other = await findLatestCheckpointForRestore(tempDir, 'session-b');
            expect(other.ok).toBe(false);
        }
    });
    it('does not fall back to an older checkpoint after the newest was consumed', async () => {
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
        // The marker is a monotonic cursor; consuming the newest checkpoint also
        // prevents older state from replaying into the same session afterward.
        const second = await findLatestCheckpointForRestore(tempDir, 'test-session');
        expect(second.ok).toBe(false);
        if (!second.ok)
            expect(second.reason).toBe('already_restored');
    });
    it('advances the session marker from checkpoint A to newer B and suppresses B replay', async () => {
        if (!SECURE_MARKER_SUPPORTED)
            return;
        const t1 = new Date(Date.now() - 2_000).toISOString();
        const checkpointA = writeCheckpoint(tempDir, t1, { session_id: 'marker-advance-session' });
        const first = restorePreCompactCheckpoint(tempDir, 'marker-advance-session');
        expect(first?.marker_status).toBe('written');
        const markerPath = join(getOmcRootForTest(tempDir), 'state', 'checkpoints-restored', 'marker-advance-session', 'restored.json');
        expect(JSON.parse(readFileSync(markerPath, 'utf-8')).checkpoint).toBe(checkpointA);
        const t2 = new Date().toISOString();
        const checkpointB = writeCheckpoint(tempDir, t2, { session_id: 'marker-advance-session' });
        const second = restorePreCompactCheckpoint(tempDir, 'marker-advance-session');
        expect(second?.marker_status).toBe('written');
        expect(second?.text).toContain(t2);
        expect(JSON.parse(readFileSync(markerPath, 'utf-8')).checkpoint).toBe(checkpointB);
        expect(restorePreCompactCheckpoint(tempDir, 'marker-advance-session')).toBeNull();
    });
    it('does not let a delayed older marker claim overwrite a newer checkpoint', () => {
        if (!SECURE_MARKER_SUPPORTED)
            return;
        const t1 = new Date(Date.now() - 2_000).toISOString();
        const t2 = new Date().toISOString();
        const checkpointA = writeCheckpoint(tempDir, t1);
        const checkpointB = writeCheckpoint(tempDir, t2);
        expect(markCheckpointRestored(tempDir, 'marker-monotonic-session', checkpointB, t2)).toBe('written');
        expect(markCheckpointRestored(tempDir, 'marker-monotonic-session', checkpointA, t1)).toBe('existing');
        const markerPath = join(getOmcRootForTest(tempDir), 'state', 'checkpoints-restored', 'marker-monotonic-session', 'restored.json');
        expect(JSON.parse(readFileSync(markerPath, 'utf-8')).checkpoint).toBe(checkpointB);
    });
    it('advances equal-created-at checkpoints using the same mtime tiebreaker as selection', () => {
        if (!SECURE_MARKER_SUPPORTED)
            return;
        const createdAt = new Date().toISOString();
        const checkpointDir = join(getOmcRootForTest(tempDir), 'state', 'checkpoints');
        mkdirSync(checkpointDir, { recursive: true });
        const checkpointA = join(checkpointDir, 'checkpoint-equal-a.json');
        const checkpointB = join(checkpointDir, 'checkpoint-equal-b.json');
        const payload = JSON.stringify({
            created_at: createdAt,
            session_id: 'marker-equal-time',
            trigger: 'auto',
            active_modes: {},
            todo_summary: { pending: 1, in_progress: 0, completed: 0 },
            wisdom_exported: false,
        });
        writeFileSync(checkpointA, payload);
        const older = new Date(Date.now() - 2_000);
        utimesSync(checkpointA, older, older);
        const mtimeA = statSync(checkpointA).mtimeMs;
        expect(markCheckpointRestored(tempDir, 'marker-equal-time', checkpointA, createdAt, mtimeA)).toBe('written');
        writeFileSync(checkpointB, payload);
        const newer = new Date();
        utimesSync(checkpointB, newer, newer);
        const restored = restorePreCompactCheckpoint(tempDir, 'marker-equal-time');
        expect(restored?.marker_status).toBe('written');
        expect(restored?.text).toContain('checkpoint-equal-b.json');
    });
    it('uses checkpoint name as a stable final tie-breaker when created_at and mtime are equal', () => {
        if (!SECURE_MARKER_SUPPORTED)
            return;
        const createdAt = new Date().toISOString();
        const checkpointDir = join(getOmcRootForTest(tempDir), 'state', 'checkpoints');
        mkdirSync(checkpointDir, { recursive: true });
        const checkpointA = join(checkpointDir, 'checkpoint-tie-a.json');
        const checkpointB = join(checkpointDir, 'checkpoint-tie-b.json');
        const payload = JSON.stringify({
            created_at: createdAt,
            session_id: 'marker-total-order',
            trigger: 'auto',
            active_modes: {},
            todo_summary: { pending: 1, in_progress: 0, completed: 0 },
            wisdom_exported: false,
        });
        writeFileSync(checkpointA, payload);
        writeFileSync(checkpointB, payload);
        const sameTime = new Date(Date.now() - 1_000);
        utimesSync(checkpointA, sameTime, sameTime);
        utimesSync(checkpointB, sameTime, sameTime);
        const mtime = statSync(checkpointA).mtimeMs;
        expect(markCheckpointRestored(tempDir, 'marker-total-order', checkpointA, createdAt, mtime)).toBe('written');
        const restored = restorePreCompactCheckpoint(tempDir, 'marker-total-order');
        expect(restored?.marker_status).toBe('written');
        expect(restored?.text).toContain('checkpoint-tie-b.json');
    });
    it('derives legacy marker mtime before applying the filename tiebreaker', () => {
        if (!SECURE_MARKER_SUPPORTED)
            return;
        const createdAt = new Date().toISOString();
        const checkpointDir = join(getOmcRootForTest(tempDir), 'state', 'checkpoints');
        mkdirSync(checkpointDir, { recursive: true });
        const older = writeCheckpoint(tempDir, createdAt, { session_id: 'legacy-marker-order' });
        const legacyPath = join(checkpointDir, 'checkpoint-z.json');
        renameSync(older, legacyPath);
        const olderTime = new Date(Date.now() - 2_000);
        utimesSync(legacyPath, olderTime, olderTime);
        expect(markCheckpointRestored(tempDir, 'legacy-marker-order', legacyPath, createdAt, statSync(legacyPath).mtimeMs)).toBe('written');
        const markerPath = join(getOmcRootForTest(tempDir), 'state', 'checkpoints-restored', 'legacy-marker-order', 'restored.json');
        const marker = JSON.parse(readFileSync(markerPath, 'utf8'));
        delete marker.checkpoint_mtime_ms;
        writeFileSync(markerPath, JSON.stringify(marker), 'utf8');
        const newerPath = join(checkpointDir, 'checkpoint-a.json');
        writeFileSync(newerPath, JSON.stringify({
            created_at: createdAt,
            session_id: 'legacy-marker-order',
            trigger: 'auto',
            active_modes: {},
            todo_summary: { pending: 0, in_progress: 0, completed: 0 },
            wisdom_exported: false,
        }));
        const newerTime = new Date();
        utimesSync(newerPath, newerTime, newerTime);
        expect(restorePreCompactCheckpoint(tempDir, 'legacy-marker-order')?.text).toContain('checkpoint-a.json');
    });
    it('does not let a foreign-session legacy marker suppress the current session', () => {
        if (!SECURE_MARKER_SUPPORTED)
            return;
        const createdAt = new Date().toISOString();
        const checkpointDir = join(getOmcRootForTest(tempDir), 'state', 'checkpoints');
        mkdirSync(checkpointDir, { recursive: true });
        const foreignPath = join(checkpointDir, 'checkpoint-z.json');
        writeFileSync(foreignPath, JSON.stringify({
            created_at: createdAt,
            session_id: 'foreign-session',
            trigger: 'auto', active_modes: {},
            todo_summary: { pending: 0, in_progress: 0, completed: 0 }, wisdom_exported: false,
        }));
        const currentPath = join(checkpointDir, 'checkpoint-a.json');
        writeFileSync(currentPath, JSON.stringify({
            created_at: createdAt,
            session_id: 'current-session',
            trigger: 'auto', active_modes: {},
            todo_summary: { pending: 0, in_progress: 0, completed: 0 }, wisdom_exported: false,
        }));
        const markerParent = join(getOmcRootForTest(tempDir), 'state', 'checkpoints-restored', 'current-session');
        mkdirSync(markerParent, { recursive: true });
        writeFileSync(join(markerParent, 'restored.json'), JSON.stringify({
            restored_at: new Date().toISOString(),
            checkpoint: foreignPath,
            checkpoint_created_at: createdAt,
        }));
        expect(restorePreCompactCheckpoint(tempDir, 'current-session')?.text).toContain('checkpoint-a.json');
    });
    it('does not unlink a replacement lock after inspecting a stale inode', () => {
        if (!SECURE_MARKER_SUPPORTED)
            return;
        const createdAt = new Date().toISOString();
        const checkpoint = writeCheckpoint(tempDir, createdAt, { session_id: 'stale-lock-cas' });
        const markerParent = join(getOmcRootForTest(tempDir), 'state', 'checkpoints-restored', 'stale-lock-cas');
        mkdirSync(markerParent, { recursive: true });
        const lockPath = join(markerParent, '.restored.json.lock');
        writeFileSync(lockPath, 'stale');
        const staleTime = new Date(Date.now() - 60_000);
        utimesSync(lockPath, staleTime, staleTime);
        const originalRenameSync = nodeFs.renameSync;
        let replacementInode = 0;
        let replaced = false;
        const renameSpy = vi.spyOn(nodeFs, 'renameSync').mockImplementation((source, destination) => {
            if (!replaced && String(source).endsWith('/.restored.json.lock')) {
                replaced = true;
                unlinkSync(lockPath);
                writeFileSync(lockPath, 'live');
                replacementInode = statSync(lockPath).ino;
            }
            return originalRenameSync(source, destination);
        });
        try {
            expect(markCheckpointRestored(tempDir, 'stale-lock-cas', checkpoint, createdAt, statSync(checkpoint).mtimeMs)).toBe('contended');
            expect(replaced).toBe(true);
            expect(statSync(lockPath).ino).toBe(replacementInode);
            expect(readFileSync(lockPath, 'utf8')).toBe('live');
        }
        finally {
            renameSpy.mockRestore();
        }
    });
    it('reclaims an unchanged genuine stale lock after quarantine rename', () => {
        if (!SECURE_MARKER_SUPPORTED)
            return;
        const createdAt = new Date().toISOString();
        const checkpoint = writeCheckpoint(tempDir, createdAt, { session_id: 'genuine-stale-lock' });
        const markerParent = join(getOmcRootForTest(tempDir), 'state', 'checkpoints-restored', 'genuine-stale-lock');
        mkdirSync(markerParent, { recursive: true });
        const lockPath = join(markerParent, '.restored.json.lock');
        writeFileSync(lockPath, 'stale');
        const staleTime = new Date(Date.now() - 60_000);
        utimesSync(lockPath, staleTime, staleTime);
        expect(markCheckpointRestored(tempDir, 'genuine-stale-lock', checkpoint, createdAt, statSync(checkpoint).mtimeMs)).toBe('written');
        expect(existsSync(lockPath)).toBe(false);
        expect(existsSync(join(markerParent, 'restored.json'))).toBe(true);
    });
});
// ============================================================================
// Writer → restore lifecycle
// ============================================================================
describe('writer → restore lifecycle (issue #3730)', () => {
    let tempDir;
    beforeEach(() => {
        tempDir = createTempDir();
    });
    afterEach(() => {
        try {
            rmSync(tempDir, { recursive: true, force: true });
        }
        catch {
            /* ignore cleanup errors */
        }
    });
    it('end to end: PreCompact write, then SessionStart-style restore', async () => {
        // Arrange plan state that must survive compaction
        const omcRoot = getOmcRootForTest(tempDir);
        mkdirSync(join(omcRoot, 'plans'), { recursive: true });
        writeFileSync(join(omcRoot, 'plans', 'epic.md'), '# Epic\n\n- [x] a\n- [x] b\n- [ ] c\n', 'utf-8');
        writeFileSync(join(omcRoot, 'boulder.json'), JSON.stringify({
            active_plan: join(omcRoot, 'plans', 'epic.md'),
            started_at: new Date().toISOString(),
            session_ids: ['test-session'],
            plan_name: 'epic',
            active: true,
            updatedAt: new Date().toISOString(),
        }), 'utf-8');
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
//# sourceMappingURL=precompact-restore.test.js.map