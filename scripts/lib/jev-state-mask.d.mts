export const SECRET_PATH: RegExp;
/** What a line that names a secret path becomes. */
export const SECRET_LINE: string;
/** What the value under a key that names a secret becomes. */
export const MASKED_VALUE: string;
/** What a key that names a secret path becomes. */
export const KEY_OMITTED: string;
export const MAX_STATE_DEPTH: number;
export const MAX_STATE_NODES: number;
/** With a window, the most characters the mask reads in all (never less than sixteen windows). A state that needs more is an error. */
export const MAX_STATE_CHARS: number;
/** A string longer than maxChars plus this is cut before it is masked. */
export const WINDOW_MARGIN: number;
/** How far past the cut the last line of a cut text is read for a secret path. */
export const LINE_EXTENSION: number;
/** How far from its end an argument of a command is read to tell its program; with no separator in it, a longer argument is taken for one (fail closed). */
export const PATH_TAIL: number;
/** How far past the cut a run of token characters is followed to its end. */
export const RUN_EXTENSION: number;
/** The characters that a run of token characters is made of (see the comment in the module). */
export const TOKEN_CHAR: RegExp;
/**
 * What becomes of a value, from the label its name gives it ('secret', 'counter' or false) and the argument mode its place
 * among the arguments of a command gives it ('secret' or a partial mode): 'secret', 'counter', the partial mode, or false.
 * A secret label or argument beats a counter label, which beats a partial mode.
 */
export function treatment(label: 'secret' | 'counter' | false, argument?: string | false): string | false;
/** The name of a key as the secret classification reads it: our markers taken out, words split at humps and acronym ends, lower case. */
export function normalizeKey(key: string): string;

export class JevStateMaskError extends Error {
  constructor(message?: string, options?: ErrorOptions);
}

/** A non-empty string of the state was omitted whole (every line names a secret path). */
export class JevStateFieldOmittedError extends JevStateMaskError {}

/**
 * A new value for a Jev point's state, as JSON would carry it, with secrets masked. The input is not
 * changed. Throws JevStateMaskError when the state cannot be masked completely (a cycle, deeper than
 * MAX_STATE_DEPTH, more than MAX_STATE_NODES nodes, more than MAX_STATE_CHARS characters to read with a window,
 * a throwing toJSON) and JevStateFieldOmittedError when a non-empty string was omitted whole. With maxChars, a
 * string is cut to maxChars + WINDOW_MARGIN before it is masked, and no rule reads more of it than that window.
 */
export function maskJevState(state: unknown, options?: { maxChars?: number }): unknown;
