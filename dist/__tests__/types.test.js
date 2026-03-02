import { describe, it, expect } from 'vitest';
describe('Type Tests', () => {
    describe('ModelType', () => {
        it('should accept valid model types', () => {
            const validTypes = ['sonnet', 'opus', 'haiku', 'inherit'];
            expect(validTypes).toHaveLength(4);
        });
    });
    describe('AgentConfig', () => {
        it('should create valid agent config', () => {
            const config = {
                name: 'test-agent',
                description: 'A test agent',
                prompt: 'Test prompt',
                tools: ['tool1', 'tool2'],
                model: 'sonnet',
            };
            expect(config.name).toBe('test-agent');
            expect(config.tools).toHaveLength(2);
            expect(config.model).toBe('sonnet');
        });
        it('should allow optional model field', () => {
            const config = {
                name: 'test-agent',
                description: 'A test agent',
                prompt: 'Test prompt',
                tools: [],
            };
            expect(config.model).toBeUndefined();
        });
    });
    describe('PluginConfig', () => {
        it('should create valid plugin config with features', () => {
            const config = {
                features: {
                    parallelExecution: true,
                    lspTools: true,
                    astTools: false,
                    continuationEnforcement: true,
                    autoContextInjection: false,
                },
            };
            expect(config.features?.parallelExecution).toBe(true);
            expect(config.features?.astTools).toBe(false);
        });
        it('should support agent configuration', () => {
            const config = {
                agents: {
                    omc: { model: 'claude-sonnet-4-6' },
                    architect: { model: 'claude-opus-4-6' },
                    explore: { model: 'claude-haiku-4-5' },
                    documentSpecialist: { model: 'claude-haiku-4-5' },
                },
            };
            expect(config.agents?.omc?.model).toBe('claude-sonnet-4-6');
            expect(config.agents?.architect?.model).toBe('claude-opus-4-6');
        });
        it('should support routing configuration', () => {
            const config = {
                routing: {
                    enabled: true,
                    defaultTier: 'MEDIUM',
                    escalationEnabled: true,
                    maxEscalations: 2,
                    tierModels: {
                        LOW: 'claude-haiku-4',
                        MEDIUM: 'claude-sonnet-4-6',
                        HIGH: 'claude-opus-4-6',
                    },
                },
            };
            expect(config.routing?.enabled).toBe(true);
            expect(config.routing?.defaultTier).toBe('MEDIUM');
            expect(config.routing?.tierModels?.HIGH).toBe('claude-opus-4-6');
        });
    });
});
//# sourceMappingURL=types.test.js.map