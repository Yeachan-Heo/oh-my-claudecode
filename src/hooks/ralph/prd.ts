/**
 * Ralph PRD (Product Requirements Document) Support
 *
 * Implements structured task tracking using prd.json format from the original Ralph.
 * Each user story has:
 * - id: Unique identifier (e.g., "US-001")
 * - title: Short description
 * - description: User story format
 * - acceptanceCriteria: List of criteria to pass
 * - priority: Execution order (1 = highest)
 * - passes: Boolean indicating completion
 * - notes: Optional notes from implementation
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { getOmcRoot } from '../../lib/worktree-paths.js';

// ============================================================================
// Types
// ============================================================================

export interface UserStory {
  /** Unique identifier (e.g., "US-001") */
  id: string;
  /** Short title for the story */
  title: string;
  /** Full user story description */
  description: string;
  /** List of acceptance criteria that must be met */
  acceptanceCriteria: string[];
  /** Execution priority (1 = highest) */
  priority: number;
  /** Whether this story passes (complete and verified) */
  passes: boolean;
  /** Optional notes from implementation */
  notes?: string;
}

export interface PRD {
  /** Project name */
  project: string;
  /** Git branch name for this work */
  branchName: string;
  /** Overall description of the feature/task */
  description: string;
  /** List of user stories */
  userStories: UserStory[];
}

export interface PRDStatus {
  /** Total number of stories */
  total: number;
  /** Number of completed (passes: true) stories */
  completed: number;
  /** Number of pending (passes: false) stories */
  pending: number;
  /** Whether all stories are complete */
  allComplete: boolean;
  /** The highest priority incomplete story, if any */
  nextStory: UserStory | null;
  /** List of incomplete story IDs */
  incompleteIds: string[];
}

// ============================================================================
// Constants
// ============================================================================

export const PRD_FILENAME = 'prd.json';
export const PRD_EXAMPLE_FILENAME = 'prd.example.json';

// ============================================================================
// File Operations
// ============================================================================

/**
 * Get the path to the prd.json file in a directory
 */
export function getPrdPath(directory: string): string {
  return join(directory, PRD_FILENAME);
}

/**
 * Get the path to the prd.json in .omc subdirectory
 */
export function getOmcPrdPath(directory: string): string {
  return join(getOmcRoot(directory), PRD_FILENAME);
}

/**
 * Find prd.json in a directory (checks both root and .omc)
 */
export function findPrdPath(directory: string): string | null {
  const rootPath = getPrdPath(directory);
  if (existsSync(rootPath)) {
    return rootPath;
  }

  const omcPath = getOmcPrdPath(directory);
  if (existsSync(omcPath)) {
    return omcPath;
  }

  return null;
}

/**
 * Read PRD from disk
 */
export function readPrd(directory: string): PRD | null {
  const prdPath = findPrdPath(directory);
  if (!prdPath) {
    return null;
  }

  try {
    const content = readFileSync(prdPath, 'utf-8');
    const prd = JSON.parse(content) as PRD;

    // Validate structure
    if (!prd.userStories || !Array.isArray(prd.userStories)) {
      return null;
    }

    return prd;
  } catch {
    return null;
  }
}

/**
 * Write PRD to disk
 */
export function writePrd(directory: string, prd: PRD): boolean {
  // Prefer writing to existing location, or .omc by default
  let prdPath = findPrdPath(directory);

  if (!prdPath) {
    const omcDir = getOmcRoot(directory);
    if (!existsSync(omcDir)) {
      try {
        mkdirSync(omcDir, { recursive: true });
      } catch {
        return false;
      }
    }
    prdPath = getOmcPrdPath(directory);
  }

  try {
    writeFileSync(prdPath, JSON.stringify(prd, null, 2));
    return true;
  } catch {
    return false;
  }
}

// ============================================================================
// PRD Status & Operations
// ============================================================================

/**
 * Get the status of a PRD
 */
export function getPrdStatus(prd: PRD): PRDStatus {
  const stories = prd.userStories;
  const completed = stories.filter(s => s.passes);
  const pending = stories.filter(s => !s.passes);

  // Sort pending by priority to find next story
  const sortedPending = [...pending].sort((a, b) => a.priority - b.priority);

  return {
    total: stories.length,
    completed: completed.length,
    pending: pending.length,
    allComplete: pending.length === 0,
    nextStory: sortedPending[0] || null,
    incompleteIds: pending.map(s => s.id)
  };
}

/**
 * Mark a story as complete (passes: true)
 */
export function markStoryComplete(
  directory: string,
  storyId: string,
  notes?: string
): boolean {
  const prd = readPrd(directory);
  if (!prd) {
    return false;
  }

  const story = prd.userStories.find(s => s.id === storyId);
  if (!story) {
    return false;
  }

  story.passes = true;
  if (notes) {
    story.notes = notes;
  }

  return writePrd(directory, prd);
}

/**
 * Mark a story as incomplete (passes: false)
 */
export function markStoryIncomplete(
  directory: string,
  storyId: string,
  notes?: string
): boolean {
  const prd = readPrd(directory);
  if (!prd) {
    return false;
  }

  const story = prd.userStories.find(s => s.id === storyId);
  if (!story) {
    return false;
  }

  story.passes = false;
  if (notes) {
    story.notes = notes;
  }

  return writePrd(directory, prd);
}

/**
 * Get a specific story by ID
 */
export function getStory(directory: string, storyId: string): UserStory | null {
  const prd = readPrd(directory);
  if (!prd) {
    return null;
  }

  return prd.userStories.find(s => s.id === storyId) || null;
}

/**
 * Get the next incomplete story (highest priority)
 */
export function getNextStory(directory: string): UserStory | null {
  const prd = readPrd(directory);
  if (!prd) {
    return null;
  }

  const status = getPrdStatus(prd);
  return status.nextStory;
}

// ============================================================================
// PRD Creation
// ============================================================================

/**
 * Input type for creating user stories (priority is optional)
 */
export type UserStoryInput = Omit<UserStory, 'passes' | 'priority'> & {
  priority?: number;
};

/**
 * Create a new PRD with user stories from a task description
 */
export function createPrd(
  project: string,
  branchName: string,
  description: string,
  stories: UserStoryInput[]
): PRD {
  return {
    project,
    branchName,
    description,
    userStories: stories.map((s, index) => ({
      ...s,
      priority: s.priority ?? index + 1,
      passes: false
    }))
  };
}

/**
 * Create a simple PRD from a task description (single story)
 */
export function createSimplePrd(
  project: string,
  branchName: string,
  taskDescription: string
): PRD {
  return createPrd(project, branchName, taskDescription, [
    {
      id: 'US-001',
      title: taskDescription.slice(0, 50) + (taskDescription.length > 50 ? '...' : ''),
      description: taskDescription,
      acceptanceCriteria: [
        'Implementation is complete',
        'Code compiles/runs without errors',
        'Tests pass (if applicable)',
        'Changes are committed'
      ],
      priority: 1
    }
  ]);
}

/**
 * Initialize a PRD in a directory
 */
export function initPrd(
  directory: string,
  project: string,
  branchName: string,
  description: string,
  stories?: UserStoryInput[]
): boolean {
  const prd = stories
    ? createPrd(project, branchName, description, stories)
    : createSimplePrd(project, branchName, description);

  return writePrd(directory, prd);
}

// ============================================================================
// PRD Formatting
// ============================================================================

/**
 * Format PRD status as a string for display
 */
export function formatPrdStatus(status: PRDStatus): string {
  const lines: string[] = [];

  lines.push(`[PRD Status: ${status.completed}/${status.total} stories complete]`);

  if (status.allComplete) {
    lines.push('All stories are COMPLETE!');
  } else {
    lines.push(`Remaining: ${status.incompleteIds.join(', ')}`);
    if (status.nextStory) {
      lines.push(`Next story: ${status.nextStory.id} - ${status.nextStory.title}`);
    }
  }

  return lines.join('\n');
}

/**
 * Format a story for display
 */
export function formatStory(story: UserStory): string {
  const lines: string[] = [];

  lines.push(`## ${story.id}: ${story.title}`);
  lines.push(`Status: ${story.passes ? 'COMPLETE' : 'PENDING'}`);
  lines.push(`Priority: ${story.priority}`);
  lines.push('');
  lines.push(story.description);
  lines.push('');
  lines.push('**Acceptance Criteria:**');
  story.acceptanceCriteria.forEach((c, i) => {
    lines.push(`${i + 1}. ${c}`);
  });

  if (story.notes) {
    lines.push('');
    lines.push(`**Notes:** ${story.notes}`);
  }

  return lines.join('\n');
}

/**
 * Format entire PRD for display
 */
export function formatPrd(prd: PRD): string {
  const lines: string[] = [];
  const status = getPrdStatus(prd);

  lines.push(`# ${prd.project}`);
  lines.push(`Branch: ${prd.branchName}`);
  lines.push('');
  lines.push(prd.description);
  lines.push('');
  lines.push(formatPrdStatus(status));
  lines.push('');
  lines.push('---');
  lines.push('');

  // Sort by priority for display
  const sortedStories = [...prd.userStories].sort((a, b) => a.priority - b.priority);

  for (const story of sortedStories) {
    lines.push(formatStory(story));
    lines.push('');
    lines.push('---');
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Format next story prompt for injection into ralph
 */
export function formatNextStoryPrompt(story: UserStory): string {
  return `<current-story>

## Current Story: ${story.id} - ${story.title}

${story.description}

**Acceptance Criteria:**
${story.acceptanceCriteria.map((c, i) => `${i + 1}. ${c}`).join('\n')}

**Instructions:**
1. Implement this story completely
2. Verify ALL acceptance criteria are met
3. Run quality checks (tests, typecheck, lint)
4. When complete, mark story as passes: true in prd.json
5. If ALL stories are done, run \`/oh-my-claudecode:cancel\` to cleanly exit ralph mode and clean up all state files

</current-story>

---

`;
}
