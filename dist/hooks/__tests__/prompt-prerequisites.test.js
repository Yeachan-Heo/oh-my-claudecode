import { describe, expect, it } from 'vitest';
import { buildPromptPrerequisiteDenyReason, buildPromptPrerequisiteReminder, extractFilePaths, extractRequiredToolCalls, getPromptPrerequisiteConfig, isPromptPrerequisiteBlockingTool, parsePromptPrerequisiteSections, recordPromptPrerequisiteProgress, } from '../prompt-prerequisites/index.js';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { writeModeState } from '../../lib/mode-state-io.js';
describe('prompt prerequisite parser', () => {
    it('parses default sections, tool calls, and file paths', () => {
        const config = getPromptPrerequisiteConfig();
        const parsed = parsePromptPrerequisiteSections(`ralph fix issue\n\n# MÉMOIRE\nCall supermemory search and notepad_read first.\n\n# VERIFY-FIRST\nOpen src/hooks/bridge.ts and ./docs/plan.md before editing.\n\n# CONTEXT\nAlso use project_memory_read.`, config);
        expect(parsed.sections.map((section) => section.kind)).toEqual([
            'memory',
            'verifyFirst',
            'context',
        ]);
        expect(parsed.requiredToolCalls).toEqual([
            'notepad_read',
            'supermemory.search',
            'project_memory_read',
        ]);
        expect(parsed.requiredFilePaths).toEqual([
            'src/hooks/bridge.ts',
            './docs/plan.md',
        ]);
    });
    it('supports configurable section aliases', () => {
        const config = getPromptPrerequisiteConfig({
            promptPrerequisites: {
                sectionNames: {
                    memory: ['Brain Dump'],
                },
            },
        });
        const parsed = parsePromptPrerequisiteSections(`# Brain Dump\nRun notepad_read before editing.`, config);
        expect(parsed.sections).toHaveLength(1);
        expect(parsed.sections[0]?.kind).toBe('memory');
        expect(parsed.requiredToolCalls).toEqual(['notepad_read']);
    });
    it('extracts supported tool names and ignores non-path text', () => {
        expect(extractRequiredToolCalls('Use mcp__supermemory__search, project_memory_read, then notepad_read.')).toEqual([
            'notepad_read',
            'project_memory_read',
            'supermemory.search',
        ]);
        expect(extractFilePaths('Read README and https://example.com but also src/index.ts and ../notes/todo.md')).toEqual([
            'src/index.ts',
            '../notes/todo.md',
        ]);
    });
    it('builds reminder and deny text', () => {
        const state = {
            active: true,
            session_id: 'sess',
            execution_keywords: ['ralph'],
            required_tool_calls: ['notepad_read'],
            required_file_paths: ['src/hooks/bridge.ts'],
            completed_tool_calls: [],
            completed_file_paths: [],
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
        };
        expect(buildPromptPrerequisiteReminder(state)).toContain('[BLOCKING PREREQUISITE GATE]');
        expect(buildPromptPrerequisiteDenyReason(state, 'Edit')).toContain('Blocking Edit');
        expect(isPromptPrerequisiteBlockingTool('Edit', getPromptPrerequisiteConfig())).toBe(true);
        expect(isPromptPrerequisiteBlockingTool('Read', getPromptPrerequisiteConfig())).toBe(false);
    });
});
describe('prompt prerequisite progress tracking', () => {
    it('tracks prerequisite tool calls and file reads until complete', () => {
        const tempDir = mkdtempSync(join(tmpdir(), 'prompt-prereq-'));
        try {
            writeModeState('prompt-prerequisites', {
                active: true,
                session_id: 'sess',
                execution_keywords: ['ralph'],
                required_tool_calls: ['notepad_read', 'project_memory_read'],
                required_file_paths: ['src/hooks/bridge.ts'],
                completed_tool_calls: [],
                completed_file_paths: [],
                created_at: new Date().toISOString(),
                updated_at: new Date().toISOString(),
            }, tempDir, 'sess');
            const afterNotepad = recordPromptPrerequisiteProgress(tempDir, 'sess', 'mcp__omx_notepad__notepad_read', {});
            expect(afterNotepad?.toolSatisfied).toBe('notepad_read');
            expect(afterNotepad?.isComplete).toBe(false);
            const afterRead = recordPromptPrerequisiteProgress(tempDir, 'sess', 'Read', { file_path: 'src/hooks/bridge.ts' });
            expect(afterRead?.fileSatisfied).toBe('src/hooks/bridge.ts');
            expect(afterRead?.isComplete).toBe(false);
            const afterMemory = recordPromptPrerequisiteProgress(tempDir, 'sess', 'project_memory_read', {});
            expect(afterMemory?.toolSatisfied).toBe('project_memory_read');
            expect(afterMemory?.isComplete).toBe(true);
        }
        finally {
            rmSync(tempDir, { recursive: true, force: true });
        }
    });
});
//# sourceMappingURL=prompt-prerequisites.test.js.map