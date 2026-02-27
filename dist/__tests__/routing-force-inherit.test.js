/**
 * Tests for routing.forceInherit feature (issue #1135)
 *
 * When routing.forceInherit is true, all agents should inherit the parent
 * model instead of using OMC's per-agent model routing.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { routeTask, getModelForTask, } from '../features/model-routing/router.js';
import { enforceModel, processPreToolUse, } from '../features/delegation-enforcer.js';
// Mock loadConfig to control forceInherit
vi.mock('../config/loader.js', async (importOriginal) => {
    const actual = await importOriginal();
    return {
        ...actual,
        loadConfig: vi.fn(() => ({
            ...actual.DEFAULT_CONFIG,
            routing: {
                ...actual.DEFAULT_CONFIG.routing,
                forceInherit: false,
            },
        })),
    };
});
import { loadConfig, DEFAULT_CONFIG } from '../config/loader.js';
const mockedLoadConfig = vi.mocked(loadConfig);
describe('routing.forceInherit (issue #1135)', () => {
    let originalEnv;
    beforeEach(() => {
        originalEnv = process.env.OMC_ROUTING_FORCE_INHERIT;
        vi.clearAllMocks();
    });
    afterEach(() => {
        if (originalEnv === undefined) {
            delete process.env.OMC_ROUTING_FORCE_INHERIT;
        }
        else {
            process.env.OMC_ROUTING_FORCE_INHERIT = originalEnv;
        }
    });
    describe('routeTask with forceInherit', () => {
        it('returns inherit model type when forceInherit is true', () => {
            const result = routeTask({ taskPrompt: 'Find all files', agentType: 'explore' }, { enabled: true, defaultTier: 'MEDIUM', forceInherit: true, escalationEnabled: false, maxEscalations: 0, tierModels: { LOW: 'haiku', MEDIUM: 'sonnet', HIGH: 'opus' } });
            expect(result.model).toBe('inherit');
            expect(result.modelType).toBe('inherit');
            expect(result.reasons).toContain('forceInherit enabled: agents inherit parent model');
            expect(result.confidence).toBe(1.0);
        });
        it('bypasses agent-specific overrides when forceInherit is true', () => {
            const result = routeTask({ taskPrompt: 'Design system architecture', agentType: 'architect' }, {
                enabled: true,
                defaultTier: 'MEDIUM',
                forceInherit: true,
                escalationEnabled: false,
                maxEscalations: 0,
                tierModels: { LOW: 'haiku', MEDIUM: 'sonnet', HIGH: 'opus' },
                agentOverrides: {
                    architect: { tier: 'HIGH', reason: 'Advisory agent requires deep reasoning' },
                },
            });
            expect(result.model).toBe('inherit');
            expect(result.modelType).toBe('inherit');
        });
        it('bypasses complexity-based routing when forceInherit is true', () => {
            const result = routeTask({
                taskPrompt: 'Refactor the entire authentication architecture with security review and data migration',
                agentType: 'executor',
            }, { enabled: true, defaultTier: 'MEDIUM', forceInherit: true, escalationEnabled: false, maxEscalations: 0, tierModels: { LOW: 'haiku', MEDIUM: 'sonnet', HIGH: 'opus' } });
            expect(result.model).toBe('inherit');
            expect(result.modelType).toBe('inherit');
        });
        it('routes normally when forceInherit is false', () => {
            const result = routeTask({ taskPrompt: 'Find all files', agentType: 'explore' }, { enabled: true, defaultTier: 'MEDIUM', forceInherit: false, escalationEnabled: false, maxEscalations: 0, tierModels: { LOW: 'haiku', MEDIUM: 'sonnet', HIGH: 'opus' } });
            expect(result.model).not.toBe('inherit');
        });
        it('routes normally when forceInherit is undefined', () => {
            const result = routeTask({ taskPrompt: 'Find all files', agentType: 'explore' }, { enabled: true, defaultTier: 'MEDIUM', escalationEnabled: false, maxEscalations: 0, tierModels: { LOW: 'haiku', MEDIUM: 'sonnet', HIGH: 'opus' } });
            expect(result.model).not.toBe('inherit');
        });
    });
    describe('getModelForTask with forceInherit', () => {
        it('returns inherit for all agent types when forceInherit is true', () => {
            const config = { enabled: true, defaultTier: 'MEDIUM', forceInherit: true, escalationEnabled: false, maxEscalations: 0, tierModels: { LOW: 'haiku', MEDIUM: 'sonnet', HIGH: 'opus' } };
            const agents = ['architect', 'executor', 'explore', 'writer', 'debugger', 'verifier'];
            for (const agent of agents) {
                const result = getModelForTask(agent, 'test task', config);
                expect(result.model).toBe('inherit');
            }
        });
    });
    describe('enforceModel with forceInherit', () => {
        it('strips model when forceInherit is true', () => {
            mockedLoadConfig.mockReturnValue({
                routing: { forceInherit: true },
            });
            const input = {
                description: 'Test task',
                prompt: 'Do something',
                subagent_type: 'oh-my-claudecode:executor',
                model: 'opus',
            };
            const result = enforceModel(input);
            expect(result.modifiedInput.model).toBeUndefined();
            expect(result.injected).toBe(false);
            expect(result.model).toBe('inherit');
        });
        it('does not inject model when forceInherit is true and no model specified', () => {
            mockedLoadConfig.mockReturnValue({
                routing: { forceInherit: true },
            });
            const input = {
                description: 'Test task',
                prompt: 'Do something',
                subagent_type: 'oh-my-claudecode:executor',
            };
            const result = enforceModel(input);
            expect(result.modifiedInput.model).toBeUndefined();
            expect(result.injected).toBe(false);
        });
        it('injects model normally when forceInherit is false', () => {
            mockedLoadConfig.mockReturnValue({
                routing: { forceInherit: false },
            });
            const input = {
                description: 'Test task',
                prompt: 'Do something',
                subagent_type: 'oh-my-claudecode:executor',
            };
            const result = enforceModel(input);
            expect(result.modifiedInput.model).toBe('sonnet');
            expect(result.injected).toBe(true);
        });
    });
    describe('config defaults', () => {
        it('DEFAULT_CONFIG has forceInherit set to false', () => {
            expect(DEFAULT_CONFIG.routing?.forceInherit).toBe(false);
        });
    });
    describe('processPreToolUse with forceInherit', () => {
        it('strips model from Task calls when forceInherit is true', () => {
            mockedLoadConfig.mockReturnValue({
                routing: { forceInherit: true },
            });
            const toolInput = {
                description: 'Test task',
                prompt: 'Do something',
                subagent_type: 'oh-my-claudecode:executor',
                model: 'opus',
            };
            const result = processPreToolUse('Task', toolInput);
            const modified = result.modifiedInput;
            expect(modified.model).toBeUndefined();
            expect(modified.prompt).toBe('Do something');
            expect(modified.subagent_type).toBe('oh-my-claudecode:executor');
        });
        it('does not strip model when forceInherit is false', () => {
            mockedLoadConfig.mockReturnValue({
                routing: { forceInherit: false },
            });
            const toolInput = {
                description: 'Test task',
                prompt: 'Do something',
                subagent_type: 'oh-my-claudecode:executor',
                model: 'haiku',
            };
            const result = processPreToolUse('Task', toolInput);
            const modified = result.modifiedInput;
            // Should preserve the explicit model (enforceModel preserves explicit)
            expect(modified.model).toBe('haiku');
        });
        it('does not affect non-Task tool calls', () => {
            mockedLoadConfig.mockReturnValue({
                routing: { forceInherit: true },
            });
            const toolInput = { command: 'ls -la' };
            const result = processPreToolUse('Bash', toolInput);
            expect(result.modifiedInput).toEqual(toolInput);
        });
    });
});
//# sourceMappingURL=routing-force-inherit.test.js.map