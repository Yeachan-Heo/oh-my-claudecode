/**
 * Tests for fresh-context ralph prompt generation
 */

import { describe, it, expect } from 'vitest';
import { generateIterationPrompt } from '../fresh-prompt.js';
import type { RalphFreshHandoff } from '../fresh-handoff.js';

// Helper to create minimal valid handoff
function createHandoff(overrides: Partial<RalphFreshHandoff>): RalphFreshHandoff {
  return {
    version: '1.0',
    created_at: new Date().toISOString(),
    iteration: 1,
    max_iterations: 10,
    original_prompt: 'Test task',
    completion_promise: 'TASK_COMPLETE',
    completed: false,
    progress: {
      patterns: [],
      recentLearnings: []
    },
    git: {
      recentCommits: [],
      branch: 'main',
      hasUncommittedChanges: false
    },
    stuckDetection: {
      lastPrdStatus: [],
      iterationsOnSameStory: 0
    },
    ...overrides
  };
}

describe('generateIterationPrompt', () => {
  it('should generate prompt with basic iteration info', () => {
    const handoff = createHandoff({
      iteration: 3,
      max_iterations: 10,
      original_prompt: 'Build a todo app',
      completion_promise: 'TASK_COMPLETE'
    });

    const prompt = generateIterationPrompt(handoff);

    expect(prompt).toContain('# Ralph Fresh Context - Iteration 3/10');
    expect(prompt).toContain('Build a todo app');
    expect(prompt).toContain('<promise>TASK_COMPLETE</promise>');
  });

  it('should include PRD status when available', () => {
    const handoff = createHandoff({
      iteration: 2,
      max_iterations: 10,
      original_prompt: 'Build a todo app',
      completion_promise: 'DONE',
      prd: {
        project: 'Todo App',
        branchName: 'feature/todo',
        description: 'A todo app',
        storiesTotal: 5,
        storiesCompleted: 2,
        nextStoryId: 'US-003',
        incompleteIds: ['US-003', 'US-004', 'US-005']
      },
      git: {
        recentCommits: [
          { hash: 'abc123', message: 'feat: add user model' }
        ],
        branch: 'feature/todo',
        hasUncommittedChanges: false
      }
    });

    const prompt = generateIterationPrompt(handoff);

    expect(prompt).toContain('**Project**: Todo App');
    expect(prompt).toContain('**Progress**: 2/5 stories complete');
    expect(prompt).toContain('**Next Story**: US-003');
    expect(prompt).toContain('**Remaining**: US-003, US-004, US-005');
  });

  it('should show free-form mode when no PRD', () => {
    const handoff = createHandoff({
      iteration: 1,
      max_iterations: 5,
      original_prompt: 'Quick fix',
      completion_promise: 'DONE'
    });

    const prompt = generateIterationPrompt(handoff);

    expect(prompt).toContain('No PRD found. Working in free-form mode.');
  });

  it('should include git history', () => {
    const handoff = createHandoff({
      iteration: 2,
      max_iterations: 10,
      original_prompt: 'Build features',
      completion_promise: 'DONE',
      git: {
        recentCommits: [
          { hash: 'abc123', message: 'feat: add authentication' },
          { hash: 'def456', message: 'fix: update validation' }
        ],
        branch: 'main',
        hasUncommittedChanges: true
      }
    });

    const prompt = generateIterationPrompt(handoff);

    expect(prompt).toContain('### Recent Git History');
    expect(prompt).toContain('- `abc123`: feat: add authentication');
    expect(prompt).toContain('- `def456`: fix: update validation');
    expect(prompt).toContain('⚠️ **WARNING**: There are uncommitted changes');
  });

  it('should include patterns learned', () => {
    const handoff = createHandoff({
      iteration: 3,
      max_iterations: 10,
      original_prompt: 'Build system',
      completion_promise: 'DONE',
      progress: {
        patterns: [
          'All tests are in __tests__ directories',
          'Use TypeScript strict mode'
        ],
        recentLearnings: []
      }
    });

    const prompt = generateIterationPrompt(handoff);

    expect(prompt).toContain('### Patterns Learned');
    expect(prompt).toContain('- All tests are in __tests__ directories');
    expect(prompt).toContain('- Use TypeScript strict mode');
  });

  it('should include recent learnings', () => {
    const handoff = createHandoff({
      iteration: 4,
      max_iterations: 10,
      original_prompt: 'Complete tasks',
      completion_promise: 'DONE',
      progress: {
        patterns: [],
        recentLearnings: [
          'Need to run npm install after package changes',
          'Tests must be run before committing'
        ]
      }
    });

    const prompt = generateIterationPrompt(handoff);

    expect(prompt).toContain('### Recent Learnings');
    expect(prompt).toContain('- Need to run npm install after package changes');
    expect(prompt).toContain('- Tests must be run before committing');
  });

  it('should show stuck detection warning', () => {
    const handoff = createHandoff({
      iteration: 5,
      max_iterations: 10,
      original_prompt: 'Build feature',
      completion_promise: 'DONE',
      prd: {
        project: 'My Project',
        branchName: 'feature/test',
        description: 'Test project',
        storiesTotal: 3,
        storiesCompleted: 1,
        nextStoryId: 'US-002',
        incompleteIds: ['US-002', 'US-003']
      },
      stuckDetection: {
        lastPrdStatus: ['US-002'],
        iterationsOnSameStory: 3
      }
    });

    const prompt = generateIterationPrompt(handoff);

    expect(prompt).toContain('## Stuck Detection');
    expect(prompt).toContain("You've been on story US-002 for 3 iterations");
    expect(prompt).toContain('Is there a blocker?');
  });

  it('should include last error when present', () => {
    const handoff = createHandoff({
      iteration: 3,
      max_iterations: 10,
      original_prompt: 'Fix bugs',
      completion_promise: 'DONE',
      lastError: {
        iteration: 2,
        message: 'Build failed: TypeScript errors',
        recoveryAttempt: 'Fixed type definitions'
      }
    });

    const prompt = generateIterationPrompt(handoff);

    expect(prompt).toContain('## Previous Error (Iteration 2)');
    expect(prompt).toContain('Build failed: TypeScript errors');
    expect(prompt).toContain('Recovery attempted: Fixed type definitions');
  });

  it('should handle complete handoff with all sections', () => {
    const handoff = createHandoff({
      iteration: 6,
      max_iterations: 10,
      original_prompt: 'Implement full system',
      completion_promise: 'ALL_DONE',
      prd: {
        project: 'Full System',
        branchName: 'feature/full',
        description: 'Full system implementation',
        storiesTotal: 5,
        storiesCompleted: 3,
        nextStoryId: 'US-004',
        incompleteIds: ['US-004', 'US-005']
      },
      git: {
        recentCommits: [
          { hash: 'aaa111', message: 'feat: add API' },
          { hash: 'bbb222', message: 'test: add unit tests' }
        ],
        branch: 'feature/full',
        hasUncommittedChanges: true
      },
      progress: {
        patterns: [
          'Use vitest for testing',
          'Follow TypeScript strict mode'
        ],
        recentLearnings: [
          'Always run typecheck before commit',
          'Update snapshots when needed'
        ]
      },
      stuckDetection: {
        lastPrdStatus: ['US-004'],
        iterationsOnSameStory: 3
      },
      lastError: {
        iteration: 5,
        message: 'Test failure',
        recoveryAttempt: 'Updated test expectations'
      }
    });

    const prompt = generateIterationPrompt(handoff);

    // Check all major sections are present
    expect(prompt).toContain('# Ralph Fresh Context - Iteration 6/10');
    expect(prompt).toContain('Implement full system');
    expect(prompt).toContain('**Project**: Full System');
    expect(prompt).toContain('**Progress**: 3/5 stories complete');
    expect(prompt).toContain('### Recent Git History');
    expect(prompt).toContain('### Patterns Learned');
    expect(prompt).toContain('### Recent Learnings');
    expect(prompt).toContain('## Stuck Detection');
    expect(prompt).toContain('## Previous Error');
    expect(prompt).toContain('<promise>ALL_DONE</promise>');
  });

  it('should handle empty git commits gracefully', () => {
    const handoff = createHandoff({
      iteration: 1,
      max_iterations: 5,
      original_prompt: 'Start project',
      completion_promise: 'DONE'
    });

    const prompt = generateIterationPrompt(handoff);

    expect(prompt).toContain('### Recent Git History');
    expect(prompt).not.toContain('- `');
  });

  it('should focus on next story in instructions', () => {
    const handoff = createHandoff({
      iteration: 2,
      max_iterations: 10,
      original_prompt: 'Build features',
      completion_promise: 'DONE',
      prd: {
        project: 'My App',
        branchName: 'feature/app',
        description: 'My app',
        storiesTotal: 3,
        storiesCompleted: 1,
        nextStoryId: 'US-002',
        incompleteIds: ['US-002', 'US-003']
      }
    });

    const prompt = generateIterationPrompt(handoff);

    expect(prompt).toContain('2. **Work on the next incomplete story**: US-002');
    expect(prompt).toContain('Focus on story US-002');
  });
});
