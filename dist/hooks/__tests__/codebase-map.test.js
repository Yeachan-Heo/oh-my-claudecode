/**
 * Codebase Map Generator Tests
 *
 * Issue #804 - Startup codebase map injection hook
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { generateCodebaseMap, buildTree, renderTree, shouldSkipEntry, extractPackageMetadata, } from '../codebase-map.js';
import { buildAgentsOverlay } from '../agents-overlay.js';
// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function createTempDir() {
    return mkdtempSync(join(tmpdir(), 'codebase-map-test-'));
}
function writeFile(dir, relPath, content = '') {
    const full = join(dir, relPath);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, content, 'utf-8');
}
// ---------------------------------------------------------------------------
// shouldSkipEntry
// ---------------------------------------------------------------------------
describe('shouldSkipEntry', () => {
    it('skips node_modules directory', () => {
        expect(shouldSkipEntry('node_modules', true, [])).toBe(true);
    });
    it('skips .git directory', () => {
        expect(shouldSkipEntry('.git', true, [])).toBe(true);
    });
    it('skips dist directory', () => {
        expect(shouldSkipEntry('dist', true, [])).toBe(true);
    });
    it('skips hidden directories', () => {
        expect(shouldSkipEntry('.cache', true, [])).toBe(true);
    });
    it('does not skip hidden directory if important (CLAUDE.md is a file, so N/A)', () => {
        // .omc is in SKIP_DIRS, so it is skipped
        expect(shouldSkipEntry('.omc', true, [])).toBe(true);
    });
    it('does not skip src directory', () => {
        expect(shouldSkipEntry('src', true, [])).toBe(false);
    });
    it('includes .ts files', () => {
        expect(shouldSkipEntry('index.ts', false, [])).toBe(false);
    });
    it('includes .json files', () => {
        expect(shouldSkipEntry('package.json', false, [])).toBe(false);
    });
    it('includes .md files', () => {
        expect(shouldSkipEntry('README.md', false, [])).toBe(false);
    });
    it('skips binary/media files (.png)', () => {
        expect(shouldSkipEntry('logo.png', false, [])).toBe(true);
    });
    it('skips lock files (package-lock.json, yarn.lock)', () => {
        expect(shouldSkipEntry('package-lock.json', false, [])).toBe(true);
        expect(shouldSkipEntry('yarn.lock', false, [])).toBe(true);
    });
    it('skips entries matching custom ignorePatterns', () => {
        expect(shouldSkipEntry('generated-code.ts', false, ['generated'])).toBe(true);
    });
    it('does not skip entries that do not match custom ignorePatterns', () => {
        expect(shouldSkipEntry('index.ts', false, ['generated'])).toBe(false);
    });
});
// ---------------------------------------------------------------------------
// extractPackageMetadata
// ---------------------------------------------------------------------------
describe('extractPackageMetadata', () => {
    let tempDir;
    beforeEach(() => {
        tempDir = createTempDir();
    });
    afterEach(() => {
        rmSync(tempDir, { recursive: true, force: true });
    });
    it('returns empty string when package.json is absent', () => {
        expect(extractPackageMetadata(tempDir)).toBe('');
    });
    it('returns package name and description', () => {
        writeFile(tempDir, 'package.json', JSON.stringify({
            name: 'my-package',
            description: 'A test package',
        }));
        const meta = extractPackageMetadata(tempDir);
        expect(meta).toContain('Package: my-package');
        expect(meta).toContain('Description: A test package');
    });
    it('lists scripts (up to 8)', () => {
        writeFile(tempDir, 'package.json', JSON.stringify({
            name: 'my-package',
            scripts: { build: 'tsc', test: 'vitest', lint: 'eslint .' },
        }));
        const meta = extractPackageMetadata(tempDir);
        expect(meta).toContain('Scripts:');
        expect(meta).toContain('build');
        expect(meta).toContain('test');
    });
    it('handles malformed package.json gracefully', () => {
        writeFile(tempDir, 'package.json', '{invalid json}');
        expect(extractPackageMetadata(tempDir)).toBe('');
    });
});
// ---------------------------------------------------------------------------
// buildTree / renderTree
// ---------------------------------------------------------------------------
describe('buildTree and renderTree', () => {
    let tempDir;
    beforeEach(() => {
        tempDir = createTempDir();
    });
    afterEach(() => {
        rmSync(tempDir, { recursive: true, force: true });
    });
    it('includes TypeScript source files', () => {
        writeFile(tempDir, 'src/index.ts', '');
        const fileCount = { value: 0 };
        const tree = buildTree(tempDir, 0, 4, fileCount, 200, []);
        const lines = [];
        renderTree(tree, '', lines);
        const output = lines.join('\n');
        expect(output).toContain('index.ts');
        expect(fileCount.value).toBe(1);
    });
    it('excludes node_modules', () => {
        writeFile(tempDir, 'node_modules/foo/index.js', '');
        writeFile(tempDir, 'src/app.ts', '');
        const fileCount = { value: 0 };
        const tree = buildTree(tempDir, 0, 4, fileCount, 200, []);
        const lines = [];
        renderTree(tree, '', lines);
        const output = lines.join('\n');
        expect(output).not.toContain('node_modules');
        expect(output).toContain('app.ts');
    });
    it('respects maxDepth', () => {
        writeFile(tempDir, 'a/b/c/d/e/deep.ts', '');
        const fileCount = { value: 0 };
        // maxDepth=2 means we enter a/b/c but stop before d
        const tree = buildTree(tempDir, 0, 2, fileCount, 200, []);
        const lines = [];
        renderTree(tree, '', lines);
        const output = lines.join('\n');
        expect(output).not.toContain('deep.ts');
    });
    it('respects maxFiles limit', () => {
        for (let i = 0; i < 10; i++) {
            writeFile(tempDir, `file${i}.ts`, '');
        }
        const fileCount = { value: 0 };
        buildTree(tempDir, 0, 4, fileCount, 5, []);
        expect(fileCount.value).toBeLessThanOrEqual(5);
    });
    it('renders tree with ASCII connectors', () => {
        writeFile(tempDir, 'a.ts', '');
        writeFile(tempDir, 'b.ts', '');
        const fileCount = { value: 0 };
        const tree = buildTree(tempDir, 0, 4, fileCount, 200, []);
        const lines = [];
        renderTree(tree, '', lines);
        const output = lines.join('\n');
        // At least one connector character should appear
        expect(output).toMatch(/[├└]/);
    });
    it('lists directories before files', () => {
        writeFile(tempDir, 'zzz.ts', '');
        writeFile(tempDir, 'src/index.ts', '');
        const fileCount = { value: 0 };
        const tree = buildTree(tempDir, 0, 4, fileCount, 200, []);
        const lines = [];
        renderTree(tree, '', lines);
        const srcIdx = lines.findIndex((l) => l.includes('src/'));
        const zzzIdx = lines.findIndex((l) => l.includes('zzz.ts'));
        expect(srcIdx).toBeLessThan(zzzIdx);
    });
});
// ---------------------------------------------------------------------------
// generateCodebaseMap
// ---------------------------------------------------------------------------
describe('generateCodebaseMap', () => {
    let tempDir;
    beforeEach(() => {
        tempDir = createTempDir();
    });
    afterEach(() => {
        rmSync(tempDir, { recursive: true, force: true });
    });
    it('returns empty result for non-existent directory', () => {
        const result = generateCodebaseMap('/nonexistent-path-xyz');
        expect(result.map).toBe('');
        expect(result.totalFiles).toBe(0);
        expect(result.truncated).toBe(false);
    });
    it('includes package metadata when present', () => {
        writeFile(tempDir, 'package.json', JSON.stringify({ name: 'test-pkg' }));
        writeFile(tempDir, 'src/index.ts', '');
        const result = generateCodebaseMap(tempDir);
        expect(result.map).toContain('Package: test-pkg');
    });
    it('includes source files in the map', () => {
        writeFile(tempDir, 'src/app.ts', '');
        writeFile(tempDir, 'src/utils.ts', '');
        const result = generateCodebaseMap(tempDir);
        expect(result.map).toContain('app.ts');
        expect(result.map).toContain('utils.ts');
        expect(result.totalFiles).toBe(2);
    });
    it('sets truncated=true when maxFiles exceeded', () => {
        for (let i = 0; i < 20; i++) {
            writeFile(tempDir, `file${i}.ts`, '');
        }
        const result = generateCodebaseMap(tempDir, { maxFiles: 5 });
        expect(result.truncated).toBe(true);
        expect(result.totalFiles).toBeLessThanOrEqual(5);
        expect(result.map).toContain('[Map truncated');
    });
    it('sets truncated=false when under limit', () => {
        writeFile(tempDir, 'index.ts', '');
        const result = generateCodebaseMap(tempDir, { maxFiles: 200 });
        expect(result.truncated).toBe(false);
        expect(result.map).not.toContain('[Map truncated');
    });
    it('omits metadata when includeMetadata=false', () => {
        writeFile(tempDir, 'package.json', JSON.stringify({ name: 'my-pkg' }));
        writeFile(tempDir, 'index.ts', '');
        const result = generateCodebaseMap(tempDir, { includeMetadata: false });
        expect(result.map).not.toContain('Package:');
    });
    it('respects custom ignorePatterns', () => {
        writeFile(tempDir, 'generated-api.ts', '');
        writeFile(tempDir, 'index.ts', '');
        const result = generateCodebaseMap(tempDir, { ignorePatterns: ['generated'] });
        expect(result.map).not.toContain('generated-api.ts');
        expect(result.map).toContain('index.ts');
    });
});
// ---------------------------------------------------------------------------
// buildAgentsOverlay
// ---------------------------------------------------------------------------
describe('buildAgentsOverlay', () => {
    let tempDir;
    beforeEach(() => {
        tempDir = createTempDir();
    });
    afterEach(() => {
        rmSync(tempDir, { recursive: true, force: true });
    });
    it('returns a non-empty message when source files exist', () => {
        writeFile(tempDir, 'src/index.ts', '');
        const result = buildAgentsOverlay(tempDir);
        expect(result.hasCodebaseMap).toBe(true);
        expect(result.message).toContain('[CODEBASE MAP]');
        expect(result.message).toContain('index.ts');
    });
    it('wraps output in session-restore tags', () => {
        writeFile(tempDir, 'index.ts', '');
        const result = buildAgentsOverlay(tempDir);
        expect(result.message).toContain('<session-restore>');
        expect(result.message).toContain('</session-restore>');
    });
    it('returns empty message for empty/nonexistent directory', () => {
        const result = buildAgentsOverlay('/nonexistent-xyz-abc');
        expect(result.hasCodebaseMap).toBe(false);
        expect(result.message).toBe('');
    });
    it('includes truncation note exactly once when map is truncated (closes #844)', () => {
        // Create 201 files to exceed the default maxFiles limit of 200
        for (let i = 0; i < 201; i++) {
            writeFile(tempDir, `file${i}.ts`, '');
        }
        const result = buildAgentsOverlay(tempDir);
        expect(result.hasCodebaseMap).toBe(true);
        const matches = result.message.match(/\[Map truncated/g);
        expect(matches).not.toBeNull();
        expect(matches.length).toBe(1);
    });
});
//# sourceMappingURL=codebase-map.test.js.map