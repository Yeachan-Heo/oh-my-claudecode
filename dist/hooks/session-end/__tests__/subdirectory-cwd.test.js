/**
 * Tests for issue #891: MCP state tools and stop hook resolve .omc/state/
 * differently when cwd is a subdirectory.
 *
 * processSessionEnd must normalize input.cwd to the git worktree root before
 * building any .omc/ paths, so it always operates on the same directory that
 * the MCP state tools write to.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
vi.mock('../callbacks.js', () => ({
    triggerStopCallbacks: vi.fn(async () => undefined),
}));
vi.mock('../../../notifications/index.js', () => ({
    notify: vi.fn(async () => undefined),
}));
vi.mock('../../../tools/python-repl/bridge-manager.js', () => ({
    cleanupBridgeSessions: vi.fn(async () => ({
        requestedSessions: 0,
        foundSessions: 0,
        terminatedSessions: 0,
        errors: [],
    })),
}));
// Mock resolveToWorktreeRoot so we can simulate the subdirectory → root mapping
// without needing an actual git repository in the temp dir.
vi.mock('../../../lib/worktree-paths.js', async () => {
    const actual = await vi.importActual('../../../lib/worktree-paths.js');
    return {
        ...actual,
        resolveToWorktreeRoot: vi.fn((dir) => dir ?? process.cwd()),
    };
});
import { processSessionEnd } from '../index.js';
import { resolveToWorktreeRoot } from '../../../lib/worktree-paths.js';
const mockResolveToWorktreeRoot = vi.mocked(resolveToWorktreeRoot);
describe('processSessionEnd cwd normalization (issue #891)', () => {
    let worktreeRoot;
    let subdirectory;
    let previousHome;
    let previousUserProfile;
    beforeEach(() => {
        worktreeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'omc-891-root-'));
        previousHome = process.env.HOME;
        previousUserProfile = process.env.USERPROFILE;
        process.env.HOME = worktreeRoot;
        process.env.USERPROFILE = worktreeRoot;
        subdirectory = path.join(worktreeRoot, 'src', 'deep', 'nested');
        fs.mkdirSync(subdirectory, { recursive: true });
        // Simulate resolveToWorktreeRoot mapping subdirectory -> worktreeRoot
        mockResolveToWorktreeRoot.mockImplementation((dir) => {
            if (dir === subdirectory)
                return worktreeRoot;
            return dir ?? worktreeRoot;
        });
    });
    afterEach(() => {
        fs.rmSync(worktreeRoot, { recursive: true, force: true });
        if (previousHome === undefined)
            delete process.env.HOME;
        else
            process.env.HOME = previousHome;
        if (previousUserProfile === undefined)
            delete process.env.USERPROFILE;
        else
            process.env.USERPROFILE = previousUserProfile;
        vi.clearAllMocks();
    });
    it('calls resolveToWorktreeRoot with the raw cwd before building any paths', async () => {
        await processSessionEnd({
            session_id: 'test-session-891',
            transcript_path: '',
            cwd: subdirectory,
            permission_mode: 'default',
            hook_event_name: 'SessionEnd',
            reason: 'clear',
        });
        expect(mockResolveToWorktreeRoot).toHaveBeenCalledWith(subdirectory);
    });
    it('reads and cleans up state written at worktree root, not subdirectory', async () => {
        // Write an active state file at the worktree root (as MCP tools would)
        const stateDir = path.join(worktreeRoot, '.omc', 'state');
        fs.mkdirSync(stateDir, { recursive: true });
        fs.writeFileSync(path.join(stateDir, 'ultrawork-state.json'), JSON.stringify({
            active: true,
            session_id: 'test-session-891',
            started_at: new Date().toISOString(),
        }));
        await processSessionEnd({
            session_id: 'test-session-891',
            transcript_path: '',
            cwd: subdirectory,
            permission_mode: 'default',
            hook_event_name: 'SessionEnd',
            reason: 'clear',
        });
        // State at worktree root must have been cleaned up
        expect(fs.existsSync(path.join(stateDir, 'ultrawork-state.json'))).toBe(false);
    });
    it('writes session summary to worktree root, not subdirectory', async () => {
        await processSessionEnd({
            session_id: 'test-session-891-summary',
            transcript_path: '',
            cwd: subdirectory,
            permission_mode: 'default',
            hook_event_name: 'SessionEnd',
            reason: 'clear',
        });
        // Session summary should appear under worktreeRoot/.omc/sessions/
        const summaryPath = path.join(worktreeRoot, '.omc', 'sessions', 'test-session-891-summary.json');
        expect(fs.existsSync(summaryPath)).toBe(true);
        // Nothing should have been written under the subdirectory
        expect(fs.existsSync(path.join(subdirectory, '.omc'))).toBe(false);
    });
    it('leaves state at worktree root untouched when cwd is already the root', async () => {
        // When cwd IS the root, resolveToWorktreeRoot returns it unchanged
        mockResolveToWorktreeRoot.mockImplementation((dir) => dir ?? worktreeRoot);
        const stateDir = path.join(worktreeRoot, '.omc', 'state');
        fs.mkdirSync(stateDir, { recursive: true });
        // Write a state file that is inactive — should NOT be removed
        fs.writeFileSync(path.join(stateDir, 'ralph-state.json'), JSON.stringify({ active: false, session_id: 'other-session' }));
        await processSessionEnd({
            session_id: 'test-session-root',
            transcript_path: '',
            cwd: worktreeRoot,
            permission_mode: 'default',
            hook_event_name: 'SessionEnd',
            reason: 'clear',
        });
        // Inactive state for a different session must remain
        expect(fs.existsSync(path.join(stateDir, 'ralph-state.json'))).toBe(true);
    });
});
//# sourceMappingURL=subdirectory-cwd.test.js.map