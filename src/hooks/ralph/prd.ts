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
import { dirname, join } from 'path';
import { ensureSessionStateDir, getOmcRoot, getSessionStateDir } from '../../lib/worktree-paths.js';

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
  /** Whether architect verification has approved this story for progression */
  architectVerified?: boolean;
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

export interface EnsurePrdForStartupResult {
  ok: boolean;
  created: boolean;
  path: string | null;
  prd?: PRD;
  error?: string;
}

function normalizeStory(candidate: unknown): UserStory | null {
  if (!candidate || typeof candidate !== 'object') {
    return null;
  }

  const story = candidate as Record<string, unknown>;
  if (
    typeof story.id !== 'string' ||
    typeof story.title !== 'string' ||
    typeof story.description !== 'string' ||
    !Array.isArray(story.acceptanceCriteria) ||
    !story.acceptanceCriteria.every(criterion => typeof criterion === 'string') ||
    typeof story.priority !== 'number' ||
    !Number.isFinite(story.priority) ||
    typeof story.passes !== 'boolean'
  ) {
    return null;
  }

  return {
    id: story.id,
    title: story.title,
    description: story.description,
    acceptanceCriteria: [...story.acceptanceCriteria],
    priority: story.priority,
    passes: story.passes,
    architectVerified: story.architectVerified === true,
    notes: typeof story.notes === 'string' ? story.notes : undefined
  };
}

function normalizePrd(candidate: unknown): PRD | null {
  if (!candidate || typeof candidate !== 'object') {
    return null;
  }

  const prd = candidate as Record<string, unknown>;
  if (
    typeof prd.project !== 'string' ||
    typeof prd.branchName !== 'string' ||
    typeof prd.description !== 'string' ||
    !Array.isArray(prd.userStories)
  ) {
    return null;
  }

  const userStories = prd.userStories
    .map(normalizeStory);

  if (userStories.some(story => story === null)) {
    return null;
  }

  return {
    project: prd.project,
    branchName: prd.branchName,
    description: prd.description,
    userStories: userStories as UserStory[]
  };
}

function readPrdFromPath(prdPath: string): { prd?: PRD; error?: string } {
  try {
    const content = readFileSync(prdPath, 'utf-8');
    const parsed = JSON.parse(content) as unknown;
    const normalized = normalizePrd(parsed);

    if (!normalized) {
      return { error: `Invalid PRD structure in ${prdPath}.` };
    }

    return { prd: normalized };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { error: `Failed to read ${prdPath}: ${message}` };
  }
}

function isStoryComplete(story: UserStory): boolean {
  return story.passes && story.architectVerified === true;
}

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
 * Get the session-scoped transient PRD path.
 */
export function getSessionPrdPath(directory: string, sessionId: string): string {
  return join(getSessionStateDir(sessionId, directory), PRD_FILENAME);
}

/**
 * Get the legacy state-manager PRD path used by older builds.
 */
export function getLegacyStatePrdPath(directory: string): string {
  return join(getOmcRoot(directory), 'state', PRD_FILENAME);
}

/**
 * Find prd.json in a directory.
 *
 * With a session ID, active PRD state is read from the session-scoped path
 * first, then legacy project-level paths are treated as migration inputs.
 */
export function findPrdPath(directory: string, sessionId?: string): string | null {
  if (sessionId) {
    const sessionPath = getSessionPrdPath(directory, sessionId);
    if (existsSync(sessionPath)) {
      return sessionPath;
    }
  }

  const rootPath = getPrdPath(directory);
  if (existsSync(rootPath)) {
    return rootPath;
  }

  const omcPath = getOmcPrdPath(directory);
  if (existsSync(omcPath)) {
    return omcPath;
  }

  const legacyStatePath = getLegacyStatePrdPath(directory);
  if (existsSync(legacyStatePath)) {
    return legacyStatePath;
  }

  return null;
}

/**
 * Read PRD from disk
 */
export function readPrd(directory: string, sessionId?: string): PRD | null {
  const prdPath = findPrdPath(directory, sessionId);
  if (!prdPath) {
    return null;
  }

  return readPrdFromPath(prdPath).prd ?? null;
}

/**
 * Write PRD to disk
 */
export function writePrd(directory: string, prd: PRD, sessionId?: string): boolean {
  let prdPath: string;

  if (sessionId) {
    try {
      ensureSessionStateDir(sessionId, directory);
    } catch {
      return false;
    }
    prdPath = getSessionPrdPath(directory, sessionId);
  } else {
    // Backward compatibility for direct callers without a session ID:
    // prefer writing to an existing legacy location, or .omc by default.
    prdPath = findPrdPath(directory) ?? getOmcPrdPath(directory);
  }

  try {
    mkdirSync(dirname(prdPath), { recursive: true });
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
  const pending = stories.filter(s => !isStoryComplete(s));
  const fullyCompleted = stories.filter(isStoryComplete);

  // Sort pending by priority to find next story
  const sortedPending = [...pending].sort((a, b) => a.priority - b.priority);

  return {
    total: stories.length,
    completed: fullyCompleted.length,
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
  notes?: string,
  sessionId?: string
): boolean {
  const prd = readPrd(directory, sessionId);
  if (!prd) {
    return false;
  }

  const story = prd.userStories.find(s => s.id === storyId);
  if (!story) {
    return false;
  }

  story.passes = true;
  story.architectVerified = false;
  if (notes) {
    story.notes = notes;
  }

  return writePrd(directory, prd, sessionId);
}

/**
 * Mark a story as incomplete (passes: false)
 */
export function markStoryIncomplete(
  directory: string,
  storyId: string,
  notes?: string,
  sessionId?: string
): boolean {
  const prd = readPrd(directory, sessionId);
  if (!prd) {
    return false;
  }

  const story = prd.userStories.find(s => s.id === storyId);
  if (!story) {
    return false;
  }

  story.passes = false;
  story.architectVerified = false;
  if (notes) {
    story.notes = notes;
  }

  return writePrd(directory, prd, sessionId);
}

/**
 * Mark a story as architect-verified after reviewer approval
 */
export function markStoryArchitectVerified(
  directory: string,
  storyId: string,
  notes?: string,
  sessionId?: string
): boolean {
  const prd = readPrd(directory, sessionId);
  if (!prd) {
    return false;
  }

  const story = prd.userStories.find(s => s.id === storyId);
  if (!story) {
    return false;
  }

  story.architectVerified = true;
  if (notes) {
    story.notes = notes;
  }

  return writePrd(directory, prd, sessionId);
}

/**
 * Get a specific story by ID
 */
export function getStory(directory: string, storyId: string, sessionId?: string): UserStory | null {
  const prd = readPrd(directory, sessionId);
  if (!prd) {
    return null;
  }

  return prd.userStories.find(s => s.id === storyId) || null;
}

/**
 * Get the next incomplete story (highest priority)
 */
export function getNextStory(directory: string, sessionId?: string): UserStory | null {
  const prd = readPrd(directory, sessionId);
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
      passes: false,
      architectVerified: false
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
  stories?: UserStoryInput[],
  sessionId?: string
): boolean {
  const prd = stories
    ? createPrd(project, branchName, description, stories)
    : createSimplePrd(project, branchName, description);

  return writePrd(directory, prd, sessionId);
}

/**
 * Ensure Ralph startup has a valid PRD.json to work from.
 * - Missing PRD -> create scaffold
 * - Invalid PRD -> fail clearly
 */
export function ensurePrdForStartup(
  directory: string,
  project: string,
  branchName: string,
  description: string,
  stories?: UserStoryInput[],
  sessionId?: string
): EnsurePrdForStartupResult {
  const existingPath = findPrdPath(directory, sessionId);

  if (!existingPath) {
    const created = initPrd(directory, project, branchName, description, stories, sessionId);
    const createdPath = findPrdPath(directory, sessionId);
    const prd = created ? readPrd(directory, sessionId) : null;

    if (!created || !createdPath || !prd) {
      return {
        ok: false,
        created: false,
        path: createdPath,
        error: `Ralph requires a valid ${PRD_FILENAME} at startup, but scaffold creation failed.`
      };
    }

    if (prd.userStories.length === 0) {
      return {
        ok: false,
        created: true,
        path: createdPath,
        error: `Ralph created ${createdPath}, but it contains no user stories.`
      };
    }

    return { ok: true, created: true, path: createdPath, prd };
  }

  const parsed = readPrdFromPath(existingPath);
  if (!parsed.prd) {
    return {
      ok: false,
      created: false,
      path: existingPath,
      error: parsed.error ?? `Ralph requires a valid ${PRD_FILENAME} at startup.`
    };
  }

  if (parsed.prd.userStories.length === 0) {
    return {
      ok: false,
      created: false,
      path: existingPath,
      error: `${existingPath} must contain at least one user story for Ralph to start.`
    };
  }

  if (sessionId) {
    const sessionPath = getSessionPrdPath(directory, sessionId);
    if (existingPath !== sessionPath) {
      if (!writePrd(directory, parsed.prd, sessionId)) {
        return {
          ok: false,
          created: false,
          path: existingPath,
          error: `Ralph found ${existingPath}, but failed to migrate it to session-scoped ${sessionPath}.`
        };
      }

      return {
        ok: true,
        created: false,
        path: sessionPath,
        prd: parsed.prd
      };
    }
  }

  return {
    ok: true,
    created: false,
    path: existingPath,
    prd: parsed.prd
  };
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
  const statusLabel = isStoryComplete(story)
    ? 'COMPLETE'
    : story.passes
      ? 'AWAITING ARCHITECT REVIEW'
      : 'PENDING';
  lines.push(`Status: ${statusLabel}`);
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
export function formatNextStoryPrompt(story: UserStory, prdPath?: string): string {
  return `<current-story>

## Current Story: ${story.id} - ${story.title}

${story.description}

**Acceptance Criteria:**
${story.acceptanceCriteria.map((c, i) => `${i + 1}. ${c}`).join('\n')}

${prdPath ? `**Active PRD file:** ${prdPath}\n\n` : ''}**Instructions:**
1. Implement this story completely
2. Verify ALL acceptance criteria are met
3. Run quality checks (tests, typecheck, lint)
4. When complete, mark story as passes: true in the active PRD file
5. If ALL stories are done, run \`/oh-my-claudecode:cancel\` to cleanly exit ralph mode and clean up all state files

</current-story>

---

`;
}
