import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, existsSync, rmSync, readFileSync } from 'fs';
import { join } from 'path';
import { createStdoutCollector, safeWriteOutputFile, TRUNCATION_MARKER, E_PATH_OUTSIDE_WORKDIR_OUTPUT } from '../shared-exec.js';
import { clearMcpConfigCache } from '../mcp-config.js';
describe('createStdoutCollector', () => {
    it('should accumulate chunks below the limit', () => {
        const collector = createStdoutCollector(100);
        collector.append('hello ');
        collector.append('world');
        expect(collector.toString()).toBe('hello world');
        expect(collector.isTruncated).toBe(false);
    });
    it('should not truncate at exact limit boundary', () => {
        const collector = createStdoutCollector(10);
        collector.append('0123456789'); // exactly 10 bytes
        expect(collector.toString()).toBe('0123456789');
        expect(collector.isTruncated).toBe(false);
    });
    it('should truncate at limit + 1', () => {
        const collector = createStdoutCollector(10);
        collector.append('0123456789X'); // 11 bytes
        expect(collector.toString()).toBe('0123456789' + TRUNCATION_MARKER);
        expect(collector.isTruncated).toBe(true);
    });
    it('should handle multi-chunk accumulation crossing the limit', () => {
        const collector = createStdoutCollector(10);
        collector.append('01234'); // 5 bytes
        collector.append('56789'); // 10 bytes total - at limit
        expect(collector.isTruncated).toBe(false);
        collector.append('X'); // 11 bytes
        expect(collector.isTruncated).toBe(true);
        expect(collector.toString()).toBe('0123456789' + TRUNCATION_MARKER);
    });
    it('should append truncation marker exactly once', () => {
        const collector = createStdoutCollector(5);
        collector.append('12345678'); // way over
        collector.append('more data'); // ignored
        collector.append('even more'); // ignored
        const output = collector.toString();
        const markerCount = output.split(TRUNCATION_MARKER).length - 1;
        expect(markerCount).toBe(1);
    });
    it('should ignore further appends after truncation', () => {
        const collector = createStdoutCollector(5);
        collector.append('abcdefgh'); // triggers truncation
        const afterFirst = collector.toString();
        collector.append('ignored');
        expect(collector.toString()).toBe(afterFirst);
    });
    it('should handle empty string appends', () => {
        const collector = createStdoutCollector(10);
        collector.append('');
        collector.append('hello');
        collector.append('');
        expect(collector.toString()).toBe('hello');
        expect(collector.isTruncated).toBe(false);
    });
    it('should handle a single large chunk exceeding limit', () => {
        const collector = createStdoutCollector(3);
        collector.append('abcdef');
        expect(collector.toString()).toBe('abc' + TRUNCATION_MARKER);
        expect(collector.isTruncated).toBe(true);
    });
});
describe('safeWriteOutputFile', () => {
    const TEST_DIR = join(process.cwd(), '.test-safe-write-' + process.pid);
    beforeEach(() => {
        if (existsSync(TEST_DIR)) {
            rmSync(TEST_DIR, { recursive: true, force: true });
        }
        mkdirSync(TEST_DIR, { recursive: true });
    });
    afterEach(() => {
        clearMcpConfigCache();
        if (existsSync(TEST_DIR)) {
            rmSync(TEST_DIR, { recursive: true, force: true });
        }
    });
    it('should write content to a file successfully', () => {
        const result = safeWriteOutputFile('output.txt', 'hello world', TEST_DIR);
        expect(result.success).toBe(true);
        if (result.success) {
            expect(result.actualPath).toBe(join(TEST_DIR, 'output.txt'));
        }
        const content = readFileSync(join(TEST_DIR, 'output.txt'), 'utf-8');
        expect(content).toBe('hello world');
    });
    it('should create intermediate directories', () => {
        const result = safeWriteOutputFile('sub/dir/output.txt', 'nested', TEST_DIR);
        expect(result.success).toBe(true);
        if (result.success) {
            expect(result.actualPath).toBe(join(TEST_DIR, 'sub', 'dir', 'output.txt'));
        }
        const content = readFileSync(join(TEST_DIR, 'sub', 'dir', 'output.txt'), 'utf-8');
        expect(content).toBe('nested');
    });
    it('should return error for paths outside the base directory in strict mode', () => {
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => { });
        // Set strict mode via environment variable
        const originalPolicy = process.env.OMC_MCP_OUTPUT_PATH_POLICY;
        process.env.OMC_MCP_OUTPUT_PATH_POLICY = 'strict';
        clearMcpConfigCache();
        const result = safeWriteOutputFile('../escape.txt', 'bad', TEST_DIR, '[mcp]');
        // Restore environment
        process.env.OMC_MCP_OUTPUT_PATH_POLICY = originalPolicy;
        // Should return error with E_PATH_OUTSIDE_WORKDIR_OUTPUT
        expect(result.success).toBe(false);
        if (!result.success) {
            expect(result.errorToken).toBe(E_PATH_OUTSIDE_WORKDIR_OUTPUT);
            expect(result.errorMessage).toContain('E_PATH_OUTSIDE_WORKDIR_OUTPUT');
            expect(result.errorMessage).toContain('../escape.txt');
            expect(result.errorMessage).toContain('working_directory');
            expect(result.errorMessage).toContain("set OMC_MCP_OUTPUT_PATH_POLICY=redirect_output");
        }
        expect(existsSync(join(TEST_DIR, '..', 'escape.txt'))).toBe(false);
        warnSpy.mockRestore();
    });
    it('should redirect output for paths outside the base directory in redirect_output mode', () => {
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => { });
        // Set redirect mode via environment variable
        const originalPolicy = process.env.OMC_MCP_OUTPUT_PATH_POLICY;
        process.env.OMC_MCP_OUTPUT_PATH_POLICY = 'redirect_output';
        clearMcpConfigCache();
        const result = safeWriteOutputFile('/tmp/escape.txt', 'redirected content', TEST_DIR, '[mcp]');
        // Restore environment
        process.env.OMC_MCP_OUTPUT_PATH_POLICY = originalPolicy;
        // Should redirect to .omc/outputs/
        expect(result.success).toBe(true);
        if (result.success) {
            expect(result.actualPath).toBe(join(TEST_DIR, '.omc', 'outputs', 'escape.txt'));
        }
        const content = readFileSync(join(TEST_DIR, '.omc', 'outputs', 'escape.txt'), 'utf-8');
        expect(content).toBe('redirected content');
        warnSpy.mockRestore();
    });
    it('should return error response on write failure', () => {
        // Use a path that will fail - directory as file
        mkdirSync(join(TEST_DIR, 'is-a-dir'), { recursive: true });
        // Try to write to a path where a directory exists with the same name
        // This creates a scenario where writeFileSync will fail
        const result = safeWriteOutputFile('is-a-dir', 'content', TEST_DIR);
        // Should return error with E_WRITE_FAILED
        expect(result.success).toBe(false);
        if (!result.success) {
            expect(result.errorToken).toBe('E_WRITE_FAILED');
            expect(result.errorMessage).toContain('Failed to write output file');
        }
    });
});
//# sourceMappingURL=shared-exec.test.js.map