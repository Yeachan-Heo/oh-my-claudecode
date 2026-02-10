import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { readPrd, writePrd, findPrdPath, getPrdStatus, markStoryComplete, markStoryIncomplete, getStory, getNextStory, createPrd, createSimplePrd, initPrd, formatPrdStatus, formatStory, PRD_FILENAME } from '../hooks/ralph/index.js';
describe('Ralph PRD Module', () => {
    let testDir;
    beforeEach(() => {
        // Create a unique temp directory for each test
        testDir = join(tmpdir(), `ralph-prd-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
        mkdirSync(testDir, { recursive: true });
    });
    afterEach(() => {
        // Clean up test directory
        if (existsSync(testDir)) {
            rmSync(testDir, { recursive: true, force: true });
        }
    });
    describe('findPrdPath', () => {
        it('should return null when no prd.json exists', () => {
            expect(findPrdPath(testDir)).toBeNull();
        });
        it('should find prd.json in root directory', () => {
            const prdPath = join(testDir, PRD_FILENAME);
            writeFileSync(prdPath, '{}');
            expect(findPrdPath(testDir)).toBe(prdPath);
        });
        it('should find prd.json in .omc directory', () => {
            const omcDir = join(testDir, '.omc');
            mkdirSync(omcDir, { recursive: true });
            const prdPath = join(omcDir, PRD_FILENAME);
            writeFileSync(prdPath, '{}');
            expect(findPrdPath(testDir)).toBe(prdPath);
        });
        it('should prefer root over .omc', () => {
            const rootPath = join(testDir, PRD_FILENAME);
            const omcDir = join(testDir, '.omc');
            mkdirSync(omcDir, { recursive: true });
            const omcPath = join(omcDir, PRD_FILENAME);
            writeFileSync(rootPath, '{"source": "root"}');
            writeFileSync(omcPath, '{"source": "omc"}');
            expect(findPrdPath(testDir)).toBe(rootPath);
        });
    });
    describe('readPrd / writePrd', () => {
        const samplePrd = {
            project: 'TestProject',
            branchName: 'ralph/test-feature',
            description: 'Test feature description',
            userStories: [
                {
                    id: 'US-001',
                    title: 'First story',
                    description: 'As a user, I want to test',
                    acceptanceCriteria: ['Criterion 1', 'Criterion 2'],
                    priority: 1,
                    passes: false
                },
                {
                    id: 'US-002',
                    title: 'Second story',
                    description: 'As a user, I want more tests',
                    acceptanceCriteria: ['Criterion A'],
                    priority: 2,
                    passes: true
                }
            ]
        };
        it('should return null when reading non-existent prd', () => {
            expect(readPrd(testDir)).toBeNull();
        });
        it('should write and read prd correctly', () => {
            expect(writePrd(testDir, samplePrd)).toBe(true);
            const read = readPrd(testDir);
            expect(read).toEqual(samplePrd);
        });
        it('should create .omc directory when writing', () => {
            writePrd(testDir, samplePrd);
            expect(existsSync(join(testDir, '.omc'))).toBe(true);
        });
        it('should return null for malformed JSON', () => {
            const prdPath = join(testDir, PRD_FILENAME);
            writeFileSync(prdPath, 'not valid json');
            expect(readPrd(testDir)).toBeNull();
        });
        it('should return null for missing userStories', () => {
            const prdPath = join(testDir, PRD_FILENAME);
            writeFileSync(prdPath, JSON.stringify({ project: 'Test' }));
            expect(readPrd(testDir)).toBeNull();
        });
    });
    describe('getPrdStatus', () => {
        it('should correctly calculate status for mixed completion', () => {
            const prd = {
                project: 'Test',
                branchName: 'test',
                description: 'Test',
                userStories: [
                    { id: 'US-001', title: 'A', description: '', acceptanceCriteria: [], priority: 1, passes: true },
                    { id: 'US-002', title: 'B', description: '', acceptanceCriteria: [], priority: 2, passes: false },
                    { id: 'US-003', title: 'C', description: '', acceptanceCriteria: [], priority: 3, passes: false }
                ]
            };
            const status = getPrdStatus(prd);
            expect(status.total).toBe(3);
            expect(status.completed).toBe(1);
            expect(status.pending).toBe(2);
            expect(status.allComplete).toBe(false);
            expect(status.nextStory?.id).toBe('US-002');
            expect(status.incompleteIds).toEqual(['US-002', 'US-003']);
        });
        it('should return allComplete true when all stories pass', () => {
            const prd = {
                project: 'Test',
                branchName: 'test',
                description: 'Test',
                userStories: [
                    { id: 'US-001', title: 'A', description: '', acceptanceCriteria: [], priority: 1, passes: true },
                    { id: 'US-002', title: 'B', description: '', acceptanceCriteria: [], priority: 2, passes: true }
                ]
            };
            const status = getPrdStatus(prd);
            expect(status.allComplete).toBe(true);
            expect(status.nextStory).toBeNull();
            expect(status.incompleteIds).toEqual([]);
        });
        it('should sort pending stories by priority', () => {
            const prd = {
                project: 'Test',
                branchName: 'test',
                description: 'Test',
                userStories: [
                    { id: 'US-001', title: 'Low', description: '', acceptanceCriteria: [], priority: 3, passes: false },
                    { id: 'US-002', title: 'High', description: '', acceptanceCriteria: [], priority: 1, passes: false },
                    { id: 'US-003', title: 'Med', description: '', acceptanceCriteria: [], priority: 2, passes: false }
                ]
            };
            const status = getPrdStatus(prd);
            expect(status.nextStory?.id).toBe('US-002'); // Highest priority (1)
        });
        it('should handle empty stories array', () => {
            const prd = {
                project: 'Test',
                branchName: 'test',
                description: 'Test',
                userStories: []
            };
            const status = getPrdStatus(prd);
            expect(status.total).toBe(0);
            expect(status.allComplete).toBe(true);
            expect(status.nextStory).toBeNull();
        });
    });
    describe('markStoryComplete / markStoryIncomplete', () => {
        beforeEach(() => {
            const prd = {
                project: 'Test',
                branchName: 'test',
                description: 'Test',
                userStories: [
                    { id: 'US-001', title: 'A', description: '', acceptanceCriteria: [], priority: 1, passes: false }
                ]
            };
            writePrd(testDir, prd);
        });
        it('should mark story as complete', () => {
            expect(markStoryComplete(testDir, 'US-001', 'Done!')).toBe(true);
            const prd = readPrd(testDir);
            expect(prd?.userStories[0].passes).toBe(true);
            expect(prd?.userStories[0].notes).toBe('Done!');
        });
        it('should mark story as incomplete', () => {
            markStoryComplete(testDir, 'US-001');
            expect(markStoryIncomplete(testDir, 'US-001', 'Needs rework')).toBe(true);
            const prd = readPrd(testDir);
            expect(prd?.userStories[0].passes).toBe(false);
            expect(prd?.userStories[0].notes).toBe('Needs rework');
        });
        it('should return false for non-existent story', () => {
            expect(markStoryComplete(testDir, 'US-999')).toBe(false);
        });
        it('should return false when no prd exists', () => {
            rmSync(join(testDir, '.omc'), { recursive: true, force: true });
            expect(markStoryComplete(testDir, 'US-001')).toBe(false);
        });
    });
    describe('getStory / getNextStory', () => {
        beforeEach(() => {
            const prd = {
                project: 'Test',
                branchName: 'test',
                description: 'Test',
                userStories: [
                    { id: 'US-001', title: 'First', description: '', acceptanceCriteria: [], priority: 1, passes: true },
                    { id: 'US-002', title: 'Second', description: '', acceptanceCriteria: [], priority: 2, passes: false }
                ]
            };
            writePrd(testDir, prd);
        });
        it('should get story by ID', () => {
            const story = getStory(testDir, 'US-001');
            expect(story?.title).toBe('First');
        });
        it('should return null for non-existent story', () => {
            expect(getStory(testDir, 'US-999')).toBeNull();
        });
        it('should get next incomplete story', () => {
            const story = getNextStory(testDir);
            expect(story?.id).toBe('US-002');
        });
    });
    describe('createPrd / createSimplePrd', () => {
        it('should create PRD with auto-assigned priorities', () => {
            const prd = createPrd('Project', 'branch', 'Description', [
                { id: 'US-001', title: 'A', description: '', acceptanceCriteria: [] },
                { id: 'US-002', title: 'B', description: '', acceptanceCriteria: [] }
            ]);
            expect(prd.userStories[0].priority).toBe(1);
            expect(prd.userStories[1].priority).toBe(2);
            expect(prd.userStories[0].passes).toBe(false);
            expect(prd.userStories[1].passes).toBe(false);
        });
        it('should respect provided priorities', () => {
            const prd = createPrd('Project', 'branch', 'Description', [
                { id: 'US-001', title: 'A', description: '', acceptanceCriteria: [], priority: 10 },
                { id: 'US-002', title: 'B', description: '', acceptanceCriteria: [] }
            ]);
            expect(prd.userStories[0].priority).toBe(10);
            expect(prd.userStories[1].priority).toBe(2); // Auto-assigned
        });
        it('should create simple PRD with single story', () => {
            const prd = createSimplePrd('Project', 'branch', 'Implement feature X');
            expect(prd.userStories.length).toBe(1);
            expect(prd.userStories[0].id).toBe('US-001');
            expect(prd.userStories[0].description).toBe('Implement feature X');
            expect(prd.userStories[0].acceptanceCriteria.length).toBeGreaterThan(0);
        });
        it('should truncate long titles in simple PRD', () => {
            const longTask = 'A'.repeat(100);
            const prd = createSimplePrd('Project', 'branch', longTask);
            expect(prd.userStories[0].title.length).toBeLessThanOrEqual(53); // 50 + "..."
            expect(prd.userStories[0].title.endsWith('...')).toBe(true);
        });
    });
    describe('initPrd', () => {
        it('should initialize PRD in directory', () => {
            expect(initPrd(testDir, 'Project', 'branch', 'Description')).toBe(true);
            const prd = readPrd(testDir);
            expect(prd?.project).toBe('Project');
            expect(prd?.userStories.length).toBe(1);
        });
        it('should initialize PRD with custom stories', () => {
            const stories = [
                { id: 'US-001', title: 'A', description: '', acceptanceCriteria: [] },
                { id: 'US-002', title: 'B', description: '', acceptanceCriteria: [] }
            ];
            expect(initPrd(testDir, 'Project', 'branch', 'Description', stories)).toBe(true);
            const prd = readPrd(testDir);
            expect(prd?.userStories.length).toBe(2);
        });
    });
    describe('formatPrdStatus / formatStory', () => {
        it('should format status correctly', () => {
            const status = {
                total: 3,
                completed: 1,
                pending: 2,
                allComplete: false,
                nextStory: { id: 'US-002', title: 'Next', description: '', acceptanceCriteria: [], priority: 2, passes: false },
                incompleteIds: ['US-002', 'US-003']
            };
            const formatted = formatPrdStatus(status);
            expect(formatted).toContain('1/3');
            expect(formatted).toContain('US-002');
            expect(formatted).toContain('US-003');
        });
        it('should format complete status', () => {
            const status = {
                total: 2,
                completed: 2,
                pending: 0,
                allComplete: true,
                nextStory: null,
                incompleteIds: []
            };
            const formatted = formatPrdStatus(status);
            expect(formatted).toContain('COMPLETE');
        });
        it('should format story correctly', () => {
            const story = {
                id: 'US-001',
                title: 'Test Story',
                description: 'As a user, I want to test',
                acceptanceCriteria: ['Criterion 1', 'Criterion 2'],
                priority: 1,
                passes: false,
                notes: 'Some notes'
            };
            const formatted = formatStory(story);
            expect(formatted).toContain('US-001');
            expect(formatted).toContain('Test Story');
            expect(formatted).toContain('PENDING');
            expect(formatted).toContain('Criterion 1');
            expect(formatted).toContain('Some notes');
        });
    });
});
//# sourceMappingURL=ralph-prd.test.js.map