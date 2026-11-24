import { describe, it, expect, vi, beforeEach } from 'vitest';
// Mock dependencies
vi.mock('../../../features/auto-update.js', () => ({
    getOMCConfig: vi.fn(() => ({ silentAutoUpdate: false })),
}));
vi.mock('../../../features/context-injector/index.js', () => ({
    contextCollector: {
        register: vi.fn(),
        removeEntry: vi.fn(),
    },
}));
import { getBeadsInstructions, getBeadsContextConfig, registerBeadsContext, clearBeadsContext, BEADS_INSTRUCTIONS, BEADS_RUST_INSTRUCTIONS, } from '../index.js';
import { getOMCConfig } from '../../../features/auto-update.js';
import { contextCollector } from '../../../features/context-injector/index.js';
const mockGetOMCConfig = vi.mocked(getOMCConfig);
const mockRegister = vi.mocked(contextCollector.register);
const mockRemoveEntry = vi.mocked(contextCollector.removeEntry);
describe('beads-context', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockGetOMCConfig.mockReturnValue({ silentAutoUpdate: false });
    });
    describe('getBeadsInstructions', () => {
        it('should return beads instructions for beads tool', () => {
            const result = getBeadsInstructions('beads');
            expect(result).toBe(BEADS_INSTRUCTIONS);
            expect(result).toContain('bd');
            expect(result).toContain('Task Management: Beads');
        });
        it('should return beads-rust instructions for beads-rust tool', () => {
            const result = getBeadsInstructions('beads-rust');
            expect(result).toBe(BEADS_RUST_INSTRUCTIONS);
            expect(result).toContain('br');
            expect(result).toContain('Task Management: Beads-Rust');
        });
    });
    describe('getBeadsContextConfig', () => {
        it('should return defaults when no config', () => {
            mockGetOMCConfig.mockReturnValue({ silentAutoUpdate: false });
            const config = getBeadsContextConfig();
            expect(config).toEqual({
                taskTool: 'builtin',
                injectInstructions: true,
                useMcp: false,
            });
        });
        it('should read taskTool from config', () => {
            mockGetOMCConfig.mockReturnValue({
                silentAutoUpdate: false,
                taskTool: 'beads',
            });
            const config = getBeadsContextConfig();
            expect(config.taskTool).toBe('beads');
        });
        it('should read taskToolConfig from config', () => {
            mockGetOMCConfig.mockReturnValue({
                silentAutoUpdate: false,
                taskTool: 'beads-rust',
                taskToolConfig: {
                    injectInstructions: false,
                    useMcp: true,
                },
            });
            const config = getBeadsContextConfig();
            expect(config).toEqual({
                taskTool: 'beads-rust',
                injectInstructions: false,
                useMcp: true,
            });
        });
    });
    describe('registerBeadsContext', () => {
        it('should return false when taskTool is builtin', () => {
            mockGetOMCConfig.mockReturnValue({ silentAutoUpdate: false });
            const result = registerBeadsContext('session-1');
            expect(result).toBe(false);
            expect(mockRegister).not.toHaveBeenCalled();
        });
        it('should return false when injectInstructions is false', () => {
            mockGetOMCConfig.mockReturnValue({
                silentAutoUpdate: false,
                taskTool: 'beads',
                taskToolConfig: { injectInstructions: false },
            });
            const result = registerBeadsContext('session-1');
            expect(result).toBe(false);
            expect(mockRegister).not.toHaveBeenCalled();
        });
        it('should register context for beads tool', () => {
            mockGetOMCConfig.mockReturnValue({
                silentAutoUpdate: false,
                taskTool: 'beads',
            });
            const result = registerBeadsContext('session-1');
            expect(result).toBe(true);
            expect(mockRegister).toHaveBeenCalledWith('session-1', {
                id: 'beads-instructions',
                source: 'beads',
                content: BEADS_INSTRUCTIONS,
                priority: 'normal',
            });
        });
        it('should register context for beads-rust tool', () => {
            mockGetOMCConfig.mockReturnValue({
                silentAutoUpdate: false,
                taskTool: 'beads-rust',
            });
            const result = registerBeadsContext('session-2');
            expect(result).toBe(true);
            expect(mockRegister).toHaveBeenCalledWith('session-2', {
                id: 'beads-instructions',
                source: 'beads',
                content: BEADS_RUST_INSTRUCTIONS,
                priority: 'normal',
            });
        });
        it('should return false for invalid taskTool value', () => {
            mockGetOMCConfig.mockReturnValue({
                silentAutoUpdate: false,
                taskTool: 'invalid-tool',
            });
            const result = registerBeadsContext('session-1');
            expect(result).toBe(false);
            expect(mockRegister).not.toHaveBeenCalled();
        });
    });
    describe('clearBeadsContext', () => {
        it('should remove beads entry from collector', () => {
            clearBeadsContext('session-1');
            expect(mockRemoveEntry).toHaveBeenCalledWith('session-1', 'beads', 'beads-instructions');
        });
    });
    describe('constants', () => {
        const instructionContracts = [
            {
                instructions: BEADS_INSTRUCTIONS,
                commands: [
                    'bd create "title"',
                    'bd list',
                    'bd show <id>',
                    'bd close <id>',
                    'bd dep add <id> <depends-on-id>',
                    'Add a dependency: <id> depends on <depends-on-id>',
                    'bd update abc123 --status in_progress',
                    'bd close abc123',
                ],
                invalidCommands: [
                    /`bd\s+update\s+[^`\n]*\s--status\s+done`/,
                    /`bd\s+deps\b[^`\n]*`/,
                    /`bd\s+dep(?:s)?\b[^`\n]*\s--add\b[^`\n]*`/,
                ],
            },
            {
                instructions: BEADS_RUST_INSTRUCTIONS,
                commands: [
                    'br create "title"',
                    'br list',
                    'br show <id>',
                    'br close <id>',
                    'br dep add <id> <depends-on-id>',
                    'Add a dependency: <id> depends on <depends-on-id>',
                    'br update abc123 --status in_progress',
                    'br close abc123',
                ],
                invalidCommands: [
                    /`br\s+update\s+[^`\n]*\s--status\s+done`/,
                    /`br\s+deps\b[^`\n]*`/,
                    /`br\s+dep(?:s)?\b[^`\n]*\s--add\b[^`\n]*`/,
                ],
            },
        ];
        it.each(instructionContracts)('contains valid exact commands and rejects obsolete syntax', ({ instructions, commands, invalidCommands }) => {
            for (const command of commands) {
                expect(instructions).toContain(command);
            }
            for (const invalidCommand of invalidCommands) {
                expect(instructions).not.toMatch(invalidCommand);
            }
        });
    });
});
//# sourceMappingURL=index.test.js.map