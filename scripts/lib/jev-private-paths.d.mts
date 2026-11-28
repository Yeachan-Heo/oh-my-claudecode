/** Types of jev-private-paths.mjs (the TypeScript resolver imports it). */

/** What a private path becomes. */
export const PRIVATE_PATH_MARKER: string;

/**
 * A function that returns its text with the paths of OMC_JEV_COMPACT_PRIVATE_PATHS replaced by
 * PRIVATE_PATH_MARKER, or undefined when the environment lists none.
 */
export function privatePathMask(env: Record<string, string | undefined>): ((text: string) => string) | undefined;
