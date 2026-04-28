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
export declare const PRD_FILENAME = "prd.json";
export declare const PRD_EXAMPLE_FILENAME = "prd.example.json";
export interface EnsurePrdForStartupResult {
    ok: boolean;
    created: boolean;
    path: string | null;
    prd?: PRD;
    error?: string;
}
/**
 * Get the path to the prd.json file in a directory
 */
export declare function getPrdPath(directory: string): string;
/**
 * Get the path to the prd.json in .omc subdirectory
 */
export declare function getOmcPrdPath(directory: string): string;
/**
 * Get the session-scoped transient PRD path.
 */
export declare function getSessionPrdPath(directory: string, sessionId: string): string;
/**
 * Get the legacy state-manager PRD path used by older builds.
 */
export declare function getLegacyStatePrdPath(directory: string): string;
/**
 * Find prd.json in a directory.
 *
 * With a session ID, active PRD state is read from the session-scoped path
 * first, then legacy project-level paths are treated as migration inputs.
 */
export declare function findPrdPath(directory: string, sessionId?: string): string | null;
/**
 * Read PRD from disk
 */
export declare function readPrd(directory: string, sessionId?: string): PRD | null;
/**
 * Write PRD to disk
 */
export declare function writePrd(directory: string, prd: PRD, sessionId?: string): boolean;
/**
 * Get the status of a PRD
 */
export declare function getPrdStatus(prd: PRD): PRDStatus;
/**
 * Mark a story as complete (passes: true)
 */
export declare function markStoryComplete(directory: string, storyId: string, notes?: string, sessionId?: string): boolean;
/**
 * Mark a story as incomplete (passes: false)
 */
export declare function markStoryIncomplete(directory: string, storyId: string, notes?: string, sessionId?: string): boolean;
/**
 * Mark a story as architect-verified after reviewer approval
 */
export declare function markStoryArchitectVerified(directory: string, storyId: string, notes?: string, sessionId?: string): boolean;
/**
 * Get a specific story by ID
 */
export declare function getStory(directory: string, storyId: string, sessionId?: string): UserStory | null;
/**
 * Get the next incomplete story (highest priority)
 */
export declare function getNextStory(directory: string, sessionId?: string): UserStory | null;
/**
 * Input type for creating user stories (priority is optional)
 */
export type UserStoryInput = Omit<UserStory, 'passes' | 'priority'> & {
    priority?: number;
};
/**
 * Create a new PRD with user stories from a task description
 */
export declare function createPrd(project: string, branchName: string, description: string, stories: UserStoryInput[]): PRD;
/**
 * Create a simple PRD from a task description (single story)
 */
export declare function createSimplePrd(project: string, branchName: string, taskDescription: string): PRD;
/**
 * Initialize a PRD in a directory
 */
export declare function initPrd(directory: string, project: string, branchName: string, description: string, stories?: UserStoryInput[], sessionId?: string): boolean;
/**
 * Ensure Ralph startup has a valid PRD.json to work from.
 * - Missing PRD -> create scaffold
 * - Invalid PRD -> fail clearly
 */
export declare function ensurePrdForStartup(directory: string, project: string, branchName: string, description: string, stories?: UserStoryInput[], sessionId?: string): EnsurePrdForStartupResult;
/**
 * Format PRD status as a string for display
 */
export declare function formatPrdStatus(status: PRDStatus): string;
/**
 * Format a story for display
 */
export declare function formatStory(story: UserStory): string;
/**
 * Format entire PRD for display
 */
export declare function formatPrd(prd: PRD): string;
/**
 * Format next story prompt for injection into ralph
 */
export declare function formatNextStoryPrompt(story: UserStory, prdPath?: string): string;
//# sourceMappingURL=prd.d.ts.map