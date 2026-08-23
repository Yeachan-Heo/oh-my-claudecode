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
import { mkdtempSync, mkdirSync, existsSync, linkSync, rmSync, readdirSync, renameSync, symlinkSync, statSync, unlinkSync, utimesSync, writeFileSync, readFileSync, realpathSync, } from 'fs';
import * as nodeFs from 'fs';
import { basename, dirname, join, sep } from 'path';
import { tmpdir } from 'os';
import { pathToFileURL } from 'url';
import { createHash } from 'crypto';
vi.mock('fs', async () => {
    const actual = await vi.importActual('fs');
    return { ...actual };
});
import { processPreCompact, createCompactCheckpoint, formatCompactSummary, } from '../pre-compact/index.js';
import { findLatestCheckpointForRestore, restorePreCompactCheckpoint, formatCheckpointRestoreContext, markCheckpointRestored, CHECKPOINT_MAX_AGE_MS, CHECKPOINT_MAX_BYTES, } from '../pre-compact/restore.js';
// Marker publication is portable across every supported Node platform.
const SECURE_MARKER_SUPPORTED = true;
function withPublisherPreload(preloadPath, env, callback) {
    const previousPreload = process.env.OMC_PRECOMPACT_PUBLISHER_IMPORT;
    const previous = new Map(Object.keys(env).map((key) => [key, process.env[key]]));
    process.env.OMC_PRECOMPACT_PUBLISHER_IMPORT = pathToFileURL(preloadPath).href;
    Object.assign(process.env, env);
    try {
        return callback();
    }
    finally {
        if (previousPreload === undefined)
            delete process.env.OMC_PRECOMPACT_PUBLISHER_IMPORT;
        else
            process.env.OMC_PRECOMPACT_PUBLISHER_IMPORT = previousPreload;
        for (const [key, value] of previous) {
            if (value === undefined)
                delete process.env[key];
            else
                process.env[key] = value;
        }
    }
}
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
            expect(markCheckpointRestored(tempDir, 'marker-file-symlink', checkpointPath)).toBe('failed');
        }
        expect(JSON.parse(readFileSync(externalMarker, 'utf-8')).checkpoint).toBe(checkpointPath);
    });
    it('fails closed when the marker parent is replaced before lock publication', async () => {
        const checkpointPath = writeCheckpoint(tempDir, new Date().toISOString(), { session_id: 'marker-parent-race' });
        const markerParent = join(getOmcRootForTest(tempDir), 'state', 'checkpoints-restored', 'marker-parent-race');
        const markerParentBackup = `${markerParent}.backup`;
        const externalMarkerParent = join(tempDir, 'external-marker-parent-race');
        const signalPath = join(tempDir, 'marker-parent-race-signal');
        const preloadPath = join(tempDir, 'marker-parent-race-preload.mjs');
        mkdirSync(markerParent, { recursive: true });
        mkdirSync(externalMarkerParent, { recursive: true });
        writeFileSync(preloadPath, `import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const originalOpenSync = fs.openSync;
let swapped = false;
fs.openSync = function(path, flags, mode) {
  if (!swapped && String(path).startsWith('.restored-stage-')) {
    swapped = true;
    fs.renameSync(process.env.MARKER_PARENT, process.env.MARKER_PARENT_BACKUP);
    fs.symlinkSync(
      process.env.EXTERNAL_MARKER_PARENT,
      process.env.MARKER_PARENT,
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    fs.writeFileSync(process.env.MARKER_SIGNAL, 'swapped');
  }
  return originalOpenSync.call(fs, path, flags, mode);
};
syncBuiltinESMExports();
`);
        try {
            const status = withPublisherPreload(preloadPath, {
                MARKER_PARENT: markerParent,
                MARKER_PARENT_BACKUP: markerParentBackup,
                EXTERNAL_MARKER_PARENT: externalMarkerParent,
                MARKER_SIGNAL: signalPath,
            }, () => markCheckpointRestored(tempDir, 'marker-parent-race', checkpointPath));
            expect(status).toBe('failed');
            if (process.platform !== 'win32')
                expect(existsSync(signalPath)).toBe(true);
            expect(existsSync(join(externalMarkerParent, 'restored.json'))).toBe(false);
        }
        finally {
            if (existsSync(markerParent))
                rmSync(markerParent, { recursive: true, force: true });
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
        const checkpointName = basename(checkpointPath);
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
        expect(JSON.parse(readFileSync(markerPath, 'utf-8')).checkpoint).toBe(realpathSync(checkpointA));
        const t2 = new Date().toISOString();
        const checkpointB = writeCheckpoint(tempDir, t2, { session_id: 'marker-advance-session' });
        const second = restorePreCompactCheckpoint(tempDir, 'marker-advance-session');
        expect(second?.marker_status).toBe('written');
        expect(second?.text).toContain(t2);
        expect(JSON.parse(readFileSync(markerPath, 'utf-8')).checkpoint).toBe(realpathSync(checkpointB));
        expect(restorePreCompactCheckpoint(tempDir, 'marker-advance-session')).toBeNull();
    });
    it('does not let a delayed older marker claim overwrite a newer checkpoint', () => {
        if (!SECURE_MARKER_SUPPORTED)
            return;
        const t1 = new Date(Date.now() - 2_000).toISOString();
        const t2 = new Date().toISOString();
        const checkpointA = writeCheckpoint(tempDir, t1, { session_id: 'marker-monotonic-session' });
        const checkpointB = writeCheckpoint(tempDir, t2, { session_id: 'marker-monotonic-session' });
        expect(markCheckpointRestored(tempDir, 'marker-monotonic-session', checkpointB, t2)).toBe('written');
        expect(markCheckpointRestored(tempDir, 'marker-monotonic-session', checkpointA, t1)).toBe('existing');
        const markerPath = join(getOmcRootForTest(tempDir), 'state', 'checkpoints-restored', 'marker-monotonic-session', 'restored.json');
        expect(JSON.parse(readFileSync(markerPath, 'utf-8')).checkpoint).toBe(realpathSync(checkpointB));
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
        const foreignCreatedAt = new Date(Date.now() + 10_000).toISOString();
        const checkpointDir = join(getOmcRootForTest(tempDir), 'state', 'checkpoints');
        mkdirSync(checkpointDir, { recursive: true });
        const foreignPath = join(checkpointDir, 'checkpoint-z.json');
        writeFileSync(foreignPath, JSON.stringify({
            created_at: foreignCreatedAt,
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
            checkpoint_created_at: foreignCreatedAt,
        }));
        expect(restorePreCompactCheckpoint(tempDir, 'current-session')?.text).toContain('checkpoint-a.json');
    });
    it('does not accept an equal-path marker claimed by a different session', () => {
        if (!SECURE_MARKER_SUPPORTED)
            return;
        const createdAt = new Date().toISOString();
        const checkpoint = writeCheckpoint(tempDir, createdAt, { session_id: 'session-b' });
        const markerParent = join(getOmcRootForTest(tempDir), 'state', 'checkpoints-restored', 'session-b');
        mkdirSync(markerParent, { recursive: true });
        writeFileSync(join(markerParent, 'restored.json'), JSON.stringify({
            restored_at: new Date().toISOString(),
            session_id: 'session-a',
            checkpoint,
            checkpoint_created_at: createdAt,
            checkpoint_mtime_ms: statSync(checkpoint).mtimeMs,
        }));
        expect(restorePreCompactCheckpoint(tempDir, 'session-b')?.marker_status).toBe('written');
        expect(JSON.parse(readFileSync(join(markerParent, 'restored.json'), 'utf8')).session_id).toBe('session-b');
    });
    it('skips a newer JSON-valid checkpoint with malformed active mode shapes', async () => {
        const sessionId = 'malformed-mode-fallback';
        const older = writeCheckpoint(tempDir, new Date(Date.now() - 2_000).toISOString(), { session_id: sessionId });
        const checkpointDir = join(getOmcRootForTest(tempDir), 'state', 'checkpoints');
        const newer = join(checkpointDir, 'checkpoint-malformed-mode.json');
        writeFileSync(newer, JSON.stringify({
            created_at: new Date().toISOString(), session_id: sessionId, trigger: 'auto',
            active_modes: { ralph: 'bad' },
            todo_summary: { pending: 0, in_progress: 0, completed: 0 }, wisdom_exported: false,
        }));
        const found = await findLatestCheckpointForRestore(tempDir, sessionId);
        expect(found.ok).toBe(true);
        if (found.ok)
            expect(found.path).toBe(older);
    });
    it('skips a newer-mtime checkpoint with an invalid created_at timestamp', async () => {
        const sessionId = 'invalid-date-fallback';
        const older = writeCheckpoint(tempDir, new Date(Date.now() - 2_000).toISOString(), { session_id: sessionId });
        const checkpointDir = join(getOmcRootForTest(tempDir), 'state', 'checkpoints');
        const invalid = join(checkpointDir, 'checkpoint-invalid-date.json');
        writeFileSync(invalid, JSON.stringify({
            created_at: 'not-a-date', session_id: sessionId, trigger: 'auto', active_modes: {},
            todo_summary: { pending: 0, in_progress: 0, completed: 0 }, wisdom_exported: false,
        }));
        const newerTime = new Date();
        utimesSync(invalid, newerTime, newerTime);
        const found = await findLatestCheckpointForRestore(tempDir, sessionId);
        expect(found.ok).toBe(true);
        if (found.ok)
            expect(found.path).toBe(older);
    });
    it('treats a same-path checkpoint replacement as a new immutable claim', () => {
        if (!SECURE_MARKER_SUPPORTED)
            return;
        const sessionId = 'same-path-replacement';
        const checkpointDir = join(getOmcRootForTest(tempDir), 'state', 'checkpoints');
        mkdirSync(checkpointDir, { recursive: true });
        const checkpoint = join(checkpointDir, 'checkpoint-fixed.json');
        const writeVersion = (createdAt, pending) => writeFileSync(checkpoint, JSON.stringify({
            created_at: createdAt, session_id: sessionId, trigger: 'auto', active_modes: {},
            todo_summary: { pending, in_progress: 0, completed: 0 }, wisdom_exported: false,
        }));
        const firstCreatedAt = new Date(Date.now() - 2_000).toISOString();
        writeVersion(firstCreatedAt, 1);
        expect(restorePreCompactCheckpoint(tempDir, sessionId)?.text).toContain(firstCreatedAt);
        const secondCreatedAt = new Date().toISOString();
        writeVersion(secondCreatedAt, 2);
        const newerTime = new Date();
        utimesSync(checkpoint, newerTime, newerTime);
        const restored = restorePreCompactCheckpoint(tempDir, sessionId);
        expect(restored?.marker_status).toBe('written');
        expect(restored?.text).toContain(secondCreatedAt);
    });
    it('does not publish an authoritative claim when projection publication fails', () => {
        if (!SECURE_MARKER_SUPPORTED)
            return;
        const sessionId = 'projection-failure-retry';
        const createdAt = new Date().toISOString();
        const checkpoint = writeCheckpoint(tempDir, createdAt, { session_id: sessionId });
        const signalPath = join(tempDir, 'projection-failure-signal');
        const preloadPath = join(tempDir, 'projection-failure-preload.mjs');
        writeFileSync(preloadPath, `import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const originalRenameSync = fs.renameSync;
let failed = false;
fs.renameSync = function(source, destination) {
  if (!failed && String(destination) === 'restored.json') {
    failed = true;
    fs.writeFileSync(process.env.MARKER_SIGNAL, 'failed');
    const error = new Error('projection failure');
    error.code = 'EIO';
    throw error;
  }
  return originalRenameSync.call(fs, source, destination);
};
syncBuiltinESMExports();
`);
        expect(withPublisherPreload(preloadPath, { MARKER_SIGNAL: signalPath }, () => markCheckpointRestored(tempDir, sessionId, checkpoint, createdAt, statSync(checkpoint).mtimeMs))).toBe('failed');
        expect(existsSync(signalPath)).toBe(true);
        expect(restorePreCompactCheckpoint(tempDir, sessionId)?.marker_status).toBe('written');
    });
    it('does not treat an unbacked projection as an authoritative claim', () => {
        const sessionId = 'claim-failure-retry';
        const createdAt = new Date().toISOString();
        const checkpoint = writeCheckpoint(tempDir, createdAt, { session_id: sessionId });
        const signalPath = join(tempDir, 'claim-failure-signal');
        const preloadPath = join(tempDir, 'claim-failure-preload.mjs');
        writeFileSync(preloadPath, `import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const originalLinkSync = fs.linkSync;
let failed = false;
fs.linkSync = function(source, destination) {
  if (!failed && /^restored-[0-9a-f]{64}\\.json$/.test(String(destination))) {
    failed = true;
    fs.writeFileSync(process.env.MARKER_SIGNAL, 'failed');
    const error = new Error('claim failure');
    error.code = 'EIO';
    throw error;
  }
  return originalLinkSync.call(fs, source, destination);
};
syncBuiltinESMExports();
`);
        expect(withPublisherPreload(preloadPath, { MARKER_SIGNAL: signalPath }, () => markCheckpointRestored(tempDir, sessionId, checkpoint, createdAt, statSync(checkpoint).mtimeMs))).toBe('failed');
        expect(existsSync(signalPath)).toBe(true);
        expect(restorePreCompactCheckpoint(tempDir, sessionId)?.marker_status).toBe('written');
    });
    it('retains an immutable ownership witness instead of racing stage cleanup', () => {
        const sessionId = 'claim-ownership-witness';
        const createdAt = new Date().toISOString();
        const checkpoint = writeCheckpoint(tempDir, createdAt, { session_id: sessionId });
        expect(markCheckpointRestored(tempDir, sessionId, checkpoint, createdAt, statSync(checkpoint).mtimeMs)).toBe('written');
        const markerParent = join(getOmcRootForTest(tempDir), 'state', 'checkpoints-restored', sessionId);
        const claim = readdirSync(markerParent).find((name) => /^restored-[0-9a-f]{64}\.json$/.test(name));
        const witness = readdirSync(markerParent).find((name) => name.startsWith('.restored-stage-claim-'));
        expect(claim).toBeDefined();
        expect(witness).toBeDefined();
        expect(statSync(join(markerParent, claim)).ino).toBe(statSync(join(markerParent, witness)).ino);
        expect(statSync(join(markerParent, claim)).nlink).toBeGreaterThanOrEqual(2);
        expect(restorePreCompactCheckpoint(tempDir, sessionId)).toBeNull();
    });
    it('rejects a claim whose deterministic filename does not match its provenance', () => {
        const sessionId = 'forged-claim-digest';
        const createdAt = new Date().toISOString();
        const checkpoint = writeCheckpoint(tempDir, createdAt, { session_id: sessionId });
        const markerParent = join(getOmcRootForTest(tempDir), 'state', 'checkpoints-restored', sessionId);
        mkdirSync(markerParent, { recursive: true });
        const marker = {
            session_id: sessionId,
            checkpoint,
            checkpoint_created_at: createdAt,
            checkpoint_mtime_ms: statSync(checkpoint).mtimeMs,
            checkpoint_sha256: createHash('sha256').update(readFileSync(checkpoint)).digest('hex'),
            claim_id: `restored-${'0'.repeat(64)}.json`,
        };
        writeFileSync(join(markerParent, marker.claim_id), JSON.stringify(marker));
        expect(restorePreCompactCheckpoint(tempDir, sessionId)?.marker_status).toBe('written');
    });
    it('rejects a correctly digested claim with a fractional marker mtime', () => {
        const sessionId = 'fractional-claim-mtime';
        const createdAt = new Date().toISOString();
        const checkpoint = writeCheckpoint(tempDir, createdAt, { session_id: sessionId });
        const checkpointSha = createHash('sha256').update(readFileSync(checkpoint)).digest('hex');
        const fractionalMtime = Math.trunc(statSync(checkpoint).mtimeMs) + 0.5;
        const digest = createHash('sha256').update(`${sessionId}\0${realpathSync(checkpoint)}\0${createdAt}\0${fractionalMtime}\0${checkpointSha}`).digest('hex');
        const claimName = `restored-${digest}.json`;
        const markerParent = join(getOmcRootForTest(tempDir), 'state', 'checkpoints-restored', sessionId);
        mkdirSync(markerParent, { recursive: true });
        writeFileSync(join(markerParent, claimName), JSON.stringify({
            session_id: sessionId,
            checkpoint: realpathSync(checkpoint),
            checkpoint_created_at: createdAt,
            checkpoint_mtime_ms: fractionalMtime,
            checkpoint_sha256: checkpointSha,
            claim_id: claimName,
        }));
        expect(restorePreCompactCheckpoint(tempDir, sessionId)?.marker_status).toBe('written');
    });
    it('rejects a correctly digested claim whose checkpoint spelling is not canonical', () => {
        const sessionId = 'alias-claim-path';
        const createdAt = new Date().toISOString();
        const checkpoint = writeCheckpoint(tempDir, createdAt, { session_id: sessionId });
        const canonicalCheckpoint = realpathSync(checkpoint);
        mkdirSync(join(dirname(canonicalCheckpoint), 'alias'));
        const aliasCheckpoint = `${dirname(canonicalCheckpoint)}${sep}alias${sep}..${sep}${basename(canonicalCheckpoint)}`;
        const checkpointMtime = Math.trunc(statSync(checkpoint).mtimeMs);
        const checkpointSha = createHash('sha256').update(readFileSync(checkpoint)).digest('hex');
        const digest = createHash('sha256').update(`${sessionId}\0${aliasCheckpoint}\0${createdAt}\0${checkpointMtime}\0${checkpointSha}`).digest('hex');
        const claimName = `restored-${digest}.json`;
        const markerParent = join(getOmcRootForTest(tempDir), 'state', 'checkpoints-restored', sessionId);
        mkdirSync(markerParent, { recursive: true });
        writeFileSync(join(markerParent, claimName), JSON.stringify({
            session_id: sessionId,
            checkpoint: aliasCheckpoint,
            checkpoint_created_at: createdAt,
            checkpoint_mtime_ms: checkpointMtime,
            checkpoint_sha256: checkpointSha,
            claim_id: claimName,
        }));
        expect(restorePreCompactCheckpoint(tempDir, sessionId)?.marker_status).toBe('written');
    });
    it('rejects a deterministic claim backed by a malformed checkpoint shape', () => {
        const sessionId = 'malformed-claim-shape';
        writeCheckpoint(tempDir, new Date(Date.now() - 2_000).toISOString(), { session_id: sessionId });
        const checkpointRoot = join(getOmcRootForTest(tempDir), 'state', 'checkpoints');
        const malformedPath = join(checkpointRoot, 'checkpoint-malformed-claim.json');
        const createdAt = new Date().toISOString();
        writeFileSync(malformedPath, JSON.stringify({
            created_at: createdAt,
            session_id: sessionId,
            trigger: 'auto',
            active_modes: 'invalid',
            todo_summary: { pending: 1, in_progress: 0, completed: 0 },
            wisdom_exported: false,
        }));
        const checkpointMtime = Math.trunc(statSync(malformedPath).mtimeMs);
        const checkpointSha = createHash('sha256').update(readFileSync(malformedPath)).digest('hex');
        const digest = createHash('sha256').update(`${sessionId}\0${realpathSync(malformedPath)}\0${createdAt}\0${checkpointMtime}\0${checkpointSha}`).digest('hex');
        const claimName = `restored-${digest}.json`;
        const markerParent = join(getOmcRootForTest(tempDir), 'state', 'checkpoints-restored', sessionId);
        mkdirSync(markerParent, { recursive: true });
        writeFileSync(join(markerParent, claimName), JSON.stringify({
            session_id: sessionId,
            checkpoint: realpathSync(malformedPath),
            checkpoint_created_at: createdAt,
            checkpoint_mtime_ms: checkpointMtime,
            checkpoint_sha256: checkpointSha,
            claim_id: claimName,
        }));
        expect(restorePreCompactCheckpoint(tempDir, sessionId)?.marker_status).toBe('written');
    });
    it('rejects a deterministic claim backed by a checkpoint outside the canonical root', () => {
        const sessionId = 'external-claim-provenance';
        const localCreatedAt = new Date(Date.now() - 2_000).toISOString();
        writeCheckpoint(tempDir, localCreatedAt, { session_id: sessionId });
        const externalCheckpoint = join(tempDir, 'external-checkpoint.json');
        const externalCreatedAt = new Date().toISOString();
        writeFileSync(externalCheckpoint, JSON.stringify({
            created_at: externalCreatedAt,
            session_id: sessionId,
            trigger: 'auto',
            active_modes: {},
            todo_summary: { pending: 1, in_progress: 0, completed: 0 },
            wisdom_exported: false,
        }));
        const externalMtime = statSync(externalCheckpoint).mtimeMs;
        const externalSha = createHash('sha256').update(readFileSync(externalCheckpoint)).digest('hex');
        const digest = createHash('sha256').update(`${sessionId}\0${externalCheckpoint}\0${externalCreatedAt}\0${externalMtime}\0${externalSha}`).digest('hex');
        const claimName = `restored-${digest}.json`;
        const markerParent = join(getOmcRootForTest(tempDir), 'state', 'checkpoints-restored', sessionId);
        mkdirSync(markerParent, { recursive: true });
        writeFileSync(join(markerParent, claimName), JSON.stringify({
            session_id: sessionId,
            checkpoint: externalCheckpoint,
            checkpoint_created_at: externalCreatedAt,
            checkpoint_mtime_ms: externalMtime,
            checkpoint_sha256: externalSha,
            claim_id: claimName,
        }));
        expect(restorePreCompactCheckpoint(tempDir, sessionId)?.marker_status).toBe('written');
    });
    it('rejects a deterministic claim backed by a non-checkpoint file inside the checkpoint root', () => {
        const sessionId = 'non-checkpoint-claim-provenance';
        writeCheckpoint(tempDir, new Date(Date.now() - 2_000).toISOString(), { session_id: sessionId });
        const checkpointRoot = join(getOmcRootForTest(tempDir), 'state', 'checkpoints');
        const forgedPath = join(checkpointRoot, 'evil.json');
        const forgedCreatedAt = new Date().toISOString();
        writeFileSync(forgedPath, JSON.stringify({
            created_at: forgedCreatedAt,
            session_id: sessionId,
            trigger: 'auto',
            active_modes: {},
            todo_summary: { pending: 1, in_progress: 0, completed: 0 },
            wisdom_exported: false,
        }));
        const forgedMtime = statSync(forgedPath).mtimeMs;
        const forgedSha = createHash('sha256').update(readFileSync(forgedPath)).digest('hex');
        const digest = createHash('sha256').update(`${sessionId}\0${forgedPath}\0${forgedCreatedAt}\0${forgedMtime}\0${forgedSha}`).digest('hex');
        const claimName = `restored-${digest}.json`;
        const markerParent = join(getOmcRootForTest(tempDir), 'state', 'checkpoints-restored', sessionId);
        mkdirSync(markerParent, { recursive: true });
        writeFileSync(join(markerParent, claimName), JSON.stringify({
            session_id: sessionId,
            checkpoint: forgedPath,
            checkpoint_created_at: forgedCreatedAt,
            checkpoint_mtime_ms: forgedMtime,
            checkpoint_sha256: forgedSha,
            claim_id: claimName,
        }));
        expect(restorePreCompactCheckpoint(tempDir, sessionId)?.marker_status).toBe('written');
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
        for (const bad of ['', 'a/b', 'a\\b', 'a..b', 'a b', 'CON', 'lpt1']) {
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