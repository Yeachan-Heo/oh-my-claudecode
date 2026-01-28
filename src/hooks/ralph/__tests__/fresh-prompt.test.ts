/**
 * Tests for fresh-context ralph prompt generation
 */

import { describe, it, expect } from 'vitest';
import { generateIterationPrompt, type RalphFreshHandoff } from '../fresh-prompt.js';

describe('generateIterationPrompt', () => {
  it('should generate prompt with basic iteration info', () => {
    const handoff: RalphFreshHandoff = {
      iteration: 3,
      maxIterations: 10,
      originalPrompt: 'Build a todo app',
      completionPromise: 'TASK_COMPLETE',
      prd: null,
      git: {
        recentCommits: [],
        hasUncommittedChanges: false
      },
      progress: {
        patterns: [],
        recentLearnings: []
      },
      stuckDetection: {
        iterationsOnSameStory: 0
      },
      lastError: null
    };

    const prompt = generateIterationPrompt(handoff);

    expect(prompt).toContain('# Ralph Fresh Context - Iteration 3/10');
    expect(prompt).toContain('Build a todo app');
    expect(prompt).toContain('<promise>TASK_COMPLETE</promise>');
  });

  it('should include PRD status when available', () => {
    const handoff: RalphFreshHandoff = {
      iteration: 2,
      maxIterations: 10,
      originalPrompt: 'Build a todo app',
      completionPromise: 'DONE',
      prd: {
        project: 'Todo App',
        storiesCompleted: 2,
        storiesTotal: 5,
        nextStoryId: 'US-003',
        incompleteIds: ['US-003', 'US-004', 'US-005']
      },
      git: {
        recentCommits: [
          { hash: 'abc123', message: 'feat: add user model' }
        ],
        hasUncommittedChanges: false
      },
      progress: {
        patterns: [],
        recentLearnings: []
      },
      stuckDetection: {
        iterationsOnSameStory: 0
      },
      lastError: null
    };

    const prompt = generateIterationPrompt(handoff);

    expect(prompt).toContain('**Project**: Todo App');
    expect(prompt).toContain('**Progress**: 2/5 stories complete');
    expect(prompt).toContain('**Next Story**: US-003');
    expect(prompt).toContain('**Remaining**: US-003, US-004, US-005');
  });

  it('should show free-form mode when no PRD', () => {
    const handoff: RalphFreshHandoff = {
      iteration: 1,
      maxIterations: 5,
      originalPrompt: 'Quick fix',
      completionPromise: 'DONE',
      prd: null,
      git: {
        recentCommits: [],
        hasUncommittedChanges: false
      },
      progress: {
        patterns: [],
        recentLearnings: []
      },
      stuckDetection: {
        iterationsOnSameStory: 0
      },
      lastError: null
    };

    const prompt = generateIterationPrompt(handoff);

    expect(prompt).toContain('No PRD found. Working in free-form mode.');
  });

  it('should include git history', () => {
    const handoff: RalphFreshHandoff = {
      iteration: 2,
      maxIterations: 10,
      originalPrompt: 'Build features',
      completionPromise: 'DONE',
      prd: null,
      git: {
        recentCommits: [
          { hash: 'abc123', message: 'feat: add authentication' },
          { hash: 'def456', message: 'fix: update validation' }
        ],
        hasUncommittedChanges: true
      },
      progress: {
        patterns: [],
        recentLearnings: []
      },
      stuckDetection: {
        iterationsOnSameStory: 0
      },
      lastError: null
    };

    const prompt = generateIterationPrompt(handoff);

    expect(prompt).toContain('### Recent Git History');
    expect(prompt).toContain('- `abc123`: feat: add authentication');
    expect(prompt).toContain('- `def456`: fix: update validation');
    expect(prompt).toContain('⚠️ **WARNING**: There are uncommitted changes');
  });

  it('should include patterns learned', () => {
    const handoff: RalphFreshHandoff = {
      iteration: 3,
      maxIterations: 10,
      originalPrompt: 'Build system',
      completionPromise: 'DONE',
      prd: null,
      git: {
        recentCommits: [],
        hasUncommittedChanges: false
      },
      progress: {
        patterns: [
          'All tests are in __tests__ directories',
          'Use TypeScript strict mode'
        ],
        recentLearnings: []
      },
      stuckDetection: {
        iterationsOnSameStory: 0
      },
      lastError: null
    };

    const prompt = generateIterationPrompt(handoff);

    expect(prompt).toContain('### Patterns Learned');
    expect(prompt).toContain('- All tests are in __tests__ directories');
    expect(prompt).toContain('- Use TypeScript strict mode');
  });

  it('should include recent learnings', () => {
    const handoff: RalphFreshHandoff = {
      iteration: 4,
      maxIterations: 10,
      originalPrompt: 'Complete tasks',
      completionPromise: 'DONE',
      prd: null,
      git: {
        recentCommits: [],
        hasUncommittedChanges: false
      },
      progress: {
        patterns: [],
        recentLearnings: [
          'Need to run npm install after package changes',
          'Tests must be run before committing'
        ]
      },
      stuckDetection: {
        iterationsOnSameStory: 0
      },
      lastError: null
    };

    const prompt = generateIterationPrompt(handoff);

    expect(prompt).toContain('### Recent Learnings');
    expect(prompt).toContain('- Need to run npm install after package changes');
    expect(prompt).toContain('- Tests must be run before committing');
  });

  it('should show stuck detection warning', () => {
    const handoff: RalphFreshHandoff = {
      iteration: 5,
      maxIterations: 10,
      originalPrompt: 'Build feature',
      completionPromise: 'DONE',
      prd: {
        project: 'My Project',
        storiesCompleted: 1,
        storiesTotal: 3,
        nextStoryId: 'US-002',
        incompleteIds: ['US-002', 'US-003']
      },
      git: {
        recentCommits: [],
        hasUncommittedChanges: false
      },
      progress: {
        patterns: [],
        recentLearnings: []
      },
      stuckDetection: {
        iterationsOnSameStory: 3
      },
      lastError: null
    };

    const prompt = generateIterationPrompt(handoff);

    expect(prompt).toContain('## Stuck Detection');
    expect(prompt).toContain("You've been on story US-002 for 3 iterations");
    expect(prompt).toContain('Is there a blocker?');
  });

  it('should include last error when present', () => {
    const handoff: RalphFreshHandoff = {
      iteration: 3,
      maxIterations: 10,
      originalPrompt: 'Fix bugs',
      completionPromise: 'DONE',
      prd: null,
      git: {
        recentCommits: [],
        hasUncommittedChanges: false
      },
      progress: {
        patterns: [],
        recentLearnings: []
      },
      stuckDetection: {
        iterationsOnSameStory: 0
      },
      lastError: {
        iteration: 2,
        message: 'Build failed: TypeScript errors',
        recoveryAttempt: 'Fixed type definitions'
      }
    };

    const prompt = generateIterationPrompt(handoff);

    expect(prompt).toContain('## Previous Error (Iteration 2)');
    expect(prompt).toContain('Build failed: TypeScript errors');
    expect(prompt).toContain('Recovery attempted: Fixed type definitions');
  });

  it('should handle complete handoff with all sections', () => {
    const handoff: RalphFreshHandoff = {
      iteration: 6,
      maxIterations: 10,
      originalPrompt: 'Implement full system',
      completionPromise: 'ALL_DONE',
      prd: {
        project: 'Full System',
        storiesCompleted: 3,
        storiesTotal: 5,
        nextStoryId: 'US-004',
        incompleteIds: ['US-004', 'US-005']
      },
      git: {
        recentCommits: [
          { hash: 'aaa111', message: 'feat: add API' },
          { hash: 'bbb222', message: 'test: add unit tests' }
        ],
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
        iterationsOnSameStory: 3
      },
      lastError: {
        iteration: 5,
        message: 'Test failure',
        recoveryAttempt: 'Updated test expectations'
      }
    };

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
    const handoff: RalphFreshHandoff = {
      iteration: 1,
      maxIterations: 5,
      originalPrompt: 'Start project',
      completionPromise: 'DONE',
      prd: null,
      git: {
        recentCommits: [],
        hasUncommittedChanges: false
      },
      progress: {
        patterns: [],
        recentLearnings: []
      },
      stuckDetection: {
        iterationsOnSameStory: 0
      },
      lastError: null
    };

    const prompt = generateIterationPrompt(handoff);

    expect(prompt).toContain('### Recent Git History');
    expect(prompt).not.toContain('- `');
  });

  it('should focus on next story in instructions', () => {
    const handoff: RalphFreshHandoff = {
      iteration: 2,
      maxIterations: 10,
      originalPrompt: 'Build features',
      completionPromise: 'DONE',
      prd: {
        project: 'My App',
        storiesCompleted: 1,
        storiesTotal: 3,
        nextStoryId: 'US-002',
        incompleteIds: ['US-002', 'US-003']
      },
      git: {
        recentCommits: [],
        hasUncommittedChanges: false
      },
      progress: {
        patterns: [],
        recentLearnings: []
      },
      stuckDetection: {
        iterationsOnSameStory: 0
      },
      lastError: null
    };

    const prompt = generateIterationPrompt(handoff);

    expect(prompt).toContain('2. **Work on the next incomplete story**: US-002');
    expect(prompt).toContain('Focus on story US-002');
  });
});
