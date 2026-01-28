/**
 * Fresh Context Ralph Prompt Generation
 *
 * Generates iteration prompts for ralph fresh mode where each iteration
 * starts with a completely fresh context (no memory of previous attempts).
 * The prompt includes state from files and git history only.
 */

// ============================================================================
// Types
// ============================================================================

export interface RalphFreshHandoff {
  /** Current iteration number */
  iteration: number;
  /** Maximum iterations allowed */
  maxIterations: number;
  /** The original user prompt/task */
  originalPrompt: string;
  /** The promise phrase to output when complete */
  completionPromise: string;
  /** PRD status (null if no PRD) */
  prd: {
    project: string;
    storiesCompleted: number;
    storiesTotal: number;
    nextStoryId: string;
    incompleteIds: string[];
  } | null;
  /** Git state */
  git: {
    recentCommits: Array<{
      hash: string;
      message: string;
    }>;
    hasUncommittedChanges: boolean;
  };
  /** Progress tracking */
  progress: {
    patterns: string[];
    recentLearnings: string[];
  };
  /** Stuck detection */
  stuckDetection: {
    iterationsOnSameStory: number;
  };
  /** Last error from previous iteration */
  lastError: {
    iteration: number;
    message: string;
    recoveryAttempt?: string;
  } | null;
}

// ============================================================================
// Prompt Generation
// ============================================================================

/**
 * Generate the iteration prompt from handoff state
 */
export function generateIterationPrompt(handoff: RalphFreshHandoff): string {
  const sections: string[] = [];

  // Header
  sections.push(`# Ralph Fresh Context - Iteration ${handoff.iteration}/${handoff.maxIterations}\n`);
  sections.push('You are continuing work that was started by a previous agent iteration.');
  sections.push('**Your context is completely fresh** - you have no memory of previous attempts.');
  sections.push('Your ONLY memory is what\'s in the files and git history.\n');

  // Your Task
  sections.push('## Your Task');
  sections.push(`${handoff.originalPrompt}\n`);

  // Current State
  sections.push('## Current State (from files)\n');

  // PRD Status
  sections.push('### PRD Status');
  if (handoff.prd) {
    sections.push(`**Project**: ${handoff.prd.project}`);
    sections.push(`**Progress**: ${handoff.prd.storiesCompleted}/${handoff.prd.storiesTotal} stories complete\n`);
    sections.push(`**Next Story**: ${handoff.prd.nextStoryId}`);
    if (handoff.prd.incompleteIds.length > 0) {
      sections.push(`**Remaining**: ${handoff.prd.incompleteIds.join(', ')}`);
    }
  } else {
    sections.push('No PRD found. Working in free-form mode.');
  }
  sections.push('');

  // Git History
  sections.push('### Recent Git History');
  if (handoff.git.recentCommits.length > 0) {
    for (const commit of handoff.git.recentCommits) {
      sections.push(`- \`${commit.hash}\`: ${commit.message}`);
    }
  }
  sections.push('');

  if (handoff.git.hasUncommittedChanges) {
    sections.push('⚠️ **WARNING**: There are uncommitted changes. Review and commit or discard.');
    sections.push('');
  }

  // Patterns Learned
  if (handoff.progress.patterns.length > 0) {
    sections.push('### Patterns Learned');
    for (const pattern of handoff.progress.patterns) {
      sections.push(`- ${pattern}`);
    }
    sections.push('');
  }

  // Recent Learnings
  if (handoff.progress.recentLearnings.length > 0) {
    sections.push('### Recent Learnings');
    for (const learning of handoff.progress.recentLearnings) {
      sections.push(`- ${learning}`);
    }
    sections.push('');
  }

  // Your Mission
  sections.push('## Your Mission\n');
  sections.push('1. **READ the codebase** to understand current state (start with prd.json if exists)');
  if (handoff.prd) {
    sections.push(`2. **Work on the next incomplete story**: ${handoff.prd.nextStoryId}`);
  } else {
    sections.push('2. **Continue the work** based on what you find in files and git');
  }
  sections.push('3. **Make frequent atomic commits** as you complete work');
  sections.push('4. **Update prd.json** when you complete a story (set `passes: true`)');
  sections.push('5. **Update progress.txt** with learnings for future iterations');
  sections.push(`6. When ALL stories are complete, output: \`<promise>${handoff.completionPromise}</promise>\`\n`);

  // Critical Rules
  sections.push('## Critical Rules\n');
  sections.push('- **Trust git history** - Don\'t redo work that\'s already committed');
  sections.push('- **Focus on ONE story** - Complete it fully before moving on');
  sections.push('- **Commit frequently** - Your next iteration won\'t know what you did otherwise');
  sections.push('- **Update state files** - prd.json and progress.txt are your memory');
  sections.push('- **Be concise** - You have limited context, don\'t waste it on verbose output\n');

  // Stuck Detection
  if (handoff.stuckDetection.iterationsOnSameStory > 2 && handoff.prd) {
    sections.push('## Stuck Detection\n');
    sections.push(`⚠️ **You've been on story ${handoff.prd.nextStoryId} for ${handoff.stuckDetection.iterationsOnSameStory} iterations.**`);
    sections.push('Consider:');
    sections.push('- Is there a blocker? Document it in progress.txt');
    sections.push('- Is the acceptance criteria unclear? Simplify and complete what you can');
    sections.push('- Should you skip to another story? Update priority in prd.json');
    sections.push('');
  }

  // Last Error
  if (handoff.lastError) {
    sections.push(`## Previous Error (Iteration ${handoff.lastError.iteration})`);
    sections.push(handoff.lastError.message);
    if (handoff.lastError.recoveryAttempt) {
      sections.push(`Recovery attempted: ${handoff.lastError.recoveryAttempt}`);
    }
    sections.push('');
  }

  // Footer
  sections.push('---\n');
  if (handoff.prd) {
    sections.push(`BEGIN WORK. Focus on story ${handoff.prd.nextStoryId}.`);
  } else {
    sections.push('BEGIN WORK.');
  }

  return sections.join('\n');
}
