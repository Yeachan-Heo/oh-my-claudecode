import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { initNotepad, readNotepad, getPriorityContext, getWorkingMemory, addWorkingMemoryEntry, setPriorityContext, addManualEntry, pruneOldEntries, getNotepadStats, formatNotepadContext, DEFAULT_CONFIG, PRIORITY_HEADER, WORKING_MEMORY_HEADER, MANUAL_HEADER, getManualSection, getNotepadPath } from '../hooks/notepad/index.js';
describe('Notepad Module', () => {
    let testDir;
    beforeEach(() => {
        // Create a unique temp directory for each test
        testDir = join(tmpdir(), `notepad-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
        mkdirSync(testDir, { recursive: true });
    });
    afterEach(() => {
        // Clean up test directory
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
            const omcDir = join(testDir, '.omc');
            expect(existsSync(omcDir)).toBe(false);
            initNotepad(testDir);
            expect(existsSync(omcDir)).toBe(true);
        });
        it('should not overwrite existing notepad', () => {
            const omcDir = join(testDir, '.omc');
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
});
//# sourceMappingURL=notepad.test.js.map