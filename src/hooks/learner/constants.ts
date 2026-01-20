/**
 * Learned Skills Constants
 */

import { join } from 'path';
import { homedir } from 'os';

/** User-level skills directory (read by skill-injector.mjs hook) */
export const USER_SKILLS_DIR = join(homedir(), '.claude', 'skills', 'omc-learned');

/** Project-level skills subdirectory */
export const PROJECT_SKILLS_SUBDIR = '.omc/skills';

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
