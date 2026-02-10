import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { resolveExternalModel, buildFallbackChain, CODEX_MODEL_FALLBACKS, GEMINI_MODEL_FALLBACKS, } from '../external-model-policy.js';
describe('external-model-policy', () => {
    // Store original process.env
    const originalEnv = process.env;
    beforeEach(() => {
        // Reset process.env before each test
        vi.resetModules();
        process.env = { ...originalEnv };
        // Clear environment variables that might affect tests
        delete process.env.OMC_CODEX_DEFAULT_MODEL;
        delete process.env.OMC_GEMINI_DEFAULT_MODEL;
    });
    afterEach(() => {
        // Restore original process.env after each test
        process.env = originalEnv;
        vi.restoreAllMocks();
    });
    describe('resolveExternalModel', () => {
        const defaultFallbackPolicy = {
            onModelFailure: 'provider_chain',
            allowCrossProvider: false,
            crossProviderOrder: ['codex', 'gemini'],
        };
        describe('Precedence 1: explicitModel argument', () => {
            it('should use explicitModel when provided for codex models', () => {
                const config = {
                    defaults: { provider: 'gemini', geminiModel: 'custom-gemini-model' },
                };
                const options = {
                    agentRole: 'architect',
                    explicitModel: 'gpt-5.3-codex',
                };
                const result = resolveExternalModel(config, options);
                expect(result.provider).toBe('codex');
                expect(result.model).toBe('gpt-5.3-codex');
                expect(result.fallbackPolicy).toEqual(defaultFallbackPolicy);
            });
            it('should use explicitModel when provided for gemini models', () => {
                const config = {
                    defaults: { provider: 'codex', codexModel: 'custom-codex-model' },
                };
                const options = {
                    agentRole: 'architect',
                    explicitModel: 'gemini-2.5-pro',
                };
                const result = resolveExternalModel(config, options);
                expect(result.provider).toBe('gemini');
                expect(result.model).toBe('gemini-2.5-pro');
            });
            it('should take precedence over all other options', () => {
                const config = {
                    defaults: { provider: 'codex' },
                    rolePreferences: {
                        architect: { provider: 'gemini', model: 'gemini-2.5-pro' },
                    },
                    taskPreferences: {
                        planning: { provider: 'gemini', model: 'gemini-3-pro-preview' },
                    },
                };
                const options = {
                    agentRole: 'architect',
                    taskType: 'planning',
                    explicitProvider: 'gemini',
                    explicitModel: 'custom-explicit-model',
                };
                const result = resolveExternalModel(config, options);
                expect(result.model).toBe('custom-explicit-model');
            });
            it('should handle empty string explicitModel as falsy', () => {
                const config = {
                    defaults: { provider: 'codex', codexModel: 'default-codex' },
                };
                const options = {
                    explicitModel: '',
                };
                const result = resolveExternalModel(config, options);
                expect(result.model).toBe('default-codex');
            });
        });
        describe('Precedence 2: explicitProvider + rolePreferences matching', () => {
            it('should use role preference when explicitProvider matches', () => {
                const config = {
                    defaults: { provider: 'codex' },
                    rolePreferences: {
                        architect: { provider: 'codex', model: 'gpt-5.3-codex' },
                    },
                };
                const options = {
                    agentRole: 'architect',
                    explicitProvider: 'codex',
                };
                const result = resolveExternalModel(config, options);
                expect(result.provider).toBe('codex');
                expect(result.model).toBe('gpt-5.3-codex');
            });
            it('should use role preference provider when explicitProvider does not match', () => {
                const config = {
                    defaults: { provider: 'codex' },
                    rolePreferences: {
                        architect: { provider: 'gemini', model: 'gemini-3-pro-preview' },
                    },
                };
                const options = {
                    agentRole: 'architect',
                    explicitProvider: 'codex',
                };
                const result = resolveExternalModel(config, options);
                // rolePreferences (precedence 4) is checked - uses gemini from role pref
                // Note: explicitProvider does NOT restrict the role preference match
                expect(result.provider).toBe('gemini');
                expect(result.model).toBe('gemini-3-pro-preview');
            });
            it('should skip when agentRole is not provided', () => {
                const config = {
                    defaults: { provider: 'codex', codexModel: 'default-codex' },
                    rolePreferences: {
                        architect: { provider: 'codex', model: 'gpt-5.3-codex' },
                    },
                };
                const options = {
                    explicitProvider: 'codex',
                };
                const result = resolveExternalModel(config, options);
                expect(result.model).toBe('default-codex');
            });
        });
        describe('Precedence 3: taskPreferences lookup', () => {
            it('should use task preference when taskType matches', () => {
                const config = {
                    defaults: { provider: 'codex' },
                    taskPreferences: {
                        planning: { provider: 'gemini', model: 'gemini-3-pro-preview' },
                    },
                };
                const options = {
                    taskType: 'planning',
                };
                const result = resolveExternalModel(config, options);
                expect(result.provider).toBe('gemini');
                expect(result.model).toBe('gemini-3-pro-preview');
            });
            it('should take precedence over rolePreferences', () => {
                const config = {
                    defaults: { provider: 'codex' },
                    rolePreferences: {
                        architect: { provider: 'codex', model: 'gpt-5.2-codex' },
                    },
                    taskPreferences: {
                        planning: { provider: 'gemini', model: 'gemini-3-pro-preview' },
                    },
                };
                const options = {
                    agentRole: 'architect',
                    taskType: 'planning',
                };
                const result = resolveExternalModel(config, options);
                expect(result.provider).toBe('gemini');
                expect(result.model).toBe('gemini-3-pro-preview');
            });
            it('should skip when taskType is not provided', () => {
                const config = {
                    defaults: { provider: 'codex', codexModel: 'default-codex' },
                    taskPreferences: {
                        planning: { provider: 'gemini', model: 'gemini-3-pro-preview' },
                    },
                };
                const options = {
                    agentRole: 'architect',
                };
                const result = resolveExternalModel(config, options);
                expect(result.model).toBe('default-codex');
            });
            it('should skip when taskType not found in preferences', () => {
                const config = {
                    defaults: { provider: 'codex', codexModel: 'default-codex' },
                    taskPreferences: {
                        planning: { provider: 'gemini', model: 'gemini-3-pro-preview' },
                    },
                };
                const options = {
                    taskType: 'unknown-task',
                };
                const result = resolveExternalModel(config, options);
                expect(result.model).toBe('default-codex');
            });
        });
        describe('Precedence 4: rolePreferences lookup', () => {
            it('should use role preference when agentRole matches', () => {
                const config = {
                    defaults: { provider: 'codex' },
                    rolePreferences: {
                        architect: { provider: 'gemini', model: 'gemini-3-pro-preview' },
                    },
                };
                const options = {
                    agentRole: 'architect',
                };
                const result = resolveExternalModel(config, options);
                expect(result.provider).toBe('gemini');
                expect(result.model).toBe('gemini-3-pro-preview');
            });
            it('should skip when agentRole is not provided', () => {
                const config = {
                    defaults: { provider: 'codex', codexModel: 'default-codex' },
                    rolePreferences: {
                        architect: { provider: 'gemini', model: 'gemini-3-pro-preview' },
                    },
                };
                const options = {};
                const result = resolveExternalModel(config, options);
                expect(result.model).toBe('default-codex');
            });
            it('should skip when agentRole not found in preferences', () => {
                const config = {
                    defaults: { provider: 'codex', codexModel: 'default-codex' },
                    rolePreferences: {
                        architect: { provider: 'gemini', model: 'gemini-3-pro-preview' },
                    },
                };
                const options = {
                    agentRole: 'unknown-role',
                };
                const result = resolveExternalModel(config, options);
                expect(result.model).toBe('default-codex');
            });
        });
        describe('Precedence 5-7: Default model resolution', () => {
            describe('Precedence 5: defaults.{codexModel,geminiModel}', () => {
                it('should use defaults.codexModel for codex provider', () => {
                    const config = {
                        defaults: {
                            provider: 'codex',
                            codexModel: 'custom-codex-model',
                        },
                    };
                    const options = {};
                    const result = resolveExternalModel(config, options);
                    expect(result.provider).toBe('codex');
                    expect(result.model).toBe('custom-codex-model');
                });
                it('should use defaults.geminiModel for gemini provider', () => {
                    const config = {
                        defaults: {
                            provider: 'gemini',
                            geminiModel: 'custom-gemini-model',
                        },
                    };
                    const options = {};
                    const result = resolveExternalModel(config, options);
                    expect(result.provider).toBe('gemini');
                    expect(result.model).toBe('custom-gemini-model');
                });
                it('should use explicitProvider over config defaults.provider', () => {
                    const config = {
                        defaults: {
                            provider: 'codex',
                            codexModel: 'custom-codex-model',
                        },
                    };
                    const options = {
                        explicitProvider: 'gemini',
                    };
                    const result = resolveExternalModel(config, options);
                    expect(result.provider).toBe('gemini');
                    expect(result.model).toBe('gemini-3-pro-preview'); // hardcoded default
                });
            });
            describe('Precedence 6: Environment variables', () => {
                it('should use OMC_CODEX_DEFAULT_MODEL when set', () => {
                    process.env.OMC_CODEX_DEFAULT_MODEL = 'env-codex-model';
                    const config = {
                        defaults: { provider: 'codex' }, // no codexModel specified
                    };
                    const options = {};
                    const result = resolveExternalModel(config, options);
                    expect(result.provider).toBe('codex');
                    expect(result.model).toBe('env-codex-model');
                });
                it('should use OMC_GEMINI_DEFAULT_MODEL when set', () => {
                    process.env.OMC_GEMINI_DEFAULT_MODEL = 'env-gemini-model';
                    const config = {
                        defaults: { provider: 'gemini' }, // no geminiModel specified
                    };
                    const options = {};
                    const result = resolveExternalModel(config, options);
                    expect(result.provider).toBe('gemini');
                    expect(result.model).toBe('env-gemini-model');
                });
                it('should prefer config defaults over environment variables', () => {
                    process.env.OMC_CODEX_DEFAULT_MODEL = 'env-codex-model';
                    const config = {
                        defaults: {
                            provider: 'codex',
                            codexModel: 'config-codex-model',
                        },
                    };
                    const options = {};
                    const result = resolveExternalModel(config, options);
                    expect(result.model).toBe('config-codex-model');
                });
            });
            describe('Precedence 7: Hardcoded defaults', () => {
                it('should use hardcoded codex default when no other options', () => {
                    const config = {
                        defaults: { provider: 'codex' },
                    };
                    const options = {};
                    const result = resolveExternalModel(config, options);
                    expect(result.provider).toBe('codex');
                    expect(result.model).toBe('gpt-5.3-codex');
                });
                it('should use hardcoded gemini default when no other options', () => {
                    const config = {
                        defaults: { provider: 'gemini' },
                    };
                    const options = {};
                    const result = resolveExternalModel(config, options);
                    expect(result.provider).toBe('gemini');
                    expect(result.model).toBe('gemini-3-pro-preview');
                });
                it('should default to codex provider when none specified', () => {
                    const config = {};
                    const options = {};
                    const result = resolveExternalModel(config, options);
                    expect(result.provider).toBe('codex');
                    expect(result.model).toBe('gpt-5.3-codex');
                });
            });
        });
        describe('Edge cases', () => {
            it('should handle undefined config (backward compatibility)', () => {
                const options = {};
                const result = resolveExternalModel(undefined, options);
                expect(result.provider).toBe('codex');
                expect(result.model).toBe('gpt-5.3-codex');
                expect(result.fallbackPolicy).toEqual(defaultFallbackPolicy);
            });
            it('should handle empty config object', () => {
                const config = {};
                const options = {};
                const result = resolveExternalModel(config, options);
                expect(result.provider).toBe('codex');
                expect(result.model).toBe('gpt-5.3-codex');
            });
            it('should handle unknown agent roles by using defaults', () => {
                const config = {
                    defaults: { provider: 'codex', codexModel: 'default-model' },
                    rolePreferences: {
                        architect: { provider: 'gemini', model: 'gemini-3-pro-preview' },
                    },
                };
                const options = {
                    agentRole: 'unknown-agent-role',
                };
                const result = resolveExternalModel(config, options);
                expect(result.model).toBe('default-model');
            });
            it('should use config fallbackPolicy when provided', () => {
                const customPolicy = {
                    onModelFailure: 'cross_provider',
                    allowCrossProvider: true,
                    crossProviderOrder: ['gemini', 'codex'],
                };
                const config = {
                    defaults: { provider: 'codex' },
                    fallbackPolicy: customPolicy,
                };
                const options = {};
                const result = resolveExternalModel(config, options);
                expect(result.fallbackPolicy).toEqual(customPolicy);
            });
            it('should use role preference even when different from explicitProvider', () => {
                const config = {
                    defaults: { provider: 'codex' },
                    rolePreferences: {
                        designer: { provider: 'gemini', model: 'gemini-3-pro-preview' },
                    },
                };
                const options = {
                    agentRole: 'designer',
                    explicitProvider: 'codex',
                };
                // rolePreferences (precedence 4) is checked regardless of explicitProvider value
                const result = resolveExternalModel(config, options);
                expect(result.provider).toBe('gemini');
                expect(result.model).toBe('gemini-3-pro-preview');
            });
            it('should handle provider-only explicitProvider with matching role preference', () => {
                const config = {
                    defaults: { provider: 'codex' },
                    rolePreferences: {
                        architect: { provider: 'codex', model: 'gpt-5.2-codex' },
                    },
                };
                const options = {
                    agentRole: 'architect',
                    explicitProvider: 'codex',
                };
                const result = resolveExternalModel(config, options);
                expect(result.provider).toBe('codex');
                expect(result.model).toBe('gpt-5.2-codex');
            });
        });
    });
    describe('buildFallbackChain', () => {
        it('should put resolved model first in the chain', () => {
            const chain = buildFallbackChain('codex', 'gpt-5.3-codex');
            expect(chain[0]).toBe('gpt-5.3-codex');
        });
        it('should include all default fallback models for codex', () => {
            const chain = buildFallbackChain('codex', 'gpt-5.3-codex');
            // Should contain all codex fallbacks
            CODEX_MODEL_FALLBACKS.forEach(model => {
                expect(chain).toContain(model);
            });
        });
        it('should include all default fallback models for gemini', () => {
            const chain = buildFallbackChain('gemini', 'gemini-3-pro-preview');
            // Should contain all gemini fallbacks
            GEMINI_MODEL_FALLBACKS.forEach(model => {
                expect(chain).toContain(model);
            });
        });
        it('should not have duplicates when resolved model is in default chain', () => {
            const chain = buildFallbackChain('codex', 'gpt-5.3-codex');
            const uniqueChain = [...new Set(chain)];
            expect(chain).toEqual(uniqueChain);
            expect(chain.length).toBe(CODEX_MODEL_FALLBACKS.length);
        });
        it('should not have duplicates when resolved model is not in default chain', () => {
            const chain = buildFallbackChain('codex', 'custom-codex-model');
            const uniqueChain = [...new Set(chain)];
            expect(chain).toEqual(uniqueChain);
            expect(chain.length).toBe(CODEX_MODEL_FALLBACKS.length + 1);
        });
        it('should handle custom resolved model for gemini', () => {
            const chain = buildFallbackChain('gemini', 'custom-gemini-model');
            expect(chain[0]).toBe('custom-gemini-model');
            expect(chain).toContain('gemini-3-pro-preview');
            expect(chain).toContain('gemini-2.5-flash');
        });
        it('should preserve order with resolved model first then defaults', () => {
            const chain = buildFallbackChain('codex', 'custom-model');
            expect(chain[0]).toBe('custom-model');
            expect(chain[1]).toBe(CODEX_MODEL_FALLBACKS[0]);
            expect(chain[2]).toBe(CODEX_MODEL_FALLBACKS[1]);
        });
        it('should handle undefined config', () => {
            const chain = buildFallbackChain('codex', 'gpt-5.3-codex', undefined);
            expect(chain[0]).toBe('gpt-5.3-codex');
            expect(chain.length).toBeGreaterThan(0);
        });
        it('should handle empty config', () => {
            const chain = buildFallbackChain('codex', 'gpt-5.3-codex', {});
            expect(chain[0]).toBe('gpt-5.3-codex');
            expect(chain.length).toBeGreaterThan(0);
        });
        it('should return correct default chains', () => {
            expect(CODEX_MODEL_FALLBACKS).toEqual([
                'gpt-5.3-codex',
                'gpt-5.3',
                'gpt-5.2-codex',
                'gpt-5.2',
            ]);
            expect(GEMINI_MODEL_FALLBACKS).toEqual([
                'gemini-3-pro-preview',
                'gemini-3-flash-preview',
                'gemini-2.5-pro',
                'gemini-2.5-flash',
            ]);
        });
    });
});
//# sourceMappingURL=external-model-policy.test.js.map