/**
 * Bridge Routing Matrix Tests
 *
 * Tests that processHook routes each HookType correctly, handles
 * invalid/unknown types gracefully, validates input normalization,
 * and respects the OMC_SKIP_HOOKS env kill-switch.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { execFileSync } from 'child_process';
import * as autoUpdate from '../../features/auto-update.js';
import { processHook, resetSkipHooksCache, requiredKeysForHook, } from '../bridge.js';
// ============================================================================
// Hook Routing Tests
// ============================================================================
describe('processHook - Routing Matrix', () => {
    const originalEnv = process.env;
    beforeEach(() => {
        process.env = { ...originalEnv };
        delete process.env.DISABLE_OMC;
        delete process.env.OMC_SKIP_HOOKS;
        vi.spyOn(autoUpdate, 'isLowTierAgentsEnabled').mockReturnValue(true);
        resetSkipHooksCache();
    });
    afterEach(() => {
        vi.restoreAllMocks();
        process.env = originalEnv;
        resetSkipHooksCache();
    });
    // --------------------------------------------------------------------------
    // Route each HookType to a handler and confirm a valid HookOutput shape
    // --------------------------------------------------------------------------
    describe('HookType routing', () => {
        const baseInput = {
            sessionId: 'test-session',
            prompt: 'test prompt',
            directory: '/tmp/test-routing',
        };
        const hookTypes = [
            'keyword-detector',
            'stop-continuation',
            'ralph',
            'persistent-mode',
            'session-start',
            'session-end',
            'pre-tool-use',
            'post-tool-use',
            'autopilot',
            'subagent-start',
            'subagent-stop',
            'pre-compact',
            'setup-init',
            'setup-maintenance',
            'permission-request',
        ];
        for (const hookType of hookTypes) {
            it(`should route "${hookType}" and return a valid HookOutput`, async () => {
                const result = await processHook(hookType, baseInput);
                // Every hook must return an object with a boolean "continue" field
                expect(result).toBeDefined();
                expect(typeof result.continue).toBe('boolean');
                // Optional fields, if present, must be the right type
                if (result.message !== undefined) {
                    expect(typeof result.message).toBe('string');
                }
                if (result.reason !== undefined) {
                    expect(typeof result.reason).toBe('string');
                }
            });
        }
        it('should handle keyword-detector with a keyword prompt', async () => {
            const input = {
                sessionId: 'test-session',
                prompt: 'ultrawork this task',
                directory: '/tmp/test-routing',
            };
            const result = await processHook('keyword-detector', input);
            expect(result.continue).toBe(true);
            // Should detect the keyword and return a message
            expect(result.message).toBeDefined();
            expect(typeof result.message).toBe('string');
        });
        it('should handle keyword-detector with no keyword prompt', async () => {
            const input = {
                sessionId: 'test-session',
                prompt: 'just a regular message',
                directory: '/tmp/test-routing',
            };
            const result = await processHook('keyword-detector', input);
            expect(result.continue).toBe(true);
            // No keyword detected, so no message
            expect(result.message).toBeUndefined();
        });
        it('should handle pre-tool-use with Bash tool input', async () => {
            const input = {
                sessionId: 'test-session',
                toolName: 'Bash',
                toolInput: { command: 'ls -la' },
                directory: '/tmp/test-routing',
            };
            const result = await processHook('pre-tool-use', input);
            expect(result.continue).toBe(true);
        });
        it('should rewrite low-tier Task agent to base tier when low-tier agents are disabled', async () => {
            vi.spyOn(autoUpdate, 'isLowTierAgentsEnabled').mockReturnValue(false);
            const input = {
                sessionId: 'test-session',
                toolName: 'Task',
                toolInput: {
                    subagent_type: 'oh-my-claudecode:executor-low',
                    model: 'haiku',
                    description: 'test',
                    prompt: 'test',
                },
                directory: '/tmp/test-routing',
            };
            const result = await processHook('pre-tool-use', input);
            expect(result.continue).toBe(true);
            expect(result.modifiedInput).toBeDefined();
            const modifiedInput = result.modifiedInput;
            expect(modifiedInput.subagent_type).toBe('oh-my-claudecode:executor');
            expect(modifiedInput.model).toBe('sonnet');
        });
        it('should handle post-tool-use with tool output', async () => {
            const input = {
                sessionId: 'test-session',
                toolName: 'Bash',
                toolInput: { command: 'echo hello' },
                toolOutput: 'hello',
                directory: '/tmp/test-routing',
            };
            const result = await processHook('post-tool-use', input);
            expect(result.continue).toBe(true);
        });
        it('should activate ralph and linked ultrawork when Skill tool invokes ralph', async () => {
            const tempDir = mkdtempSync(join(tmpdir(), 'bridge-routing-ralph-'));
            try {
                execFileSync('git', ['init'], { cwd: tempDir, stdio: 'pipe' });
                const sessionId = 'test-session';
                const input = {
                    sessionId,
                    toolName: 'Skill',
                    toolInput: { skill: 'oh-my-claudecode:ralph' },
                    directory: tempDir,
                };
                const result = await processHook('post-tool-use', input);
                expect(result.continue).toBe(true);
                const ralphPath = join(tempDir, '.omc', 'state', 'sessions', sessionId, 'ralph-state.json');
                const ultraworkPath = join(tempDir, '.omc', 'state', 'sessions', sessionId, 'ultrawork-state.json');
                expect(existsSync(ralphPath)).toBe(true);
                expect(existsSync(ultraworkPath)).toBe(true);
                const ralphState = JSON.parse(readFileSync(ralphPath, 'utf-8'));
                const ultraworkState = JSON.parse(readFileSync(ultraworkPath, 'utf-8'));
                expect(ralphState.active).toBe(true);
                expect(ralphState.linked_ultrawork).toBe(true);
                expect(ultraworkState.active).toBe(true);
                expect(ultraworkState.linked_to_ralph).toBe(true);
            }
            finally {
                rmSync(tempDir, { recursive: true, force: true });
            }
        });
        it('should handle session-start and return continue:true', async () => {
            const input = {
                sessionId: 'test-session',
                directory: '/tmp/test-routing',
            };
            const result = await processHook('session-start', input);
            expect(result.continue).toBe(true);
        });
        it('should handle stop-continuation and always return continue:true', async () => {
            const input = {
                sessionId: 'test-session',
                directory: '/tmp/test-routing',
            };
            const result = await processHook('stop-continuation', input);
            expect(result.continue).toBe(true);
        });
    });
    // --------------------------------------------------------------------------
    // Invalid / unknown hook types
    // --------------------------------------------------------------------------
    describe('invalid hook types', () => {
        it('should return continue:true for unknown hook type', async () => {
            const input = {
                sessionId: 'test-session',
                prompt: 'test',
                directory: '/tmp/test-routing',
            };
            // Cast to HookType to simulate an unknown type
            const result = await processHook('nonexistent-hook', input);
            expect(result).toEqual({ continue: true });
        });
        it('should return continue:true for empty string hook type', async () => {
            const input = {
                sessionId: 'test-session',
                directory: '/tmp/test-routing',
            };
            const result = await processHook('', input);
            expect(result).toEqual({ continue: true });
        });
    });
    // --------------------------------------------------------------------------
    // Input normalization (snake_case -> camelCase)
    // --------------------------------------------------------------------------
    describe('input normalization', () => {
        it('should normalize snake_case tool_name to camelCase toolName', async () => {
            // Send snake_case input (as Claude Code would)
            const rawInput = {
                session_id: 'test-session',
                tool_name: 'Bash',
                tool_input: { command: 'echo hi' },
                cwd: '/tmp/test-routing',
            };
            const result = await processHook('pre-tool-use', rawInput);
            // Should not crash - normalization handled the field mapping
            expect(result).toBeDefined();
            expect(typeof result.continue).toBe('boolean');
        });
        it('should normalize cwd to directory', async () => {
            const rawInput = {
                session_id: 'test-session',
                cwd: '/tmp/test-routing',
                prompt: 'hello',
            };
            const result = await processHook('keyword-detector', rawInput);
            expect(result).toBeDefined();
            expect(result.continue).toBe(true);
        });
        it('should normalize tool_response to toolOutput', async () => {
            const rawInput = {
                session_id: 'test-session',
                tool_name: 'Read',
                tool_input: { file_path: '/tmp/test.ts' },
                tool_response: 'file contents here',
                cwd: '/tmp/test-routing',
            };
            const result = await processHook('post-tool-use', rawInput);
            expect(result).toBeDefined();
            expect(typeof result.continue).toBe('boolean');
        });
        it('should handle already-camelCase input without breaking', async () => {
            const input = {
                sessionId: 'test-session',
                toolName: 'Bash',
                toolInput: { command: 'ls' },
                directory: '/tmp/test-routing',
            };
            const result = await processHook('pre-tool-use', input);
            expect(result).toBeDefined();
            expect(typeof result.continue).toBe('boolean');
        });
        it('should handle empty/null input gracefully', async () => {
            const result = await processHook('keyword-detector', {});
            expect(result).toBeDefined();
            expect(result.continue).toBe(true);
        });
        it('should handle null input without crashing', async () => {
            const result = await processHook('keyword-detector', null);
            expect(result).toBeDefined();
            expect(result.continue).toBe(true);
        });
    });
    // --------------------------------------------------------------------------
    // OMC_SKIP_HOOKS environment variable
    // --------------------------------------------------------------------------
    describe('OMC_SKIP_HOOKS kill-switch', () => {
        it('should skip a specific hook type when listed', async () => {
            process.env.OMC_SKIP_HOOKS = 'keyword-detector';
            const input = {
                sessionId: 'test-session',
                prompt: 'ultrawork this',
                directory: '/tmp/test-routing',
            };
            const result = await processHook('keyword-detector', input);
            // Should be skipped - no message, just continue
            expect(result).toEqual({ continue: true });
        });
        it('should not skip hooks not in the list', async () => {
            process.env.OMC_SKIP_HOOKS = 'keyword-detector';
            const input = {
                sessionId: 'test-session',
                prompt: 'test',
                directory: '/tmp/test-routing',
            };
            const result = await processHook('stop-continuation', input);
            expect(result.continue).toBe(true);
        });
        it('should skip multiple comma-separated hooks', async () => {
            process.env.OMC_SKIP_HOOKS = 'keyword-detector,pre-tool-use,post-tool-use';
            const input = {
                sessionId: 'test-session',
                toolName: 'Bash',
                toolInput: { command: 'ls' },
                directory: '/tmp/test-routing',
            };
            const keywordResult = await processHook('keyword-detector', input);
            const preToolResult = await processHook('pre-tool-use', input);
            const postToolResult = await processHook('post-tool-use', input);
            expect(keywordResult).toEqual({ continue: true });
            expect(preToolResult).toEqual({ continue: true });
            expect(postToolResult).toEqual({ continue: true });
        });
        it('should handle whitespace around hook names', async () => {
            process.env.OMC_SKIP_HOOKS = ' keyword-detector , pre-tool-use ';
            const input = {
                sessionId: 'test-session',
                prompt: 'ultrawork',
                directory: '/tmp/test-routing',
            };
            const result = await processHook('keyword-detector', input);
            expect(result).toEqual({ continue: true });
        });
        it('should process normally with empty OMC_SKIP_HOOKS', async () => {
            process.env.OMC_SKIP_HOOKS = '';
            const input = {
                sessionId: 'test-session',
                prompt: 'hello world',
                directory: '/tmp/test-routing',
            };
            const result = await processHook('keyword-detector', input);
            expect(result.continue).toBe(true);
        });
    });
    // --------------------------------------------------------------------------
    // DISABLE_OMC env kill-switch
    // --------------------------------------------------------------------------
    describe('DISABLE_OMC kill-switch', () => {
        it('should return continue:true for all hooks when DISABLE_OMC=1', async () => {
            process.env.DISABLE_OMC = '1';
            const input = {
                sessionId: 'test-session',
                prompt: 'ultrawork this',
                directory: '/tmp/test-routing',
            };
            const result = await processHook('keyword-detector', input);
            expect(result).toEqual({ continue: true });
        });
        it('should return continue:true when DISABLE_OMC=true', async () => {
            process.env.DISABLE_OMC = 'true';
            const input = {
                sessionId: 'test-session',
                prompt: 'test',
                directory: '/tmp/test-routing',
            };
            const result = await processHook('pre-tool-use', input);
            expect(result).toEqual({ continue: true });
        });
        it('should process normally when DISABLE_OMC=false', async () => {
            process.env.DISABLE_OMC = 'false';
            const input = {
                sessionId: 'test-session',
                prompt: 'hello world',
                directory: '/tmp/test-routing',
            };
            const result = await processHook('keyword-detector', input);
            // Should process normally (not disabled)
            expect(result.continue).toBe(true);
        });
        it('DISABLE_OMC takes precedence over OMC_SKIP_HOOKS', async () => {
            process.env.DISABLE_OMC = '1';
            process.env.OMC_SKIP_HOOKS = 'keyword-detector';
            const input = {
                sessionId: 'test-session',
                prompt: 'ultrawork',
                directory: '/tmp/test-routing',
            };
            const result = await processHook('keyword-detector', input);
            expect(result).toEqual({ continue: true });
        });
    });
    // --------------------------------------------------------------------------
    // Error handling
    // --------------------------------------------------------------------------
    describe('error resilience', () => {
        it('should catch errors and return continue:true', async () => {
            // Suppress console.error for this test
            const spy = vi.spyOn(console, 'error').mockImplementation(() => { });
            // subagent-start requires specific fields - sending bad input may trigger error path
            const input = {
                sessionId: 'test-session',
                directory: '/tmp/nonexistent-test-dir-12345',
            };
            const result = await processHook('autopilot', input);
            // Should not crash, should return continue:true
            expect(result.continue).toBe(true);
            spy.mockRestore();
        });
    });
    // --------------------------------------------------------------------------
    // Regression: camelCase validation after normalization (PR #512 fix)
    // --------------------------------------------------------------------------
    describe('camelCase validation after normalization', () => {
        const affectedHooks = [
            'session-end',
            'subagent-start',
            'subagent-stop',
            'pre-compact',
            'setup-init',
            'setup-maintenance',
        ];
        for (const hookType of affectedHooks) {
            it(`"${hookType}" should pass validation with camelCase input (post-normalization)`, async () => {
                // Suppress console.error from lazy-load failures in non-existent dirs
                const spy = vi.spyOn(console, 'error').mockImplementation(() => { });
                // camelCase input (as produced by normalizeHookInput)
                const input = {
                    sessionId: 'test-session-abc',
                    directory: '/tmp/test-routing',
                    toolName: 'Bash',
                };
                const result = await processHook(hookType, input);
                // Should NOT silently fail validation — it should reach the handler
                // (handler may still return continue:true due to missing state files, which is fine)
                expect(result).toBeDefined();
                expect(typeof result.continue).toBe('boolean');
                // The key assertion: validation should NOT log a "missing keys" error
                // for sessionId/directory since they are present in camelCase
                const missingKeysLogs = spy.mock.calls.filter((args) => typeof args[0] === 'string' && args[0].includes('missing keys'));
                expect(missingKeysLogs).toHaveLength(0);
                spy.mockRestore();
            });
        }
        it('"permission-request" should pass validation with camelCase input including toolName', async () => {
            const spy = vi.spyOn(console, 'error').mockImplementation(() => { });
            const input = {
                sessionId: 'test-session-abc',
                directory: '/tmp/test-routing',
                toolName: 'Bash',
            };
            const result = await processHook('permission-request', input);
            expect(result).toBeDefined();
            expect(typeof result.continue).toBe('boolean');
            const missingKeysLogs = spy.mock.calls.filter((args) => typeof args[0] === 'string' && args[0].includes('missing keys'));
            expect(missingKeysLogs).toHaveLength(0);
            spy.mockRestore();
        });
        it('should fail validation when required camelCase keys are missing', async () => {
            const spy = vi.spyOn(console, 'error').mockImplementation(() => { });
            // Missing sessionId and directory
            const input = { prompt: 'hello' };
            const result = await processHook('session-end', input);
            expect(result).toEqual({ continue: true });
            // Should have logged the missing keys
            const missingKeysLogs = spy.mock.calls.filter((args) => typeof args[0] === 'string' && args[0].includes('missing keys'));
            expect(missingKeysLogs.length).toBeGreaterThan(0);
            spy.mockRestore();
        });
        it('snake_case input should be normalized and pass validation', async () => {
            const spy = vi.spyOn(console, 'error').mockImplementation(() => { });
            // Raw snake_case input as Claude Code would send
            const rawInput = {
                session_id: 'test-session-xyz',
                cwd: '/tmp/test-routing',
                tool_name: 'Read',
            };
            const result = await processHook('session-end', rawInput);
            expect(result).toBeDefined();
            expect(typeof result.continue).toBe('boolean');
            // normalizeHookInput converts session_id→sessionId, cwd→directory
            // so validation against camelCase keys should succeed
            const missingKeysLogs = spy.mock.calls.filter((args) => typeof args[0] === 'string' && args[0].includes('missing keys'));
            expect(missingKeysLogs).toHaveLength(0);
            spy.mockRestore();
        });
    });
    // --------------------------------------------------------------------------
    // Regression: requiredKeysForHook helper
    // --------------------------------------------------------------------------
    describe('requiredKeysForHook', () => {
        it('should return camelCase keys for session-end', () => {
            expect(requiredKeysForHook('session-end')).toEqual(['sessionId', 'directory']);
        });
        it('should return camelCase keys for subagent-start', () => {
            expect(requiredKeysForHook('subagent-start')).toEqual(['sessionId', 'directory']);
        });
        it('should return camelCase keys for subagent-stop', () => {
            expect(requiredKeysForHook('subagent-stop')).toEqual(['sessionId', 'directory']);
        });
        it('should return camelCase keys for pre-compact', () => {
            expect(requiredKeysForHook('pre-compact')).toEqual(['sessionId', 'directory']);
        });
        it('should return camelCase keys for setup-init', () => {
            expect(requiredKeysForHook('setup-init')).toEqual(['sessionId', 'directory']);
        });
        it('should return camelCase keys for setup-maintenance', () => {
            expect(requiredKeysForHook('setup-maintenance')).toEqual(['sessionId', 'directory']);
        });
        it('should return camelCase keys with toolName for permission-request', () => {
            expect(requiredKeysForHook('permission-request')).toEqual(['sessionId', 'directory', 'toolName']);
        });
        it('should return empty array for unknown hook type', () => {
            expect(requiredKeysForHook('unknown-hook')).toEqual([]);
        });
    });
    // --------------------------------------------------------------------------
    // Regression: autopilot session isolation (sessionId threading)
    // --------------------------------------------------------------------------
    describe('autopilot session threading', () => {
        it('should pass sessionId to readAutopilotState for session isolation', async () => {
            const spy = vi.spyOn(console, 'error').mockImplementation(() => { });
            // With a sessionId, the autopilot handler should thread it to readAutopilotState
            // Since no state file exists, it returns continue:true — but it should not crash
            const input = {
                sessionId: 'isolated-session-123',
                directory: '/tmp/test-routing-autopilot',
            };
            const result = await processHook('autopilot', input);
            expect(result.continue).toBe(true);
            spy.mockRestore();
        });
        it('should handle autopilot without sessionId gracefully', async () => {
            const spy = vi.spyOn(console, 'error').mockImplementation(() => { });
            const input = {
                directory: '/tmp/test-routing-autopilot',
            };
            const result = await processHook('autopilot', input);
            expect(result.continue).toBe(true);
            spy.mockRestore();
        });
    });
    // --------------------------------------------------------------------------
    // Unknown hook types still return continue:true
    // --------------------------------------------------------------------------
    describe('unknown hook types (regression)', () => {
        it('should return continue:true for completely unknown hook type', async () => {
            const input = {
                sessionId: 'test-session',
                directory: '/tmp/test-routing',
            };
            const result = await processHook('totally-unknown-hook-xyz', input);
            expect(result).toEqual({ continue: true });
        });
    });
});
//# sourceMappingURL=bridge-routing.test.js.map