export const SECRET_PATH: RegExp;
/** What a line that names a secret path becomes. */
export const SECRET_LINE: string;
/** What the value under a key that names a secret becomes. */
export const MASKED_VALUE: string;
/** What a key that names a secret path becomes. */
export const KEY_OMITTED: string;
export const MAX_STATE_DEPTH: number;
export const MAX_STATE_NODES: number;
/** A string longer than maxChars plus this is cut before it is masked. */
export const WINDOW_MARGIN: number;
/** How far past the cut a run of token characters is followed to its end. */
export const RUN_EXTENSION: number;

export class JevStateMaskError extends Error {
  constructor(message?: string, options?: ErrorOptions);
}

/** A non-empty string of the state was omitted whole (every line names a secret path). */
export class JevStateFieldOmittedError extends JevStateMaskError {}

/**
 * A new value for a Jev point's state, as JSON would carry it, with secrets masked. The input is not
 * changed. Throws JevStateMaskError when the state cannot be masked completely (a cycle, deeper than
 * MAX_STATE_DEPTH, more than MAX_STATE_NODES nodes, a throwing toJSON) and JevStateFieldOmittedError
 * when a non-empty string was omitted whole. With maxChars, a string is cut to maxChars + WINDOW_MARGIN
 * before it is masked.
 */
export function maskJevState(state: unknown, options?: { maxChars?: number }): unknown;
