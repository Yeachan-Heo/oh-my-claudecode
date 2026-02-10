/**
 * Integration tests for delegation enforcer
 * Tests the entire flow from hook input to modified output
 *
 * NOTE: These tests are SKIPPED because the delegation enforcer is not yet wired
 * into the hooks bridge. The enforcer module exists but processHook() doesn't
 * call it. These tests will be enabled once the integration is implemented.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { processHook } from '../hooks/bridge.js';
describe.skip('delegation-enforcer integration', () => {
    let originalDebugEnv;
    beforeEach(() => {
        originalDebugEnv = process.env.OMC_DEBUG;
    });
    afterEach(() => {
        if (originalDebugEnv === undefined) {
            delete process.env.OMC_DEBUG;
        }
        else {
            process.env.OMC_DEBUG = originalDebugEnv;
        }
    });
    describe('pre-tool-use hook with Task calls', () => {
        it('injects model parameter for Task call without model', async () => {
            const input = {
                toolName: 'Task',
                toolInput: {
                    description: 'Test task',
                    prompt: 'Do something',
                    subagent_type: 'oh-my-claudecode:executor'
                }
            };
            const result = await processHook('pre-tool-use', input);
            expect(result.continue).toBe(true);
            expect(result.modifiedInput).toBeDefined();
            const modifiedInput = result.modifiedInput;
            expect(modifiedInput.model).toBe('sonnet');
            expect(modifiedInput.description).toBe('Test task');
            expect(modifiedInput.prompt).toBe('Do something');
        });
        it('preserves explicit model parameter', async () => {
            const input = {
                toolName: 'Task',
                toolInput: {
                    description: 'Test task',
                    prompt: 'Do something',
                    subagent_type: 'oh-my-claudecode:executor',
                    model: 'haiku'
                }
            };
            const result = await processHook('pre-tool-use', input);
            expect(result.continue).toBe(true);
            expect(result.modifiedInput).toBeDefined();
            const modifiedInput = result.modifiedInput;
            expect(modifiedInput.model).toBe('haiku');
        });
        it('handles Agent tool name', async () => {
            const input = {
                toolName: 'Agent',
                toolInput: {
                    description: 'Test task',
                    prompt: 'Do something',
                    subagent_type: 'executor-low'
                }
            };
            const result = await processHook('pre-tool-use', input);
            expect(result.continue).toBe(true);
            const modifiedInput = result.modifiedInput;
            expect(modifiedInput.model).toBe('haiku');
        });
        it('does not modify non-agent tools', async () => {
            const input = {
                toolName: 'Bash',
                toolInput: {
                    command: 'ls -la'
                }
            };
            const result = await processHook('pre-tool-use', input);
            expect(result.continue).toBe(true);
            const modifiedInput = result.modifiedInput;
            expect(modifiedInput.command).toBe('ls -la');
            expect(modifiedInput).not.toHaveProperty('model');
        });
        it('works with all agent tiers', async () => {
            const testCases = [
                { agent: 'architect', expectedModel: 'opus' },
                { agent: 'architect-low', expectedModel: 'haiku' },
                { agent: 'executor-high', expectedModel: 'opus' },
                { agent: 'executor-low', expectedModel: 'haiku' },
                { agent: 'designer-high', expectedModel: 'opus' }
            ];
            for (const testCase of testCases) {
                const input = {
                    toolName: 'Task',
                    toolInput: {
                        description: 'Test',
                        prompt: 'Test',
                        subagent_type: testCase.agent
                    }
                };
                const result = await processHook('pre-tool-use', input);
                const modifiedInput = result.modifiedInput;
                expect(modifiedInput.model).toBe(testCase.expectedModel);
            }
        });
        it('does not log warning when OMC_DEBUG not set', async () => {
            delete process.env.OMC_DEBUG;
            const consoleWarnSpy = vi.spyOn(console, 'warn');
            const input = {
                toolName: 'Task',
                toolInput: {
                    description: 'Test',
                    prompt: 'Test',
                    subagent_type: 'executor'
                }
            };
            await processHook('pre-tool-use', input);
            expect(consoleWarnSpy).not.toHaveBeenCalled();
            consoleWarnSpy.mockRestore();
        });
        it('logs warning when OMC_DEBUG=true', async () => {
            process.env.OMC_DEBUG = 'true';
            const consoleWarnSpy = vi.spyOn(console, 'warn');
            const input = {
                toolName: 'Task',
                toolInput: {
                    description: 'Test',
                    prompt: 'Test',
                    subagent_type: 'executor'
                }
            };
            await processHook('pre-tool-use', input);
            expect(consoleWarnSpy).toHaveBeenCalledWith(expect.stringContaining('[OMC] Auto-injecting model'));
            expect(consoleWarnSpy).toHaveBeenCalledWith(expect.stringContaining('sonnet'));
            consoleWarnSpy.mockRestore();
        });
    });
});
//# sourceMappingURL=delegation-enforcer-integration.test.js.map