import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, parse } from 'node:path';
import { validateWorktreeRemovalTarget } from '../worktree-cleanup-safety.js';
const tempDirs = [];
function makeTempRoot() {
    const root = join(tmpdir(), `omc-cleanup-safety-${process.pid}-${tempDirs.length}-${Date.now()}`);
    mkdirSync(root, { recursive: true });
    tempDirs.push(root);
    return root;
}
afterEach(() => {
    while (tempDirs.length > 0) {
        const dir = tempDirs.pop();
        rmSync(dir, { recursive: true, force: true });
    }
});
describe('validateWorktreeRemovalTarget', () => {
    it.each(['', '   ', '.', '..', '~'])('refuses suspicious path %j', (candidatePath) => {
        const root = makeTempRoot();
        expect(() => validateWorktreeRemovalTarget({ candidatePath, expectedRoots: [root] })).toThrow(/empty|suspicious/);
    });
    it('refuses NUL bytes before filesystem checks', () => {
        const root = makeTempRoot();
        expect(() => validateWorktreeRemovalTarget({ candidatePath: `bad${String.fromCharCode(0)}path`, expectedRoots: [root] })).toThrow(/contains_nul/);
    });
    it('refuses filesystem root and home directory', () => {
        const root = makeTempRoot();
        expect(() => validateWorktreeRemovalTarget({ candidatePath: parse(root).root, expectedRoots: [root] })).toThrow(/filesystem_root/);
        expect(() => validateWorktreeRemovalTarget({ candidatePath: homedir(), expectedRoots: [root] })).toThrow(/home_directory|outside_expected_roots/);
    });
    it('rejects symlink worktree targets even when the real path would be inside the root', () => {
        const root = makeTempRoot();
        const realTarget = join(root, 'real-worktree');
        const linkTarget = join(root, 'linked-worktree');
        mkdirSync(realTarget, { recursive: true });
        symlinkSync(realTarget, linkTarget, 'dir');
        expect(() => validateWorktreeRemovalTarget({ candidatePath: linkTarget, expectedRoots: [root] })).toThrow(/symlink/);
        expect(existsSync(realTarget)).toBe(true);
    });
    it('rejects paths outside the expected worktree root after realpath normalization', () => {
        const root = makeTempRoot();
        const outside = makeTempRoot();
        const target = join(outside, 'repo-3090');
        mkdirSync(target, { recursive: true });
        expect(() => validateWorktreeRemovalTarget({ candidatePath: target, expectedRoots: [root] })).toThrow(/outside_expected_roots/);
    });
    it('rejects the expected root itself so cleanup must target a child worktree', () => {
        const root = makeTempRoot();
        expect(() => validateWorktreeRemovalTarget({ candidatePath: root, expectedRoots: [root] })).toThrow(/outside_expected_roots/);
    });
    it('rejects main repositories with a .git directory, covering the #3089 data-loss shape', () => {
        const root = makeTempRoot();
        const repo = join(root, 'repo-3089');
        mkdirSync(join(repo, '.git'), { recursive: true });
        expect(() => validateWorktreeRemovalTarget({ candidatePath: repo, expectedRoots: [root], mainRepoRoots: [repo] })).toThrow(/main_repo/);
    });
    it('allows a registered-looking worktree child with a .git file under an expected root', () => {
        const root = makeTempRoot();
        const worktree = join(root, 'repo-3090');
        mkdirSync(worktree, { recursive: true });
        writeFileSync(join(worktree, '.git'), 'gitdir: /repo/.git/worktrees/repo-3090\n');
        const result = validateWorktreeRemovalTarget({
            candidatePath: worktree,
            expectedRoots: [root],
            mainRepoRoots: [join(root, 'main-repo')],
        });
        expect(result.resolvedPath).toBe(realpathSync(worktree));
        expect(result.matchedRoot).toBe(realpathSync(root));
    });
});
//# sourceMappingURL=worktree-cleanup-safety.test.js.map