import { describe, it, expect, vi, beforeEach } from 'vitest';
import { validateAndReadFile } from '../mcp/codex-core.js';
import { validateAndReadFile as validateAndReadFileGemini } from '../mcp/gemini-core.js';
import * as path from 'path';
// Mock fs module
vi.mock('fs', async () => {
    const actual = await vi.importActual('fs');
    return {
        ...actual,
        realpathSync: vi.fn(),
        statSync: vi.fn(),
        readFileSync: vi.fn(),
    };
});
import { realpathSync, statSync, readFileSync } from 'fs';
const mockRealpathSync = vi.mocked(realpathSync);
const mockStatSync = vi.mocked(statSync);
const mockReadFileSync = vi.mocked(readFileSync);
describe('validateAndReadFile boundary checks', () => {
    const baseDir = '/test/project';
    beforeEach(() => {
        vi.clearAllMocks();
        // Default: realpathSync returns the input path
        mockRealpathSync.mockImplementation((p) => String(p));
    });
    it('does not block same-path edge case (rel === "")', () => {
        // validateAndReadFile('.', baseDir) -> relative returns '' -> should NOT return [BLOCKED]
        // Instead it should fall through to isFile check
        mockStatSync.mockReturnValue({ isFile: () => false, size: 100 });
        const result = validateAndReadFile('.', baseDir);
        // Should get "Not a regular file" instead of [BLOCKED]
        expect(result).not.toContain('[BLOCKED]');
        expect(result).toContain('Not a regular file');
    });
    it('blocks outside path traversal', () => {
        const result = validateAndReadFile('../../etc/passwd', baseDir);
        expect(result).toContain('[BLOCKED]');
    });
    it('blocks cross-drive Windows paths (isAbsolute check)', () => {
        // Simulate Windows cross-drive: relative() returns an absolute path
        mockRealpathSync.mockImplementation((p) => {
            const s = String(p);
            if (s === baseDir)
                return baseDir;
            // Return a path on a different drive
            return 'D:\\other\\project\\file.ts';
        });
        // path.relative will return an absolute path for cross-drive
        const result = validateAndReadFile('D:\\other\\project\\file.ts', baseDir);
        expect(result).toContain('[BLOCKED]');
    });
    it('allows valid in-tree file', () => {
        const filePath = 'src/index.ts';
        const resolvedPath = path.resolve(baseDir, filePath);
        mockRealpathSync.mockImplementation((p) => String(p));
        mockStatSync.mockReturnValue({ isFile: () => true, size: 100 });
        mockReadFileSync.mockReturnValue('const x = 1;');
        const result = validateAndReadFile(filePath, baseDir);
        expect(result).toContain('const x = 1;');
        expect(result).not.toContain('[BLOCKED]');
    });
    it('blocks symlink escape (realpathSync resolves outside boundary)', () => {
        const filePath = 'src/link.ts';
        const resolvedPath = path.resolve(baseDir, filePath);
        mockRealpathSync.mockImplementation((p) => {
            const s = String(p);
            if (s === baseDir)
                return baseDir;
            if (s === resolvedPath)
                return '/outside/boundary/file.ts';
            return s;
        });
        const result = validateAndReadFile(filePath, baseDir);
        expect(result).toContain('[BLOCKED]');
    });
    // Verify gemini-core has the same behavior
    describe('gemini-core parity', () => {
        it('blocks outside path traversal (same as codex)', () => {
            const result = validateAndReadFileGemini('../../etc/passwd', baseDir);
            expect(result).toContain('[BLOCKED]');
        });
    });
});
//# sourceMappingURL=validate-and-read-file.test.js.map