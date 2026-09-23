import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { getOmcRoot } from '../lib/worktree-paths.js';
import { initNotepad, readNotepad, getPriorityContext, getWorkingMemory, addWorkingMemoryEntry, setPriorityContext, addManualEntry, pruneOldEntries, getNotepadStats, formatNotepadContext, DEFAULT_CONFIG, PRIORITY_HEADER, WORKING_MEMORY_HEADER, MANUAL_HEADER, getManualSection, getNotepadPath } from '../hooks/notepad/index.js';
describe('Notepad Module', () => {
    let testDir;
    let previousHome;
    let previousUserProfile;
    let previousStateDir;
    beforeEach(() => {
        previousHome = process.env.HOME;
        previousUserProfile = process.env.USERPROFILE;
        previousStateDir = process.env.OMC_STATE_DIR;
        testDir = mkdtempSync(join(tmpdir(), 'notepad-test-'));
        process.env.HOME = testDir;
        process.env.USERPROFILE = testDir;
        process.env.OMC_STATE_DIR = join(testDir, 'centralized-state');
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
        if (existsSync(testDir)) {
            rmSync(testDir, { recursive: true, force: true });
        }
    });
    describe('initNotepad', () => {
        it('should create notepad.md with correct structure', () => {
            const result = initNotepad(testDir);
            expect(result).toBe(true);
            const notepadPath = getNotepadPath(testDir);
            expect(existsSync(notepadPath)).toBe(true);
            const content = readFileSync(notepadPath, 'utf-8');
            expect(content).toContain('# Notepad');
            expect(content).toContain(PRIORITY_HEADER);
            expect(content).toContain(WORKING_MEMORY_HEADER);
            expect(content).toContain(MANUAL_HEADER);
            expect(content).toContain('Auto-managed by OMC');
        });
        it('should create .omc directory if not exists', () => {
            const omcDir = getOmcRoot(testDir);
            expect(existsSync(omcDir)).toBe(false);
            initNotepad(testDir);
            expect(existsSync(omcDir)).toBe(true);
        });
        it('should not overwrite existing notepad', () => {
            const omcDir = getOmcRoot(testDir);
            mkdirSync(omcDir, { recursive: true });
            const notepadPath = getNotepadPath(testDir);
            const existingContent = '# Existing content\nTest data';
            writeFileSync(notepadPath, existingContent);
            const result = initNotepad(testDir);
            expect(result).toBe(true);
            const content = readFileSync(notepadPath, 'utf-8');
            expect(content).toBe(existingContent);
        });
    });
    describe('readNotepad', () => {
        it('should return null if notepad does not exist', () => {
            const result = readNotepad(testDir);
            expect(result).toBeNull();
        });
        it('should return content if notepad exists', () => {
            initNotepad(testDir);
            const result = readNotepad(testDir);
            expect(result).not.toBeNull();
            expect(result).toContain('# Notepad');
            expect(result).toContain(PRIORITY_HEADER);
        });
    });
    describe('getPriorityContext', () => {
        it('should return null if no notepad', () => {
            const result = getPriorityContext(testDir);
            expect(result).toBeNull();
        });
        it('should extract Priority Context section', () => {
            initNotepad(testDir);
            setPriorityContext(testDir, 'Critical info about the project');
            const result = getPriorityContext(testDir);
            expect(result).toBe('Critical info about the project');
        });
        it('should return null if section is empty/comments only', () => {
            initNotepad(testDir);
            const result = getPriorityContext(testDir);
            expect(result).toBeNull();
        });
        it('should return consistent priority context across repeated reads', () => {
            initNotepad(testDir);
            setPriorityContext(testDir, 'Repeated content');
            expect(getPriorityContext(testDir)).toBe('Repeated content');
            expect(getPriorityContext(testDir)).toBe('Repeated content');
            expect(getPriorityContext(testDir)).toBe('Repeated content');
        });
        it('should exclude HTML comments from content', () => {
            initNotepad(testDir);
            const notepadPath = getNotepadPath(testDir);
            let content = readFileSync(notepadPath, 'utf-8');
            // Manually add content with comment
            content = content.replace(`${PRIORITY_HEADER}\n<!-- ALWAYS loaded. Keep under 500 chars. Critical discoveries only. -->`, `${PRIORITY_HEADER}\n<!-- ALWAYS loaded. Keep under 500 chars. Critical discoveries only. -->\nActual content`);
            writeFileSync(notepadPath, content);
            const result = getPriorityContext(testDir);
            expect(result).toBe('Actual content');
            expect(result).not.toContain('<!--');
        });
    });
    describe('setPriorityContext', () => {
        it('should set priority context', () => {
            const result = setPriorityContext(testDir, 'Important discovery');
            expect(result.success).toBe(true);
            expect(result.warning).toBeUndefined();
            const context = getPriorityContext(testDir);
            expect(context).toBe('Important discovery');
        });
        it('should warn if over 500 chars', () => {
            const longContent = 'a'.repeat(501);
            const result = setPriorityContext(testDir, longContent);
            expect(result.success).toBe(true);
            expect(result.warning).toBeDefined();
            expect(result.warning).toContain('exceeds');
            expect(result.warning).toContain('500 chars');
            expect(result.warning).toContain('501 chars');
        });
        it('should initialize notepad if not exists', () => {
            const notepadPath = getNotepadPath(testDir);
            expect(existsSync(notepadPath)).toBe(false);
            setPriorityContext(testDir, 'Test content');
            expect(existsSync(notepadPath)).toBe(true);
        });
        it('should replace existing priority context', () => {
            setPriorityContext(testDir, 'First content');
            setPriorityContext(testDir, 'Second content');
            const context = getPriorityContext(testDir);
            expect(context).toBe('Second content');
            expect(context).not.toContain('First content');
        });
        it('should preserve section boundaries across repeated updates to known headers', () => {
            setPriorityContext(testDir, 'Priority content');
            addWorkingMemoryEntry(testDir, 'Working note');
            addManualEntry(testDir, 'Manual note');
            setPriorityContext(testDir, 'Updated priority');
            addWorkingMemoryEntry(testDir, 'Second working note');
            addManualEntry(testDir, 'Second manual note');
            expect(getPriorityContext(testDir)).toBe('Updated priority');
            expect(getWorkingMemory(testDir)).toContain('Working note');
            expect(getWorkingMemory(testDir)).toContain('Second working note');
            expect(getManualSection(testDir)).toContain('Manual note');
            expect(getManualSection(testDir)).toContain('Second manual note');
        });
        it('should use custom config for max chars', () => {
            const customConfig = { ...DEFAULT_CONFIG, priorityMaxChars: 100 };
            const longContent = 'a'.repeat(101);
            const result = setPriorityContext(testDir, longContent, customConfig);
            expect(result.success).toBe(true);
            expect(result.warning).toBeDefined();
            expect(result.warning).toContain('100 chars');
        });
    });
    describe('addWorkingMemoryEntry', () => {
        it('should add timestamped entry', () => {
            const result = addWorkingMemoryEntry(testDir, 'First note');
            expect(result).toBe(true);
            const memory = getWorkingMemory(testDir);
            expect(memory).not.toBeNull();
            expect(memory).toContain('First note');
            expect(memory).toMatch(/### \d{4}-\d{2}-\d{2} \d{2}:\d{2}/);
        });
        it('should initialize notepad if not exists', () => {
            const notepadPath = getNotepadPath(testDir);
            expect(existsSync(notepadPath)).toBe(false);
            addWorkingMemoryEntry(testDir, 'Test entry');
            expect(existsSync(notepadPath)).toBe(true);
        });
        it('should append to existing entries', () => {
            addWorkingMemoryEntry(testDir, 'First entry');
            addWorkingMemoryEntry(testDir, 'Second entry');
            addWorkingMemoryEntry(testDir, 'Third entry');
            const memory = getWorkingMemory(testDir);
            expect(memory).toContain('First entry');
            expect(memory).toContain('Second entry');
            expect(memory).toContain('Third entry');
            // Count timestamps
            const matches = memory?.match(/### \d{4}-\d{2}-\d{2} \d{2}:\d{2}/g);
            expect(matches?.length).toBe(3);
        });
    });
    describe('addManualEntry', () => {
        it('should add to MANUAL section', () => {
            const result = addManualEntry(testDir, 'User note');
            expect(result).toBe(true);
            const manual = getManualSection(testDir);
            expect(manual).not.toBeNull();
            expect(manual).toContain('User note');
            expect(manual).toMatch(/### \d{4}-\d{2}-\d{2} \d{2}:\d{2}/);
        });
        it('should initialize notepad if not exists', () => {
            const notepadPath = getNotepadPath(testDir);
            expect(existsSync(notepadPath)).toBe(false);
            addManualEntry(testDir, 'Test manual entry');
            expect(existsSync(notepadPath)).toBe(true);
        });
        it('should append multiple manual entries', () => {
            addManualEntry(testDir, 'Manual entry 1');
            addManualEntry(testDir, 'Manual entry 2');
            const manual = getManualSection(testDir);
            expect(manual).toContain('Manual entry 1');
            expect(manual).toContain('Manual entry 2');
        });
    });
    describe('pruneOldEntries', () => {
        it('should remove entries older than N days', () => {
            initNotepad(testDir);
            const notepadPath = getNotepadPath(testDir);
            // Manually create old and new entries
            const oldDate = new Date();
            oldDate.setDate(oldDate.getDate() - 10);
            const oldTimestamp = oldDate.toISOString().slice(0, 16).replace('T', ' ');
            const recentDate = new Date();
            const recentTimestamp = recentDate.toISOString().slice(0, 16).replace('T', ' ');
            let content = readFileSync(notepadPath, 'utf-8');
            const workingMemoryContent = `### ${oldTimestamp}\nOld entry\n\n### ${recentTimestamp}\nRecent entry`;
            content = content.replace(`${WORKING_MEMORY_HEADER}\n<!-- Session notes. Auto-pruned after 7 days. -->`, `${WORKING_MEMORY_HEADER}\n<!-- Session notes. Auto-pruned after 7 days. -->\n${workingMemoryContent}`);
            writeFileSync(notepadPath, content);
            // Prune entries older than 7 days
            const result = pruneOldEntries(testDir, 7);
            expect(result.pruned).toBe(1);
            expect(result.remaining).toBe(1);
            const memory = getWorkingMemory(testDir);
            expect(memory).not.toContain('Old entry');
            expect(memory).toContain('Recent entry');
        });
        it('should keep recent entries', () => {
            addWorkingMemoryEntry(testDir, 'Recent entry 1');
            addWorkingMemoryEntry(testDir, 'Recent entry 2');
            const result = pruneOldEntries(testDir, 7);
            expect(result.pruned).toBe(0);
            expect(result.remaining).toBe(2);
            const memory = getWorkingMemory(testDir);
            expect(memory).toContain('Recent entry 1');
            expect(memory).toContain('Recent entry 2');
        });
        it('should not affect Priority Context or MANUAL', () => {
            setPriorityContext(testDir, 'Important info');
            addManualEntry(testDir, 'User note');
            initNotepad(testDir);
            const notepadPath = getNotepadPath(testDir);
            // Add old working memory entry
            const oldDate = new Date();
            oldDate.setDate(oldDate.getDate() - 10);
            const oldTimestamp = oldDate.toISOString().slice(0, 16).replace('T', ' ');
            let content = readFileSync(notepadPath, 'utf-8');
            content = content.replace(`${WORKING_MEMORY_HEADER}\n<!-- Session notes. Auto-pruned after 7 days. -->`, `${WORKING_MEMORY_HEADER}\n<!-- Session notes. Auto-pruned after 7 days. -->\n### ${oldTimestamp}\nOld working memory`);
            writeFileSync(notepadPath, content);
            pruneOldEntries(testDir, 7);
            // Priority Context and MANUAL should be unchanged
            const priority = getPriorityContext(testDir);
            const manual = getManualSection(testDir);
            expect(priority).toBe('Important info');
            expect(manual).toContain('User note');
        });
        it('should return zeros if no notepad exists', () => {
            const result = pruneOldEntries(testDir, 7);
            expect(result.pruned).toBe(0);
            expect(result.remaining).toBe(0);
        });
    });
    describe('getNotepadStats', () => {
        it('should return exists: false when no notepad', () => {
            const stats = getNotepadStats(testDir);
            expect(stats.exists).toBe(false);
            expect(stats.totalSize).toBe(0);
            expect(stats.prioritySize).toBe(0);
            expect(stats.workingMemoryEntries).toBe(0);
            expect(stats.oldestEntry).toBeNull();
        });
        it('should return correct stats', () => {
            setPriorityContext(testDir, 'Priority content');
            addWorkingMemoryEntry(testDir, 'Entry 1');
            addWorkingMemoryEntry(testDir, 'Entry 2');
            addManualEntry(testDir, 'Manual note');
            const stats = getNotepadStats(testDir);
            expect(stats.exists).toBe(true);
            expect(stats.totalSize).toBeGreaterThan(0);
            expect(stats.prioritySize).toBeGreaterThan(0);
            expect(stats.workingMemoryEntries).toBe(2);
            expect(stats.oldestEntry).not.toBeNull();
            expect(stats.oldestEntry).toMatch(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}/);
        });
        it('should correctly count multiple working memory entries', () => {
            addWorkingMemoryEntry(testDir, 'Entry 1');
            addWorkingMemoryEntry(testDir, 'Entry 2');
            addWorkingMemoryEntry(testDir, 'Entry 3');
            addWorkingMemoryEntry(testDir, 'Entry 4');
            const stats = getNotepadStats(testDir);
            expect(stats.workingMemoryEntries).toBe(4);
        });
        it('should identify oldest entry correctly', () => {
            initNotepad(testDir);
            const notepadPath = getNotepadPath(testDir);
            // Create entries with specific timestamps
            const date1 = new Date('2025-01-01T10:00:00Z');
            const date2 = new Date('2025-01-02T10:00:00Z');
            const date3 = new Date('2025-01-03T10:00:00Z');
            const timestamp1 = date1.toISOString().slice(0, 16).replace('T', ' ');
            const timestamp2 = date2.toISOString().slice(0, 16).replace('T', ' ');
            const timestamp3 = date3.toISOString().slice(0, 16).replace('T', ' ');
            let content = readFileSync(notepadPath, 'utf-8');
            const workingMemoryContent = `### ${timestamp2}\nMiddle\n\n### ${timestamp1}\nOldest\n\n### ${timestamp3}\nNewest`;
            content = content.replace(`${WORKING_MEMORY_HEADER}\n<!-- Session notes. Auto-pruned after 7 days. -->`, `${WORKING_MEMORY_HEADER}\n<!-- Session notes. Auto-pruned after 7 days. -->\n${workingMemoryContent}`);
            writeFileSync(notepadPath, content);
            const stats = getNotepadStats(testDir);
            expect(stats.oldestEntry).toBe(timestamp1);
        });
    });
    describe('formatNotepadContext', () => {
        it('should return null if no priority context', () => {
            initNotepad(testDir);
            const result = formatNotepadContext(testDir);
            expect(result).toBeNull();
        });
        it('should format context for injection', () => {
            setPriorityContext(testDir, 'Critical information');
            const result = formatNotepadContext(testDir);
            expect(result).not.toBeNull();
            expect(result).toContain('<notepad-priority>');
            expect(result).toContain('</notepad-priority>');
            expect(result).toContain('## Priority Context');
            expect(result).toContain('Critical information');
        });
        it('should return null if notepad does not exist', () => {
            const result = formatNotepadContext(testDir);
            expect(result).toBeNull();
        });
    });
    describe('getWorkingMemory', () => {
        it('should return null if no notepad', () => {
            const result = getWorkingMemory(testDir);
            expect(result).toBeNull();
        });
        it('should extract working memory section', () => {
            addWorkingMemoryEntry(testDir, 'Work note');
            const result = getWorkingMemory(testDir);
            expect(result).not.toBeNull();
            expect(result).toContain('Work note');
        });
        it('should return null if section is empty', () => {
            initNotepad(testDir);
            const result = getWorkingMemory(testDir);
            expect(result).toBeNull();
        });
    });
    describe('getManualSection', () => {
        it('should return null if no notepad', () => {
            const result = getManualSection(testDir);
            expect(result).toBeNull();
        });
        it('should extract manual section', () => {
            addManualEntry(testDir, 'Manual note');
            const result = getManualSection(testDir);
            expect(result).not.toBeNull();
            expect(result).toContain('Manual note');
        });
        it('should return null if section is empty', () => {
            initNotepad(testDir);
            const result = getManualSection(testDir);
            expect(result).toBeNull();
        });
    });
    describe('edge cases', () => {
        it('should handle concurrent writes gracefully', () => {
            initNotepad(testDir);
            // Simulate concurrent writes
            const result1 = addWorkingMemoryEntry(testDir, 'Entry 1');
            const result2 = addManualEntry(testDir, 'Manual 1');
            const result3 = setPriorityContext(testDir, 'Priority 1');
            expect(result1).toBe(true);
            expect(result2).toBe(true);
            expect(result3.success).toBe(true);
            // Verify all sections exist
            const memory = getWorkingMemory(testDir);
            const manual = getManualSection(testDir);
            const priority = getPriorityContext(testDir);
            expect(memory).toContain('Entry 1');
            expect(manual).toContain('Manual 1');
            expect(priority).toBe('Priority 1');
        });
        it('should handle special characters in content', () => {
            const specialContent = 'Content with **markdown** and `code` and <tags>';
            setPriorityContext(testDir, specialContent);
            const result = getPriorityContext(testDir);
            expect(result).toBe(specialContent);
        });
        it('should handle multiline content', () => {
            const multilineContent = `Line 1
Line 2
Line 3`;
            setPriorityContext(testDir, multilineContent);
            const result = getPriorityContext(testDir);
            expect(result).toBe(multilineContent);
        });
    });
    // Regression coverage for issue #4040: `replaceSection` used the raw section
    // text as a `String.prototype.replace` replacement pattern, and its boundary
    // lookahead was not anchored to a line start.
    describe('replaceSection integrity (issue #4040)', () => {
        const countMatches = (content, pattern) => content.match(pattern)?.length ?? 0;
        it('keeps literal $ sequences in priority context', () => {
            setPriorityContext(testDir, "price was $1,699 and $& and $` and $' and $1");
            expect(getPriorityContext(testDir)).toBe("price was $1,699 and $& and $` and $' and $1");
        });
        it('keeps literal $ sequences in working memory entries', () => {
            addWorkingMemoryEntry(testDir, 'price was $1,699 today');
            const content = readFileSync(getNotepadPath(testDir), 'utf-8');
            expect(content).toContain('price was $1,699 today');
            expect(countMatches(content, /## Working Memory/g)).toBe(1);
        });
        it('does not grow the file when an entry contains $-prefixed patterns', () => {
            addWorkingMemoryEntry(testDir, 'seed entry');
            const notepadPath = getNotepadPath(testDir);
            const before = readFileSync(notepadPath, 'utf-8').length;
            addWorkingMemoryEntry(testDir, "a$'b");
            const after = readFileSync(notepadPath, 'utf-8').length;
            // The entry plus its `### ` timestamp heading is well under 200 bytes; the
            // pre-fix bug roughly doubled the whole file.
            expect(after - before).toBeLessThan(200);
        });
        it('leaves no stale duplicated section after repeated writes', () => {
            addWorkingMemoryEntry(testDir, 'plain entry one');
            addWorkingMemoryEntry(testDir, 'plain entry two');
            addWorkingMemoryEntry(testDir, 'plain entry three');
            const content = readFileSync(getNotepadPath(testDir), 'utf-8');
            expect(countMatches(content, /## Working Memory/g)).toBe(1);
            expect(countMatches(content, /plain entry one/g)).toBe(1);
            // No `### ` entry heading may be demoted to `## `.
            expect(countMatches(content, /^## 20/gm)).toBe(0);
        });
        it('leaves no stale duplicated MANUAL section after repeated writes', () => {
            addManualEntry(testDir, 'manual one');
            addManualEntry(testDir, 'manual two');
            addManualEntry(testDir, 'manual three');
            const content = readFileSync(getNotepadPath(testDir), 'utf-8');
            expect(countMatches(content, /## MANUAL/g)).toBe(1);
            expect(countMatches(content, /manual one/g)).toBe(1);
        });
        it('keeps every section heading exactly once across mixed writes', () => {
            setPriorityContext(testDir, 'priority one');
            addWorkingMemoryEntry(testDir, 'working one');
            addManualEntry(testDir, 'manual one');
            setPriorityContext(testDir, 'priority two');
            addWorkingMemoryEntry(testDir, 'working two');
            addManualEntry(testDir, 'manual two');
            const content = readFileSync(getNotepadPath(testDir), 'utf-8');
            expect(countMatches(content, /^## Priority Context$/gm)).toBe(1);
            expect(countMatches(content, /^## Working Memory$/gm)).toBe(1);
            expect(countMatches(content, /^## MANUAL$/gm)).toBe(1);
            expect(getPriorityContext(testDir)).toBe('priority two');
            expect(getWorkingMemory(testDir)).toContain('working one');
            expect(getWorkingMemory(testDir)).toContain('working two');
            expect(getManualSection(testDir)).toContain('manual one');
            expect(getManualSection(testDir)).toContain('manual two');
        });
    });
});
//# sourceMappingURL=notepad.test.js.map