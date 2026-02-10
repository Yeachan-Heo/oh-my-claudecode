/**
 * Learned Skills Constants
 */

import { join } from 'path';
import { homedir } from 'os';
import { OmcPaths } from '../../lib/worktree-paths.js';

/** User-level skills directory (read by skill-injector.mjs hook) */
export const USER_SKILLS_DIR = join(homedir(), '.claude', 'skills', 'omc-learned');

/** Global skills directory (new preferred location: ~/.omc/skills) */
export const GLOBAL_SKILLS_DIR = join(homedir(), '.omc', 'skills');

/** Project-level skills subdirectory */
export const PROJECT_SKILLS_SUBDIR = OmcPaths.SKILLS;

/** Maximum recursion depth for skill file discovery */
export const MAX_RECURSION_DEPTH = 10;

/** Valid skill file extension */
export const SKILL_EXTENSION = '.md';

/** Feature flag key for enabling/disabling */
export const FEATURE_FLAG_KEY = 'learner.enabled';

/** Default feature flag value */
export const FEATURE_FLAG_DEFAULT = true;

/** Maximum skill content length (characters) */
export const MAX_SKILL_CONTENT_LENGTH = 4000;

/** Minimum quality score for auto-injection */
export const MIN_QUALITY_SCORE = 50;

/** Required metadata fields */
export const REQUIRED_METADATA_FIELDS = ['id', 'name', 'description', 'triggers', 'source'];

/** Maximum skills to inject per session */
export const MAX_SKILLS_PER_SESSION = 10;

/** Debug mode enabled */
export const DEBUG_ENABLED = process.env.OMC_DEBUG === '1';
