/**
 * Notepad Wisdom Module
 *
 * Plan-scoped notepad system for capturing learnings, decisions, issues, and problems.
 * Creates wisdom files at: .omc/notepads/{plan-name}/
 */
import type { PlanWisdom } from './types.js';
/**
 * Initialize notepad directory for a plan
 * Creates .omc/notepads/{plan-name}/ with 4 empty markdown files
 */
export declare function initPlanNotepad(planName: string, directory?: string): boolean;
/**
 * Read all wisdom from a plan's notepad
 * Returns concatenated wisdom from all 4 categories
 */
export declare function readPlanWisdom(planName: string, directory?: string): PlanWisdom;
/**
 * Add a learning entry
 */
export declare function addLearning(planName: string, content: string, directory?: string): boolean;
/**
 * Add a decision entry
 */
export declare function addDecision(planName: string, content: string, directory?: string): boolean;
/**
 * Add an issue entry
 */
export declare function addIssue(planName: string, content: string, directory?: string): boolean;
/**
 * Add a problem entry
 */
export declare function addProblem(planName: string, content: string, directory?: string): boolean;
/**
 * Get a formatted string of all wisdom for a plan
 */
export declare function getWisdomSummary(planName: string, directory?: string): string;
export type { WisdomEntry, WisdomCategory, PlanWisdom } from './types.js';
//# sourceMappingURL=index.d.ts.map