import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execSync } from 'child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { checkPersistentModes } from '../index.js';
import { writePrd } from '../../ralph/prd.js';
describe('Ralph verification flow', () => {
    let testDir;
    let claudeConfigDir;
    let originalClaudeConfigDir;
    beforeEach(() => {
        testDir = join(tmpdir(), `ralph-verification-flow-${Date.now()}-${Math.random().toString(36).slice(2)}`);
        claudeConfigDir = join(testDir, '.fake-claude');
        mkdirSync(testDir, { recursive: true });
        mkdirSync(claudeConfigDir, { recursive: true });
        execSync('git init', { cwd: testDir });
        originalClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
        process.env.CLAUDE_CONFIG_DIR = claudeConfigDir;
    });
    afterEach(() => {
        if (originalClaudeConfigDir === undefined) {
            delete process.env.CLAUDE_CONFIG_DIR;
        }
        else {
            process.env.CLAUDE_CONFIG_DIR = originalClaudeConfigDir;
        }
        if (existsSync(testDir)) {
            rmSync(testDir, { recursive: true, force: true });
        }
    });
    function writeRalphState(sessionId, extra = {}) {
        const sessionDir = join(testDir, '.omc', 'state', 'sessions', sessionId);
        mkdirSync(sessionDir, { recursive: true });
        writeFileSync(join(sessionDir, 'ralph-state.json'), JSON.stringify({
            active: true,
            iteration: 4,
            max_iterations: 10,
            session_id: sessionId,
            started_at: new Date().toISOString(),
            prompt: 'Implement issue #1496',
            ...extra,
        }));
    }
    it('enters verification instead of completing immediately when PRD is done', async () => {
        const sessionId = 'ralph-prd-complete';
        const prd = {
            project: 'Test',
            branchName: 'ralph/test',
            description: 'Test PRD',
            userStories: [{
                    id: 'US-001',
                    title: 'Done',
                    description: 'All work complete',
                    acceptanceCriteria: ['Feature is implemented'],
                    priority: 1,
                    passes: true,
                }],
        };
        writePrd(testDir, prd);
        writeRalphState(sessionId, { critic_mode: 'codex' });
        const result = await checkPersistentModes(sessionId, testDir);
        expect(result.shouldBlock).toBe(true);
        expect(result.mode).toBe('ralph');
        expect(result.message).toContain('CODEX CRITIC VERIFICATION REQUIRED');
        expect(result.message).toContain('omc ask codex --agent-prompt critic');
    });
    it('completes Ralph after generic approval marker is seen in transcript', async () => {
        const sessionId = 'ralph-approved';
        const sessionDir = join(testDir, '.omc', 'state', 'sessions', sessionId);
        mkdirSync(sessionDir, { recursive: true });
        writeRalphState(sessionId);
        writeFileSync(join(sessionDir, 'ralph-verification-state.json'), JSON.stringify({
            pending: true,
            completion_claim: 'All stories are complete',
            verification_attempts: 0,
            max_verification_attempts: 3,
            requested_at: new Date().toISOString(),
            original_task: 'Implement issue #1496',
            critic_mode: 'critic',
        }));
        const transcriptDir = join(claudeConfigDir, 'sessions', sessionId);
        mkdirSync(transcriptDir, { recursive: true });
        writeFileSync(join(transcriptDir, 'transcript.md'), '<ralph-approved critic="critic">VERIFIED_COMPLETE</ralph-approved>');
        const result = await checkPersistentModes(sessionId, testDir);
        expect(result.shouldBlock).toBe(false);
        expect(result.message).toContain('Critic verified task completion');
    });
});
//# sourceMappingURL=ralph-verification-flow.test.js.map