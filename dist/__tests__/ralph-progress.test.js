import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { readProgress, readProgressRaw, parseProgress, initProgress, appendProgress, addPattern, getPatterns, getRecentLearnings, formatPatternsForContext, formatProgressForContext, getProgressContext, PROGRESS_FILENAME, PATTERNS_HEADER, ENTRY_SEPARATOR } from '../hooks/ralph/index.js';
describe('Ralph Progress Module', () => {
    let testDir;
    beforeEach(() => {
        // Create a unique temp directory for each test
        testDir = join(tmpdir(), `ralph-progress-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
        mkdirSync(testDir, { recursive: true });
    });
    afterEach(() => {
        // Clean up test directory
        if (existsSync(testDir)) {
            rmSync(testDir, { recursive: true, force: true });
        }
    });
    describe('initProgress', () => {
        it('should create progress.txt in .omc directory', () => {
            expect(initProgress(testDir)).toBe(true);
            expect(existsSync(join(testDir, '.omc', PROGRESS_FILENAME))).toBe(true);
        });
        it('should include started timestamp', () => {
            initProgress(testDir);
            const content = readProgressRaw(testDir);
            expect(content).toContain('Started:');
        });
        it('should include patterns header', () => {
            initProgress(testDir);
            const content = readProgressRaw(testDir);
            expect(content).toContain(PATTERNS_HEADER);
        });
        it('should include entry separator', () => {
            initProgress(testDir);
            const content = readProgressRaw(testDir);
            expect(content).toContain(ENTRY_SEPARATOR);
        });
    });
    describe('readProgressRaw / readProgress', () => {
        it('should return null when no progress file exists', () => {
            expect(readProgressRaw(testDir)).toBeNull();
            expect(readProgress(testDir)).toBeNull();
        });
        it('should read progress from root directory', () => {
            writeFileSync(join(testDir, PROGRESS_FILENAME), '# Test');
            expect(readProgressRaw(testDir)).toBe('# Test');
        });
        it('should read progress from .omc directory', () => {
            const omcDir = join(testDir, '.omc');
            mkdirSync(omcDir, { recursive: true });
            writeFileSync(join(omcDir, PROGRESS_FILENAME), '# Test');
            expect(readProgressRaw(testDir)).toBe('# Test');
        });
    });
    describe('parseProgress', () => {
        it('should parse patterns from progress file', () => {
            const content = `# Progress Log
Started: 2025-01-01

${PATTERNS_HEADER}
- Pattern one
- Pattern two

${ENTRY_SEPARATOR}
`;
            const parsed = parseProgress(content);
            expect(parsed.patterns.length).toBe(2);
            expect(parsed.patterns[0].pattern).toBe('Pattern one');
            expect(parsed.patterns[1].pattern).toBe('Pattern two');
        });
        it('should parse started timestamp', () => {
            const content = `# Progress Log
Started: 2025-01-01T10:00:00Z

${PATTERNS_HEADER}
${ENTRY_SEPARATOR}
`;
            const parsed = parseProgress(content);
            expect(parsed.startedAt).toBe('2025-01-01T10:00:00Z');
        });
        it('should parse entries', () => {
            const content = `# Progress Log
Started: 2025-01-01

${PATTERNS_HEADER}
${ENTRY_SEPARATOR}

## [2025-01-01 10:00] - US-001
- Implemented feature A
- Fixed bug B
- **Learnings:**
  - Use pattern X for Y

${ENTRY_SEPARATOR}
`;
            const parsed = parseProgress(content);
            expect(parsed.entries.length).toBe(1);
            expect(parsed.entries[0].storyId).toBe('US-001');
            expect(parsed.entries[0].implementation).toContain('Implemented feature A');
            expect(parsed.entries[0].learnings).toContain('Use pattern X for Y');
        });
        it('should handle multiple entries', () => {
            const content = `# Progress Log
Started: 2025-01-01

${PATTERNS_HEADER}
${ENTRY_SEPARATOR}

## [2025-01-01 10:00] - US-001
- First implementation

${ENTRY_SEPARATOR}

## [2025-01-01 11:00] - US-002
- Second implementation

${ENTRY_SEPARATOR}
`;
            const parsed = parseProgress(content);
            expect(parsed.entries.length).toBe(2);
            expect(parsed.entries[0].storyId).toBe('US-001');
            expect(parsed.entries[1].storyId).toBe('US-002');
        });
        it('should handle empty content', () => {
            const parsed = parseProgress('');
            expect(parsed.patterns).toEqual([]);
            expect(parsed.entries).toEqual([]);
            expect(parsed.startedAt).toBe('');
        });
        it('should handle malformed content gracefully', () => {
            const content = `Random text
No structure here
Just garbage`;
            const parsed = parseProgress(content);
            expect(parsed.patterns).toEqual([]);
            expect(parsed.entries).toEqual([]);
        });
    });
    describe('appendProgress', () => {
        beforeEach(() => {
            initProgress(testDir);
        });
        it('should append progress entry', () => {
            const result = appendProgress(testDir, {
                storyId: 'US-001',
                implementation: ['Did thing A', 'Did thing B'],
                filesChanged: ['file1.ts', 'file2.ts'],
                learnings: ['Learned pattern X']
            });
            expect(result).toBe(true);
            const content = readProgressRaw(testDir);
            expect(content).toContain('US-001');
            expect(content).toContain('Did thing A');
            expect(content).toContain('file1.ts');
            expect(content).toContain('Learned pattern X');
        });
        it('should create progress file if not exists', () => {
            rmSync(join(testDir, '.omc'), { recursive: true, force: true });
            const result = appendProgress(testDir, {
                storyId: 'US-001',
                implementation: ['Test'],
                filesChanged: [],
                learnings: []
            });
            expect(result).toBe(true);
            expect(existsSync(join(testDir, '.omc', PROGRESS_FILENAME))).toBe(true);
        });
        it('should include timestamp', () => {
            appendProgress(testDir, {
                storyId: 'US-001',
                implementation: ['Test'],
                filesChanged: [],
                learnings: []
            });
            const content = readProgressRaw(testDir);
            // Should have a date pattern like [2025-01-18 12:00]
            expect(content).toMatch(/\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}\]/);
        });
    });
    describe('addPattern', () => {
        beforeEach(() => {
            initProgress(testDir);
        });
        it('should add pattern to progress file', () => {
            const result = addPattern(testDir, 'Use X for Y');
            expect(result).toBe(true);
            const patterns = getPatterns(testDir);
            expect(patterns).toContain('Use X for Y');
        });
        it('should remove placeholder when adding first pattern', () => {
            const result = addPattern(testDir, 'First pattern');
            expect(result).toBe(true);
            const content = readProgressRaw(testDir);
            expect(content).not.toContain('No patterns discovered yet');
        });
        it('should handle multiple patterns', () => {
            addPattern(testDir, 'Pattern 1');
            addPattern(testDir, 'Pattern 2');
            addPattern(testDir, 'Pattern 3');
            const patterns = getPatterns(testDir);
            expect(patterns.length).toBe(3);
        });
        it('should create progress file if not exists', () => {
            rmSync(join(testDir, '.omc'), { recursive: true, force: true });
            const result = addPattern(testDir, 'New pattern');
            expect(result).toBe(true);
            expect(existsSync(join(testDir, '.omc', PROGRESS_FILENAME))).toBe(true);
        });
        it('should recover when directory is deleted', () => {
            // Remove directory completely - the function should recover
            rmSync(testDir, { recursive: true, force: true });
            // With recursive: true in mkdirSync, it should recreate and succeed
            const result = addPattern(testDir, 'Pattern');
            expect(result).toBe(true);
            // Verify the pattern was actually added
            const patterns = getPatterns(testDir);
            expect(patterns).toContain('Pattern');
        });
    });
    describe('getPatterns / getRecentLearnings', () => {
        beforeEach(() => {
            initProgress(testDir);
            addPattern(testDir, 'Pattern A');
            addPattern(testDir, 'Pattern B');
            appendProgress(testDir, {
                storyId: 'US-001',
                implementation: ['Test'],
                filesChanged: [],
                learnings: ['Learning 1', 'Learning 2']
            });
            appendProgress(testDir, {
                storyId: 'US-002',
                implementation: ['Test'],
                filesChanged: [],
                learnings: ['Learning 3']
            });
        });
        it('should get all patterns', () => {
            const patterns = getPatterns(testDir);
            expect(patterns).toContain('Pattern A');
            expect(patterns).toContain('Pattern B');
        });
        it('should get recent learnings', () => {
            const learnings = getRecentLearnings(testDir, 5);
            expect(learnings).toContain('Learning 1');
            expect(learnings).toContain('Learning 2');
            expect(learnings).toContain('Learning 3');
        });
        it('should limit learnings', () => {
            const learnings = getRecentLearnings(testDir, 1);
            // Should only get learnings from the last entry
            expect(learnings).toContain('Learning 3');
            expect(learnings).not.toContain('Learning 1');
        });
    });
    describe('formatPatternsForContext / formatProgressForContext', () => {
        beforeEach(() => {
            initProgress(testDir);
            addPattern(testDir, 'Use X for Y');
            appendProgress(testDir, {
                storyId: 'US-001',
                implementation: ['Did something'],
                filesChanged: [],
                learnings: ['Important learning']
            });
        });
        it('should format patterns with tags', () => {
            const formatted = formatPatternsForContext(testDir);
            expect(formatted).toContain('<codebase-patterns>');
            expect(formatted).toContain('</codebase-patterns>');
            expect(formatted).toContain('Use X for Y');
        });
        it('should return empty string when no patterns', () => {
            rmSync(join(testDir, '.omc'), { recursive: true, force: true });
            const formatted = formatPatternsForContext(testDir);
            expect(formatted).toBe('');
        });
        it('should format progress with tags', () => {
            const formatted = formatProgressForContext(testDir, 5);
            expect(formatted).toContain('<recent-progress>');
            expect(formatted).toContain('</recent-progress>');
            expect(formatted).toContain('US-001');
        });
        it('should return empty string when no progress', () => {
            rmSync(join(testDir, '.omc'), { recursive: true, force: true });
            const formatted = formatProgressForContext(testDir);
            expect(formatted).toBe('');
        });
    });
    describe('getProgressContext', () => {
        it('should return combined context', () => {
            initProgress(testDir);
            addPattern(testDir, 'Pattern');
            appendProgress(testDir, {
                storyId: 'US-001',
                implementation: ['Test'],
                filesChanged: [],
                learnings: ['Learning']
            });
            const context = getProgressContext(testDir);
            expect(context).toContain('<codebase-patterns>');
            expect(context).toContain('<learnings>');
            expect(context).toContain('<recent-progress>');
        });
        it('should return empty string when no progress', () => {
            const context = getProgressContext(testDir);
            expect(context).toBe('');
        });
    });
});
//# sourceMappingURL=ralph-progress.test.js.map