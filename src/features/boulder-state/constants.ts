/**
 * Boulder State Constants
 *
 * Ported from oh-my-opencode's boulder-state.
 */

import { OmcPaths } from '../../lib/worktree-paths.js';

/** OMC state directory */
export const BOULDER_DIR = OmcPaths.ROOT;

/** Boulder state file name */
export const BOULDER_FILE = 'boulder.json';

/** Full path pattern for boulder state */
export const BOULDER_STATE_PATH = `${BOULDER_DIR}/${BOULDER_FILE}`;

/** Notepad directory for learnings */
export const NOTEPAD_DIR = 'notepads';

/** Full path for notepads */
export const NOTEPAD_BASE_PATH = `${BOULDER_DIR}/${NOTEPAD_DIR}`;

/** Planner plan directory */
export const PLANNER_PLANS_DIR = OmcPaths.PLANS;

/** Plan file extension */
export const PLAN_EXTENSION = '.md';
