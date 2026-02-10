/**
 * Learned Skills Constants
 */
/** User-level skills directory (read by skill-injector.mjs hook) */
export declare const USER_SKILLS_DIR: string;
/** Global skills directory (new preferred location: ~/.omc/skills) */
export declare const GLOBAL_SKILLS_DIR: string;
/** Project-level skills subdirectory */
export declare const PROJECT_SKILLS_SUBDIR: ".omc/skills";
/** Maximum recursion depth for skill file discovery */
export declare const MAX_RECURSION_DEPTH = 10;
/** Valid skill file extension */
export declare const SKILL_EXTENSION = ".md";
/** Feature flag key for enabling/disabling */
export declare const FEATURE_FLAG_KEY = "learner.enabled";
/** Default feature flag value */
export declare const FEATURE_FLAG_DEFAULT = true;
/** Maximum skill content length (characters) */
export declare const MAX_SKILL_CONTENT_LENGTH = 4000;
/** Minimum quality score for auto-injection */
export declare const MIN_QUALITY_SCORE = 50;
/** Required metadata fields */
export declare const REQUIRED_METADATA_FIELDS: string[];
/** Maximum skills to inject per session */
export declare const MAX_SKILLS_PER_SESSION = 10;
/** Debug mode enabled */
export declare const DEBUG_ENABLED: boolean;
//# sourceMappingURL=constants.d.ts.map