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
/**
 * Get the path to the prd.json file in a directory
 */
export declare function getPrdPath(directory: string): string;
/**
 * Get the path to the prd.json in .omc subdirectory
 */
export declare function getOmcPrdPath(directory: string): string;
/**
 * Find prd.json in a directory (checks both root and .omc)
 */
export declare function findPrdPath(directory: string): string | null;
/**
 * Read PRD from disk
 */
export declare function readPrd(directory: string): PRD | null;
/**
 * Write PRD to disk
 */
export declare function writePrd(directory: string, prd: PRD): boolean;
/**
 * Get the status of a PRD
 */
export declare function getPrdStatus(prd: PRD): PRDStatus;
/**
 * Mark a story as complete (passes: true)
 */
export declare function markStoryComplete(directory: string, storyId: string, notes?: string): boolean;
/**
 * Mark a story as incomplete (passes: false)
 */
export declare function markStoryIncomplete(directory: string, storyId: string, notes?: string): boolean;
/**
 * Get a specific story by ID
 */
export declare function getStory(directory: string, storyId: string): UserStory | null;
/**
 * Get the next incomplete story (highest priority)
 */
export declare function getNextStory(directory: string): UserStory | null;
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
export declare function initPrd(directory: string, project: string, branchName: string, description: string, stories?: UserStoryInput[]): boolean;
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
export declare function formatNextStoryPrompt(story: UserStory): string;
//# sourceMappingURL=prd.d.ts.map