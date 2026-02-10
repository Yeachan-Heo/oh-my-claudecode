import { describe, it, expect } from 'vitest';
import { getExpansionPrompt, getDirectPlanningPrompt, getExecutionPrompt, getQAPrompt, getValidationPrompt, getPhasePrompt } from '../prompts.js';
describe('Prompt Generation', () => {
    describe('getExpansionPrompt', () => {
        it('should include user idea', () => {
            const prompt = getExpansionPrompt('build a CLI tool');
            expect(prompt).toContain('build a CLI tool');
        });
        it('should include analyst Task invocation', () => {
            const prompt = getExpansionPrompt('test');
            expect(prompt).toContain('oh-my-claudecode:analyst');
        });
        it('should include architect Task invocation', () => {
            const prompt = getExpansionPrompt('test');
            expect(prompt).toContain('oh-my-claudecode:architect');
        });
    });
    describe('getDirectPlanningPrompt', () => {
        it('should reference spec path', () => {
            const prompt = getDirectPlanningPrompt('/path/to/spec.md');
            expect(prompt).toContain('/path/to/spec.md');
        });
        it('should use direct planning mode without user interview', () => {
            const prompt = getDirectPlanningPrompt('spec.md');
            // Direct mode means no interview with user - spec is already complete
            expect(prompt).toContain('DIRECT PLANNING');
            expect(prompt).toContain('no interview needed');
        });
        it('should include critic Task for validation', () => {
            const prompt = getDirectPlanningPrompt('spec.md');
            expect(prompt).toContain('oh-my-claudecode:critic');
        });
    });
    describe('getExecutionPrompt', () => {
        it('should reference plan path', () => {
            const prompt = getExecutionPrompt('/path/to/plan.md');
            expect(prompt).toContain('/path/to/plan.md');
        });
        it('should specify Ralph+Ultrawork activation', () => {
            const prompt = getExecutionPrompt('plan.md');
            expect(prompt).toContain('Ralph');
            expect(prompt).toContain('Ultrawork');
        });
    });
    describe('getQAPrompt', () => {
        it('should specify build/lint/test sequence', () => {
            const prompt = getQAPrompt();
            expect(prompt).toContain('Build');
            expect(prompt).toContain('Lint');
            expect(prompt).toContain('Test');
        });
    });
    describe('getValidationPrompt', () => {
        it('should specify parallel architect spawns', () => {
            const prompt = getValidationPrompt('spec.md');
            expect(prompt).toContain('parallel');
        });
        it('should include all three validation types', () => {
            const prompt = getValidationPrompt('spec.md');
            expect(prompt).toContain('Functional');
            expect(prompt).toContain('Security');
            expect(prompt).toContain('Quality');
        });
    });
    describe('getPhasePrompt', () => {
        it('should dispatch to correct phase', () => {
            const expansion = getPhasePrompt('expansion', { idea: 'test' });
            expect(expansion).toContain('EXPANSION');
            const qa = getPhasePrompt('qa', {});
            expect(qa).toContain('QA');
        });
    });
});
//# sourceMappingURL=prompts.test.js.map