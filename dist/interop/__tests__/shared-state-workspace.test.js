/**
 * Regression test for workspace-marker path resolution in shared-state.
 *
 * When initInteropSession (and all other writers) are called from a sub-repo
 * inside a .omc-workspace multi-repo layout, interop state must land at the
 * workspace root's .omc/, not at the sub-repo's .omc/.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { execSync } from 'child_process';
import { join } from 'path';
import { homedir } from 'os';
import { clearWorktreeCache } from '../../lib/worktree-paths.js';
import { initInteropSession } from '../shared-state.js';
describe('shared-state workspace-marker path resolution', () => {
    let workspaceRoot;
    let subDir;
    let fixtureHome;
    let previousHome;
    let previousUserProfile;
    let previousStateDir;
    beforeEach(() => {
        previousHome = process.env.HOME;
        previousUserProfile = process.env.USERPROFILE;
        previousStateDir = process.env.OMC_STATE_DIR;
        // Build fixture:
        //   A/              ← workspace root (contains .omc-workspace marker)
        //   A/sub/          ← child git repo (git init'd)
        fixtureHome = mkdtempSync(join(homedir(), 'omc-workspace-home-'));
        workspaceRoot = join(fixtureHome, 'workspace');
        subDir = join(workspaceRoot, 'sub');
        mkdirSync(subDir, { recursive: true });
        process.env.HOME = fixtureHome;
        process.env.USERPROFILE = fixtureHome;
        delete process.env.OMC_STATE_DIR;
        // Place the workspace marker at the workspace root.
        writeFileSync(join(workspaceRoot, '.omc-workspace'), '');
        // Initialize a real git repo inside sub/ so git-based resolution
        // (getWorktreeRoot) would otherwise anchor to subDir, not workspaceRoot.
        try {
            execSync('git init', { cwd: subDir, stdio: 'pipe' });
        }
        catch {
            // git may not be available in CI; the workspace-marker path still wins.
        }
        // Clear LRU caches so this test is not affected by earlier state.
        clearWorktreeCache();
    });
    afterEach(() => {
        if (previousHome === undefined)
            delete process.env.HOME;
        else
            process.env.HOME = previousHome;
        if (previousUserProfile === undefined)
            delete process.env.USERPROFILE;
        else
            process.env.USERPROFILE = previousUserProfile;
        if (previousStateDir === undefined)
            delete process.env.OMC_STATE_DIR;
        else
            process.env.OMC_STATE_DIR = previousStateDir;
        rmSync(fixtureHome, { recursive: true, force: true });
        // Clear caches so other tests are not polluted by this fixture.
        clearWorktreeCache();
    });
    it('writes interop config to the workspace root .omc/, not the sub-repo .omc/', () => {
        // Call initInteropSession from the child sub-repo directory.
        initInteropSession('test-session', subDir);
        // Expected: file is at workspace root
        const expectedPath = join(workspaceRoot, '.omc', 'state', 'interop', 'config.json');
        // Regression: file would be at sub-repo root if the bug were present
        const wrongPath = join(subDir, '.omc', 'state', 'interop', 'config.json');
        expect(existsSync(expectedPath)).toBe(true);
        expect(existsSync(wrongPath)).toBe(false);
    });
});
//# sourceMappingURL=shared-state-workspace.test.js.map