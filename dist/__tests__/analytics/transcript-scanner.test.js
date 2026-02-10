import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import { mkdirSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir, tmpdir } from 'os';
import { scanTranscripts, decodeProjectPath } from '../../analytics/transcript-scanner.js';
/**
 * Helper to encode a path the same way Claude Code does.
 * - Unix: "/home/user/project" → "-home-user-project"
 * - Windows: "C:\Users\user\project" → "C--Users-user-project"
 */
function encodePathForTest(absolutePath) {
    // Normalize path separators to forward slashes
    const normalized = absolutePath.replace(/\\/g, '/');
    // Check for Windows drive letter (e.g., "C:/...")
    const windowsDriveMatch = normalized.match(/^([A-Za-z]):\/(.*)$/);
    if (windowsDriveMatch) {
        const driveLetter = windowsDriveMatch[1];
        const rest = windowsDriveMatch[2];
        // Encode as "C--Users-user-project"
        return `${driveLetter}-${rest.replace(/\//g, '-')}`;
    }
    // Unix path (e.g., "/home/user/project")
    if (normalized.startsWith('/')) {
        return `-${normalized.slice(1).replace(/\//g, '-')}`;
    }
    // Relative path - return as-is
    return normalized.replace(/\//g, '-');
}
/**
 * Helper to get expected decoded path format.
 * Windows paths are returned with forward slashes for consistency.
 */
function expectedDecodedPath(absolutePath) {
    // Normalize to forward slashes (the decoder always uses forward slashes)
    return absolutePath.replace(/\\/g, '/');
}
vi.mock('fs/promises');
vi.mock('os');
describe('transcript-scanner', () => {
    const mockHomedir = '/home/testuser';
    const projectsDir = join(mockHomedir, '.claude', 'projects');
    beforeEach(() => {
        vi.mocked(homedir).mockReturnValue(mockHomedir);
    });
    afterEach(() => {
        vi.clearAllMocks();
    });
    describe('scanTranscripts()', () => {
        it('discovers .jsonl files in project directories', async () => {
            const mockEntries = [
                { name: '-home-testuser-project1', isDirectory: () => true },
                { name: '-home-testuser-project2', isDirectory: () => true },
            ];
            const mockProjectFiles1 = [
                'a1b2c3d4-e5f6-7890-abcd-ef1234567890.jsonl',
                'b2c3d4e5-f6a7-8901-bcde-f12345678901.jsonl',
                'sessions-index.json',
            ];
            const mockProjectFiles2 = [
                'c3d4e5f6-a7b8-9012-cdef-123456789012.jsonl',
            ];
            vi.mocked(fs.readdir)
                .mockResolvedValueOnce(mockEntries)
                .mockResolvedValueOnce(mockProjectFiles1)
                .mockResolvedValueOnce(mockProjectFiles2);
            vi.mocked(fs.stat).mockImplementation(async (path) => {
                const stats = {
                    size: 1024,
                    mtime: new Date('2026-01-24T00:00:00.000Z'),
                };
                return stats;
            });
            const result = await scanTranscripts();
            expect(result.transcripts).toHaveLength(3);
            expect(result.projectCount).toBe(2);
            expect(result.totalSize).toBe(3072); // 1024 * 3
            expect(result.transcripts[0]).toMatchObject({
                projectPath: '/home/testuser/project1',
                projectDir: '-home-testuser-project1',
                sessionId: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
                fileSize: 1024,
            });
        });
        it('filters by project pattern', async () => {
            const mockEntries = [
                { name: '-home-testuser-workspace-foo', isDirectory: () => true },
                { name: '-home-testuser-workspace-bar', isDirectory: () => true },
                { name: '-home-testuser-other-baz', isDirectory: () => true },
            ];
            const mockProjectFiles = [
                'a1b2c3d4-e5f6-7890-abcd-ef1234567890.jsonl',
            ];
            vi.mocked(fs.readdir)
                .mockResolvedValueOnce(mockEntries)
                .mockResolvedValue(mockProjectFiles);
            vi.mocked(fs.stat).mockResolvedValue({
                size: 512,
                mtime: new Date('2026-01-24T00:00:00.000Z'),
            });
            const result = await scanTranscripts({
                projectFilter: '/home/testuser/workspace/*',
            });
            expect(result.transcripts).toHaveLength(2);
            expect(result.transcripts[0].projectPath).toBe('/home/testuser/workspace/foo');
            expect(result.transcripts[1].projectPath).toBe('/home/testuser/workspace/bar');
        });
        it('filters by date', async () => {
            const mockEntries = [
                { name: '-home-testuser-project', isDirectory: () => true },
            ];
            const mockProjectFiles = [
                'a1b2c3d4-e5f6-7890-abcd-ef1234567890.jsonl',
                'b2c3d4e5-f6a7-8901-bcde-f12345678901.jsonl',
                'c3d4e5f6-a7b8-9012-cdef-123456789012.jsonl',
            ];
            vi.mocked(fs.readdir)
                .mockResolvedValueOnce(mockEntries)
                .mockResolvedValueOnce(mockProjectFiles);
            let callIndex = 0;
            vi.mocked(fs.stat).mockImplementation(async () => {
                const dates = [
                    new Date('2026-01-20T00:00:00.000Z'), // Old
                    new Date('2026-01-23T00:00:00.000Z'), // Recent
                    new Date('2026-01-24T00:00:00.000Z'), // Recent
                ];
                const stats = {
                    size: 256,
                    mtime: dates[callIndex++],
                };
                return stats;
            });
            const result = await scanTranscripts({
                minDate: new Date('2026-01-22T00:00:00.000Z'),
            });
            expect(result.transcripts).toHaveLength(2);
            expect(result.transcripts[0].sessionId).toBe('b2c3d4e5-f6a7-8901-bcde-f12345678901');
            expect(result.transcripts[1].sessionId).toBe('c3d4e5f6-a7b8-9012-cdef-123456789012');
        });
        it('excludes non-UUID filenames', async () => {
            const mockEntries = [
                { name: '-home-testuser-project', isDirectory: () => true },
            ];
            const mockProjectFiles = [
                'a1b2c3d4-e5f6-7890-abcd-ef1234567890.jsonl', // Valid UUID
                'invalid-session-id.jsonl', // Invalid
                'not-a-uuid.jsonl', // Invalid
                'sessions-index.json', // Excluded anyway
                'readme.txt', // Not .jsonl
            ];
            vi.mocked(fs.readdir)
                .mockResolvedValueOnce(mockEntries)
                .mockResolvedValueOnce(mockProjectFiles);
            vi.mocked(fs.stat).mockResolvedValue({
                size: 128,
                mtime: new Date('2026-01-24T00:00:00.000Z'),
            });
            const result = await scanTranscripts();
            expect(result.transcripts).toHaveLength(1);
            expect(result.transcripts[0].sessionId).toBe('a1b2c3d4-e5f6-7890-abcd-ef1234567890');
        });
        it('handles missing directories gracefully', async () => {
            const error = new Error('ENOENT');
            error.code = 'ENOENT';
            vi.mocked(fs.readdir).mockRejectedValue(error);
            const result = await scanTranscripts();
            expect(result).toEqual({
                transcripts: [],
                totalSize: 0,
                projectCount: 0,
            });
        });
        it('throws on other file system errors', async () => {
            const error = new Error('EACCES');
            error.code = 'EACCES';
            vi.mocked(fs.readdir).mockRejectedValue(error);
            await expect(scanTranscripts()).rejects.toThrow('EACCES');
        });
        it('skips non-directory entries', async () => {
            const mockEntries = [
                { name: '-home-testuser-project', isDirectory: () => true },
                { name: 'some-file.txt', isDirectory: () => false },
            ];
            const mockProjectFiles = [
                'a1b2c3d4-e5f6-7890-abcd-ef1234567890.jsonl',
            ];
            vi.mocked(fs.readdir)
                .mockResolvedValueOnce(mockEntries)
                .mockResolvedValueOnce(mockProjectFiles);
            vi.mocked(fs.stat).mockResolvedValue({
                size: 64,
                mtime: new Date('2026-01-24T00:00:00.000Z'),
            });
            const result = await scanTranscripts();
            expect(result.transcripts).toHaveLength(1);
            expect(result.projectCount).toBe(1);
        });
        it('calculates total size correctly', async () => {
            const mockEntries = [
                { name: '-home-testuser-project', isDirectory: () => true },
            ];
            const mockProjectFiles = [
                'a1b2c3d4-e5f6-7890-abcd-ef1234567890.jsonl',
                'b2c3d4e5-f6a7-8901-bcde-f12345678901.jsonl',
            ];
            vi.mocked(fs.readdir)
                .mockResolvedValueOnce(mockEntries)
                .mockResolvedValueOnce(mockProjectFiles);
            let callIndex = 0;
            vi.mocked(fs.stat).mockImplementation(async () => {
                const sizes = [2048, 4096];
                const stats = {
                    size: sizes[callIndex++],
                    mtime: new Date('2026-01-24T00:00:00.000Z'),
                };
                return stats;
            });
            const result = await scanTranscripts();
            expect(result.totalSize).toBe(6144);
        });
        it('handles empty project directories', async () => {
            const mockEntries = [
                { name: '-home-testuser-empty-project', isDirectory: () => true },
            ];
            vi.mocked(fs.readdir)
                .mockResolvedValueOnce(mockEntries)
                .mockResolvedValueOnce([]); // Empty directory
            const result = await scanTranscripts();
            expect(result.transcripts).toHaveLength(0);
            expect(result.projectCount).toBe(0);
        });
        it('combines project and date filters', async () => {
            const mockEntries = [
                { name: '-home-testuser-workspace-foo', isDirectory: () => true },
                { name: '-home-testuser-other-bar', isDirectory: () => true },
            ];
            const mockProjectFiles = [
                'a1b2c3d4-e5f6-7890-abcd-ef1234567890.jsonl',
            ];
            vi.mocked(fs.readdir)
                .mockResolvedValueOnce(mockEntries)
                .mockResolvedValue(mockProjectFiles);
            let callIndex = 0;
            vi.mocked(fs.stat).mockImplementation(async () => {
                const dates = [
                    new Date('2026-01-24T00:00:00.000Z'), // workspace-foo: recent
                    new Date('2026-01-20T00:00:00.000Z'), // other-bar: old (but filtered by project anyway)
                ];
                const stats = {
                    size: 512,
                    mtime: dates[callIndex++],
                };
                return stats;
            });
            const result = await scanTranscripts({
                projectFilter: '/home/testuser/workspace/*',
                minDate: new Date('2026-01-23T00:00:00.000Z'),
            });
            expect(result.transcripts).toHaveLength(1);
            expect(result.transcripts[0].projectPath).toBe('/home/testuser/workspace/foo');
        });
    });
    describe('decodeProjectPath()', () => {
        it('decodes standard encoded paths', () => {
            // We need to test this indirectly through scanTranscripts
            const mockEntries = [
                { name: '-home-user-workspace-project', isDirectory: () => true },
            ];
            const mockProjectFiles = [
                'a1b2c3d4-e5f6-7890-abcd-ef1234567890.jsonl',
            ];
            vi.mocked(fs.readdir)
                .mockResolvedValueOnce(mockEntries)
                .mockResolvedValueOnce(mockProjectFiles);
            vi.mocked(fs.stat).mockResolvedValue({
                size: 128,
                mtime: new Date('2026-01-24T00:00:00.000Z'),
            });
            return scanTranscripts().then(result => {
                expect(result.transcripts[0].projectPath).toBe('/home/user/workspace/project');
            });
        });
        it('handles paths without leading dash', () => {
            const mockEntries = [
                { name: 'relative-path-project', isDirectory: () => true },
            ];
            const mockProjectFiles = [
                'a1b2c3d4-e5f6-7890-abcd-ef1234567890.jsonl',
            ];
            vi.mocked(fs.readdir)
                .mockResolvedValueOnce(mockEntries)
                .mockResolvedValueOnce(mockProjectFiles);
            vi.mocked(fs.stat).mockResolvedValue({
                size: 128,
                mtime: new Date('2026-01-24T00:00:00.000Z'),
            });
            return scanTranscripts().then(result => {
                // Should return unchanged if no leading dash
                expect(result.transcripts[0].projectPath).toBe('relative-path-project');
            });
        });
        it('handles root path', () => {
            const mockEntries = [
                { name: '-root', isDirectory: () => true },
            ];
            const mockProjectFiles = [
                'a1b2c3d4-e5f6-7890-abcd-ef1234567890.jsonl',
            ];
            vi.mocked(fs.readdir)
                .mockResolvedValueOnce(mockEntries)
                .mockResolvedValueOnce(mockProjectFiles);
            vi.mocked(fs.stat).mockResolvedValue({
                size: 128,
                mtime: new Date('2026-01-24T00:00:00.000Z'),
            });
            return scanTranscripts().then(result => {
                expect(result.transcripts[0].projectPath).toBe('/root');
            });
        });
    });
});
/**
 * Tests for decodeProjectPath with actual filesystem checks.
 * These tests verify the smart path resolution works correctly with real directories.
 */
describe('decodeProjectPath (filesystem-aware)', () => {
    let testDir;
    beforeEach(() => {
        // Restore tmpdir for this test suite
        vi.mocked(tmpdir).mockReturnValue(require('os').tmpdir());
        // Create a temporary test directory
        testDir = join(tmpdir(), `test-decode-path-${Date.now()}`);
        mkdirSync(testDir, { recursive: true });
    });
    afterEach(() => {
        // Clean up test directory
        if (existsSync(testDir)) {
            rmSync(testDir, { recursive: true, force: true });
        }
    });
    it('should return non-encoded paths as-is', () => {
        const result = decodeProjectPath('my-project');
        expect(result).toBe('my-project');
    });
    it('should decode simple paths without hyphens when path exists', () => {
        // Create: {testDir}/home/user/project
        const projectPath = join(testDir, 'home', 'user', 'project');
        mkdirSync(projectPath, { recursive: true });
        const fullPath = join(testDir, 'home', 'user', 'project');
        const encoded = encodePathForTest(fullPath);
        const result = decodeProjectPath(encoded);
        expect(result).toBe(expectedDecodedPath(fullPath));
    });
    it('should decode paths with legitimate hyphens in directory names', () => {
        // Create: {testDir}/home/user/my-project
        const projectPath = join(testDir, 'home', 'user', 'my-project');
        mkdirSync(projectPath, { recursive: true });
        const fullPath = join(testDir, 'home', 'user', 'my-project');
        const encoded = encodePathForTest(fullPath);
        const result = decodeProjectPath(encoded);
        // Should preserve "my-project" as one directory
        expect(result).toBe(expectedDecodedPath(fullPath));
    });
    it('should handle multiple hyphens in a single directory name', () => {
        // Create: {testDir}/home/user/my-cool-project
        const projectPath = join(testDir, 'home', 'user', 'my-cool-project');
        mkdirSync(projectPath, { recursive: true });
        const fullPath = join(testDir, 'home', 'user', 'my-cool-project');
        const encoded = encodePathForTest(fullPath);
        const result = decodeProjectPath(encoded);
        expect(result).toBe(expectedDecodedPath(fullPath));
    });
    it('should handle hyphens at multiple levels', () => {
        // Create: {testDir}/my-workspace/my-project
        const projectPath = join(testDir, 'my-workspace', 'my-project');
        mkdirSync(projectPath, { recursive: true });
        const fullPath = join(testDir, 'my-workspace', 'my-project');
        const encoded = encodePathForTest(fullPath);
        const result = decodeProjectPath(encoded);
        expect(result).toBe(expectedDecodedPath(fullPath));
    });
    it('should fall back to simple decode if no matching filesystem path exists', () => {
        // Don't create any directories - test fallback behavior
        const encoded = '-home-user-nonexistent-project';
        const result = decodeProjectPath(encoded);
        // Should fall back to simple decode (all dashes -> slashes)
        expect(result).toBe('/home/user/nonexistent/project');
    });
    it('should handle root-level project directories', () => {
        // Create: {testDir}/my-project
        const projectPath = join(testDir, 'my-project');
        mkdirSync(projectPath, { recursive: true });
        const fullPath = join(testDir, 'my-project');
        const encoded = encodePathForTest(fullPath);
        const result = decodeProjectPath(encoded);
        expect(result).toBe(expectedDecodedPath(fullPath));
    });
    it('should prefer filesystem-verified paths over simple decode', () => {
        // Create: {testDir}/a/b-c (the correct interpretation)
        // Don't create {testDir}/a/b/c
        const correctPath = join(testDir, 'a', 'b-c');
        mkdirSync(correctPath, { recursive: true });
        const fullPath = join(testDir, 'a', 'b-c');
        const encoded = encodePathForTest(fullPath);
        const result = decodeProjectPath(encoded);
        // Should choose /a/b-c over /a/b/c
        expect(result).toBe(expectedDecodedPath(fullPath));
    });
    it('should handle deeply nested paths with hyphens', () => {
        // Create: {testDir}/home/user/workspace/my-project/sub-folder
        const projectPath = join(testDir, 'home', 'user', 'workspace', 'my-project', 'sub-folder');
        mkdirSync(projectPath, { recursive: true });
        const fullPath = join(testDir, 'home', 'user', 'workspace', 'my-project', 'sub-folder');
        const encoded = encodePathForTest(fullPath);
        const result = decodeProjectPath(encoded);
        expect(result).toBe(expectedDecodedPath(fullPath));
    });
    it('should handle paths with consecutive hyphens', () => {
        // Create: {testDir}/my--project (unusual but valid)
        const projectPath = join(testDir, 'my--project');
        mkdirSync(projectPath, { recursive: true });
        const fullPath = join(testDir, 'my--project');
        const encoded = encodePathForTest(fullPath);
        const result = decodeProjectPath(encoded);
        expect(result).toBe(expectedDecodedPath(fullPath));
    });
    it('should find first matching path when multiple interpretations exist', () => {
        // Create both possible interpretations
        const path1 = join(testDir, 'a-b', 'c');
        const path2 = join(testDir, 'a', 'b-c');
        mkdirSync(path1, { recursive: true });
        mkdirSync(path2, { recursive: true });
        const fullPath = join(testDir, 'a', 'b-c'); // Use one as reference for encoding
        const encoded = encodePathForTest(fullPath);
        const result = decodeProjectPath(encoded);
        // Should match one of the valid paths
        const expected1 = expectedDecodedPath(path1);
        const expected2 = expectedDecodedPath(path2);
        const isValid = result === expected1 || result === expected2;
        expect(isValid).toBe(true);
    });
});
//# sourceMappingURL=transcript-scanner.test.js.map