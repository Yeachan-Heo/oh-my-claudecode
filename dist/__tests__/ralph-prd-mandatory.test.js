import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { detectNoPrdFlag, stripNoPrdFlag, detectCriticModeFlag, stripCriticModeFlag, createRalphLoopHook, readRalphState, findPrdPath, getSessionPrdPath, initPrd, readPrd, writePrd, } from '../hooks/ralph/index.js';
import { getArchitectVerificationPrompt, startVerification, detectArchitectApproval, detectArchitectRejection, } from '../hooks/ralph/verifier.js';
describe('Ralph PRD-Mandatory', () => {
    let testDir;
    beforeEach(() => {
        testDir = join(tmpdir(), `ralph-prd-mandatory-${Date.now()}-${Math.random().toString(36).slice(2)}`);
        mkdirSync(testDir, { recursive: true });
        // Create .omc/state directory for ralph state files
        mkdirSync(join(testDir, '.omc', 'state'), { recursive: true });
    });
    afterEach(() => {
        if (existsSync(testDir)) {
            rmSync(testDir, { recursive: true, force: true });
        }
    });
    // ==========================================================================
    // Prompt Flag Sanitization
    // ==========================================================================
    describe('detectNoPrdFlag', () => {
        it('still detects legacy --no-prd syntax for sanitization', () => {
            expect(detectNoPrdFlag('ralph --no-prd fix this')).toBe(true);
            expect(detectNoPrdFlag('--no-prd fix this bug')).toBe(true);
            expect(detectNoPrdFlag('fix this bug --NO-PRD')).toBe(true);
        });
        it('returns false when the legacy flag is absent', () => {
            expect(detectNoPrdFlag('ralph fix this bug')).toBe(false);
            expect(detectNoPrdFlag('')).toBe(false);
            expect(detectNoPrdFlag('ralph --prd build a todo app')).toBe(false);
        });
    });
    describe('stripNoPrdFlag', () => {
        it('should remove --no-prd and trim', () => {
            expect(stripNoPrdFlag('ralph --no-prd fix this')).toBe('ralph fix this');
        });
        it('should remove --no-prd at start', () => {
            expect(stripNoPrdFlag('--no-prd fix this bug')).toBe('fix this bug');
        });
        it('should remove --no-prd at end', () => {
            expect(stripNoPrdFlag('fix this bug --no-prd')).toBe('fix this bug');
        });
        it('should handle multiple spaces after removal', () => {
            expect(stripNoPrdFlag('ralph  --no-prd  fix')).toBe('ralph fix');
        });
        it('should remove --NO-PRD (case insensitive)', () => {
            expect(stripNoPrdFlag('ralph --NO-PRD fix')).toBe('ralph fix');
        });
        it('should preserve prompt when flag absent', () => {
            expect(stripNoPrdFlag('ralph fix this bug')).toBe('ralph fix this bug');
        });
        it('should handle empty string', () => {
            expect(stripNoPrdFlag('')).toBe('');
        });
    });
    describe('detectCriticModeFlag', () => {
        it('detects --critic=critic', () => {
            expect(detectCriticModeFlag('ralph --critic=critic fix this')).toBe('critic');
        });
        it('detects --critic codex', () => {
            expect(detectCriticModeFlag('ralph --critic codex fix this')).toBe('codex');
        });
        it('returns null for invalid critic mode', () => {
            expect(detectCriticModeFlag('ralph --critic=gemini fix this')).toBeNull();
        });
    });
    describe('stripCriticModeFlag', () => {
        it('removes --critic=critic', () => {
            expect(stripCriticModeFlag('ralph --critic=critic fix this')).toBe('ralph fix this');
        });
        it('removes --critic codex', () => {
            expect(stripCriticModeFlag('ralph --critic codex fix this')).toBe('ralph fix this');
        });
    });
    // ==========================================================================
    // Scaffold Auto-Generation
    // ==========================================================================
    describe('scaffold PRD auto-generation', () => {
        it('should create scaffold prd.json via initPrd', () => {
            expect(findPrdPath(testDir)).toBeNull();
            initPrd(testDir, 'TestProject', 'ralph/feature', 'Build a todo app');
            expect(findPrdPath(testDir)).not.toBeNull();
        });
        it('should create scaffold with single story from prompt', () => {
            initPrd(testDir, 'TestProject', 'ralph/feature', 'Add user authentication');
            const prd = readPrd(testDir);
            expect(prd).not.toBeNull();
            expect(prd.project).toBe('TestProject');
            expect(prd.branchName).toBe('ralph/feature');
            expect(prd.userStories.length).toBe(1);
            expect(prd.userStories[0].id).toBe('US-001');
            expect(prd.userStories[0].passes).toBe(false);
        });
        it('should have default generic acceptance criteria in scaffold', () => {
            initPrd(testDir, 'TestProject', 'main', 'Implement feature X');
            const prd = readPrd(testDir);
            expect(prd.userStories[0].acceptanceCriteria).toContain('Implementation is complete');
            expect(prd.userStories[0].acceptanceCriteria).toContain('Code compiles/runs without errors');
        });
        it('should NOT overwrite existing prd.json', () => {
            const existingPrd = {
                project: 'Existing',
                branchName: 'existing-branch',
                description: 'Pre-existing PRD',
                userStories: [
                    {
                        id: 'US-001',
                        title: 'Existing story',
                        description: 'Already here',
                        acceptanceCriteria: ['Custom criterion'],
                        priority: 1,
                        passes: false,
                    },
                ],
            };
            writePrd(testDir, existingPrd);
            // findPrdPath should return the existing path
            const existingPath = findPrdPath(testDir);
            expect(existingPath).not.toBeNull();
            // Reading should return the pre-existing PRD (not overwritten)
            const prd = readPrd(testDir);
            expect(prd.project).toBe('Existing');
            expect(prd.userStories[0].acceptanceCriteria).toContain('Custom criterion');
        });
    });
    // ==========================================================================
    // PRD Mode Activation in startLoop
    // ==========================================================================
    describe('PRD mode activation in startLoop', () => {
        it('should enable prd_mode when prd.json exists', () => {
            // Create a PRD first
            const prd = {
                project: 'Test',
                branchName: 'test',
                description: 'Test project',
                userStories: [
                    {
                        id: 'US-001',
                        title: 'First story',
                        description: 'Do something',
                        acceptanceCriteria: ['It works'],
                        priority: 1,
                        passes: false,
                        architectVerified: false,
                    },
                ],
            };
            writePrd(testDir, prd);
            // Start ralph loop
            const hook = createRalphLoopHook(testDir);
            hook.startLoop(undefined, 'test prompt');
            // Check state has PRD mode enabled
            const state = readRalphState(testDir);
            expect(state).not.toBeNull();
            expect(state.prd_mode).toBe(true);
        });
        it('should set current_story_id to next incomplete story', () => {
            const prd = {
                project: 'Test',
                branchName: 'test',
                description: 'Test',
                userStories: [
                    {
                        id: 'US-001',
                        title: 'Done',
                        description: '',
                        acceptanceCriteria: [],
                        priority: 1,
                        passes: true,
                        architectVerified: true,
                    },
                    {
                        id: 'US-002',
                        title: 'Next',
                        description: '',
                        acceptanceCriteria: [],
                        priority: 2,
                        passes: false,
                        architectVerified: false,
                    },
                ],
            };
            writePrd(testDir, prd);
            const hook = createRalphLoopHook(testDir);
            hook.startLoop(undefined, 'test prompt');
            const state = readRalphState(testDir);
            expect(state.current_story_id).toBe('US-002');
        });
        it('should create and enable prd_mode when no prd.json exists', () => {
            const hook = createRalphLoopHook(testDir);
            hook.startLoop(undefined, 'test prompt');
            const state = readRalphState(testDir);
            expect(state).not.toBeNull();
            expect(state.prd_mode).toBe(true);
            expect(findPrdPath(testDir)).not.toBeNull();
        });
        it('should ignore legacy --no-prd and still require PRD startup', () => {
            const hook = createRalphLoopHook(testDir);
            const started = hook.startLoop(undefined, 'test prompt --no-prd');
            expect(started).toBe(true);
            const state = readRalphState(testDir);
            expect(state).not.toBeNull();
            expect(state.prd_mode).toBe(true);
            expect(state.prompt).toBe('test prompt');
            expect(findPrdPath(testDir)).not.toBeNull();
        });
        it('creates separate startup PRDs for two sessions in the same project', () => {
            const hook = createRalphLoopHook(testDir);
            expect(hook.startLoop('session-a', 'implement feature A')).toBe(true);
            expect(hook.startLoop('session-b', 'implement feature B')).toBe(true);
            expect(findPrdPath(testDir, 'session-a')).toBe(getSessionPrdPath(testDir, 'session-a'));
            expect(findPrdPath(testDir, 'session-b')).toBe(getSessionPrdPath(testDir, 'session-b'));
            expect(readPrd(testDir, 'session-a')?.description).toBe('implement feature A');
            expect(readPrd(testDir, 'session-b')?.description).toBe('implement feature B');
            expect(readPrd(testDir, 'session-a')?.description).not.toBe(readPrd(testDir, 'session-b')?.description);
        });
        it('should refuse to start when an existing prd.json is invalid', () => {
            const invalidPrdPath = join(testDir, 'prd.json');
            mkdirSync(join(testDir, '.git'), { recursive: true });
            writeFileSync(invalidPrdPath, '{ invalid json');
            const hook = createRalphLoopHook(testDir);
            const started = hook.startLoop(undefined, 'test prompt');
            expect(started).toBe(false);
            expect(readRalphState(testDir)).toBeNull();
        });
    });
    // ==========================================================================
    // Story-Aware Verification
    // ==========================================================================
    describe('story-aware architect verification', () => {
        const baseVerificationState = {
            pending: true,
            completion_claim: 'Task is complete',
            verification_attempts: 0,
            max_verification_attempts: 3,
            requested_at: new Date().toISOString(),
            original_task: 'Build a todo app',
        };
        it('should include acceptance criteria when story is provided', () => {
            const story = {
                id: 'US-001',
                title: 'Add login form',
                description: 'As a user, I want to log in',
                acceptanceCriteria: [
                    'Login form renders with email and password fields',
                    'Submit button calls the auth API',
                    'Error message shown on invalid credentials',
                ],
                priority: 1,
                passes: false,
            };
            const prompt = getArchitectVerificationPrompt(baseVerificationState, story);
            expect(prompt).toContain('US-001');
            expect(prompt).toContain('Add login form');
            expect(prompt).toContain('Login form renders with email and password fields');
            expect(prompt).toContain('Submit button calls the auth API');
            expect(prompt).toContain('Error message shown on invalid credentials');
            expect(prompt).toContain('Verify EACH acceptance criterion');
        });
        it('should fall back to generic prompt when no story provided', () => {
            const prompt = getArchitectVerificationPrompt(baseVerificationState);
            expect(prompt).toContain('Are ALL requirements from the original task met?');
            expect(prompt).toContain('Is the implementation complete, not partial?');
            expect(prompt).not.toContain('Verify EACH acceptance criterion');
            expect(prompt).toContain('concise review summary under 100 words');
        });
        it('should fall back to generic prompt when story is undefined', () => {
            const prompt = getArchitectVerificationPrompt(baseVerificationState, undefined);
            expect(prompt).toContain('Are ALL requirements from the original task met?');
            expect(prompt).not.toContain('Acceptance Criteria to Verify');
        });
        it('should include attempt count', () => {
            const state = { ...baseVerificationState, verification_attempts: 1 };
            const prompt = getArchitectVerificationPrompt(state);
            expect(prompt).toContain('Attempt 2/3');
        });
        it('should include previous architect feedback when rejected', () => {
            const state = {
                ...baseVerificationState,
                architect_feedback: 'Missing error handling in auth module',
            };
            const prompt = getArchitectVerificationPrompt(state);
            expect(prompt).toContain('Missing error handling in auth module');
        });
        it('should support critic verification prompts', () => {
            const prompt = getArchitectVerificationPrompt({
                ...baseVerificationState,
                critic_mode: 'critic',
                request_id: 'req-critic',
            });
            expect(prompt).toContain('[CRITIC VERIFICATION REQUIRED');
            expect(prompt).toContain('Task(subagent_type="critic"');
            expect(prompt).toContain('<ralph-approved critic="critic" request-id="req-critic">VERIFIED_COMPLETE</ralph-approved>');
        });
        it('should support codex verification prompts', () => {
            const prompt = getArchitectVerificationPrompt({
                ...baseVerificationState,
                critic_mode: 'codex',
                request_id: 'req-codex',
            });
            expect(prompt).toContain('[CODEX CRITIC VERIFICATION REQUIRED');
            expect(prompt).toContain('omc ask codex --agent-prompt critic');
            expect(prompt).toContain('<ralph-approved critic="codex" request-id="req-codex">VERIFIED_COMPLETE</ralph-approved>');
        });
        it('detects generic Ralph approval markers', () => {
            expect(detectArchitectApproval('<ralph-approved critic="codex">VERIFIED_COMPLETE</ralph-approved>')).toBe(true);
        });
        it('requires matching correlated approval attributes when expected', () => {
            const staleApproval = '<ralph-approved critic="codex" request-id="old-request" story-id="US-001">VERIFIED_COMPLETE</ralph-approved>';
            const freshApproval = '<ralph-approved critic="codex" request-id="new-request" story-id="US-001">VERIFIED_COMPLETE</ralph-approved>';
            expect(detectArchitectApproval(`${staleApproval}\n${freshApproval}`, { request_id: 'new-request', story_id: 'US-001' })).toBe(true);
            expect(detectArchitectApproval(staleApproval, { request_id: 'new-request', story_id: 'US-001' })).toBe(false);
        });
        it('ignores approval tags embedded inside the verification prompt itself', () => {
            const state = {
                ...baseVerificationState,
                critic_mode: 'codex',
                request_id: 'req-injected',
                story_id: 'US-001',
            };
            const prompt = getArchitectVerificationPrompt(state);
            expect(detectArchitectApproval(prompt, { request_id: 'req-injected', story_id: 'US-001' })).toBe(false);
        });
        it('detects codex-style rejection language', () => {
            const result = detectArchitectRejection('Codex reviewer found issues: Missing tests.');
            expect(result.rejected).toBe(true);
            expect(result.feedback).toContain('Missing tests');
        });
    });
    // ==========================================================================
    // Integration: PRD + Verification
    // ==========================================================================
    describe('integration: PRD-driven verification', () => {
        it('should produce verification prompt with story criteria from prd.json', () => {
            // Setup: create a PRD with specific criteria
            const prd = {
                project: 'IntegrationTest',
                branchName: 'ralph/integration',
                description: 'Integration test project',
                userStories: [
                    {
                        id: 'US-001',
                        title: 'Implement caching',
                        description: 'Add Redis caching to API endpoints',
                        acceptanceCriteria: [
                            'Cache middleware intercepts GET requests',
                            'Cache TTL is configurable via environment variable',
                            'Cache invalidation on POST/PUT/DELETE',
                            'Tests cover all three scenarios',
                        ],
                        priority: 1,
                        passes: false,
                        architectVerified: false,
                    },
                    {
                        id: 'US-002',
                        title: 'Add metrics',
                        description: 'Cache hit/miss metrics',
                        acceptanceCriteria: ['Prometheus endpoint exposes cache metrics'],
                        priority: 2,
                        passes: false,
                        architectVerified: false,
                    },
                ],
            };
            writePrd(testDir, prd);
            // Simulate: start ralph, which enables PRD mode
            const hook = createRalphLoopHook(testDir);
            hook.startLoop(undefined, 'Implement caching with metrics');
            // Simulate: start verification for the current story
            const verificationState = startVerification(testDir, 'Caching is implemented', 'Implement caching with metrics');
            // Generate verification prompt with the current story (US-001)
            const currentStory = prd.userStories[0];
            const prompt = getArchitectVerificationPrompt(verificationState, currentStory);
            // Verify the prompt includes ALL acceptance criteria from US-001
            expect(prompt).toContain('Cache middleware intercepts GET requests');
            expect(prompt).toContain('Cache TTL is configurable via environment variable');
            expect(prompt).toContain('Cache invalidation on POST/PUT/DELETE');
            expect(prompt).toContain('Tests cover all three scenarios');
            expect(prompt).toContain('Implement caching');
            expect(prompt).toContain('US-001');
            expect(prompt).toContain('Verify EACH acceptance criterion');
        });
        it('stores selected critic mode in Ralph state', () => {
            const hook = createRalphLoopHook(testDir);
            hook.startLoop(undefined, 'Implement caching', { criticMode: 'codex' });
            const state = readRalphState(testDir);
            expect(state?.critic_mode).toBe('codex');
        });
        it('scaffold PRD creates valid structure that getPrdStatus can read', () => {
            // Auto-generate scaffold
            initPrd(testDir, 'Scaffold', 'main', 'Build a widget');
            const prd = readPrd(testDir);
            expect(prd).not.toBeNull();
            // Verify structure is valid for getPrdStatus
            expect(prd.userStories).toBeDefined();
            expect(Array.isArray(prd.userStories)).toBe(true);
            expect(prd.userStories.length).toBeGreaterThan(0);
            expect(prd.userStories[0].passes).toBe(false);
            expect(prd.userStories[0].acceptanceCriteria).toBeDefined();
            expect(Array.isArray(prd.userStories[0].acceptanceCriteria)).toBe(true);
        });
    });
});
//# sourceMappingURL=ralph-prd-mandatory.test.js.map