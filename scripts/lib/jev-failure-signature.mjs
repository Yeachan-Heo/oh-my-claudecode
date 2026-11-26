// Failure-signature helpers for the PostToolUseFailure hook (post-tool-use-failure.mjs).
//
// failureSignature: the first non-empty line of the error with volatile details masked (temp
// paths, UUIDs, datetimes, times of day, epoch milliseconds, long hex such as hashes or message
// ids, and any remaining numbers), cut to SIGNATURE_MAX characters. Two errors of one retry loop
// share a signature; line numbers, timestamps and temp paths do not change it.
//
// errorSeriesKey: the series key of the repeated-failure counter. A plain error keys
// (tool, signature hash); a mutating shell command (rm, mv, sed -i, tee, git apply) with a
// recognized target path keys (tool, path hash) instead, so the same file caught in a retry loop
// by different methods is one series. Hashes are 16 hex characters of sha256; neither the error
// text nor the path ever reaches the state file (privacy: only hashes are persisted).
import { createHash } from 'node:crypto';

export const SIGNATURE_MAX = 200; // cut length of the masked signature
export const DEFAULT_NUDGE_THRESHOLD = 3; // series repetition that fires the nudge
export const DEFAULT_FINAL_THRESHOLD = 4; // series repetition that fires the final state

const hash16 = (text) => createHash('sha256').update(String(text ?? '')).digest('hex').slice(0, 16);

// Positive-integer threshold override from the environment, or the default.
function thresholdFromEnv(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function nudgeThreshold(env = process.env) {
  return thresholdFromEnv(env.OMC_JEV_FAILURE_SERIES_NUDGE, DEFAULT_NUDGE_THRESHOLD);
}

export function finalThreshold(env = process.env) {
  return thresholdFromEnv(env.OMC_JEV_FAILURE_SERIES_FINAL, DEFAULT_FINAL_THRESHOLD);
}

/**
 * The error signature: the first non-empty line of the error, masked (temp paths, UUIDs,
 * datetimes, times of day, epoch milliseconds, long hex, remaining numbers), cut to
 * SIGNATURE_MAX characters. Two errors of one retry loop share the signature.
 */
export function failureSignature(error) {
  const first = String(error ?? '').split(/\r?\n/).map((l) => l.trim()).find((l) => l) || '';
  return first
    .replace(/(\/(?:var|tmp|temp)\/[^\s"'`]{0,120})/gi, '‹tmp›') // temp paths
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '‹u›') // UUIDs
    .replace(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?Z?/g, '‹t›') // datetimes
    .replace(/\b\d{2}:\d{2}:\d{2}(?:\.\d+)?\b/g, '‹t›') // times of day
    .replace(/\b1\d{12}\b/g, '‹t›') // epoch milliseconds
    .replace(/(?<![0-9a-zA-Z_])[0-9a-f]{12,}(?![0-9a-zA-Z])/gi, '‹h›') // long hex (hashes, message ids)
    .replace(/\d+/g, '#') // remaining numbers
    .slice(0, SIGNATURE_MAX);
}

/**
 * The signature hash (16 hex characters): the state file carries the hash, never the error text.
 */
export function hashSignature(signature) {
  return hash16(signature);
}

/**
 * The path of the mutated file from a mutating shell command (rm, mv, sed -i, tee, git apply),
 * or null. Only the first command segment (before `|`, `&`, `;`, `<`, `>`) is considered; the
 * path is the last non-flag token (rm: the target, mv: the destination, sed/tee/git apply: the
 * last one). Works for Bash and PowerShell input ({command}) and for a string tool input.
 */
export function mutatedFilePath(toolName, toolInput) {
  const commandText = typeof toolInput === 'string' ? toolInput
    : (toolInput && typeof toolInput === 'object' && typeof toolInput.command === 'string' ? toolInput.command : '');
  const segment = String(commandText || '').split(/[|;&<>]/)[0].trim(); // first segment, redirections cut
  if (!segment || (toolName !== 'Bash' && toolName !== 'PowerShell')) return null;
  const tokens = segment.split(/\s+/).filter(Boolean);
  const binary = (tokens[0] || '').split('/').pop(); // /bin/rm works too
  const mutates = (binary === 'rm' || binary === 'mv' || binary === 'tee')
    || (binary === 'sed' && tokens.slice(1).some((x) => x === '-i' || x.startsWith('-i'))) // sed only with -i
    || (binary === 'git' && (tokens[1] || '') === 'apply');
  if (!mutates) return null;
  const target = tokens.slice(1).filter((x) => !x.startsWith('-')).pop(); // the last non-flag token
  if (!target || target.length > 200) return null;
  return target;
}

/**
 * The series key of the repeated-failure counter: a plain error keys (tool, signature hash); a
 * mutating command with a recognized path keys (tool, path hash) instead, so one file ground in
 * a circle by different methods is one series. Returns { signature, hash, path, pathHash, key }.
 */
export function errorSeriesKey(toolName, toolInput, error) {
  const signature = failureSignature(error);
  const hash = hashSignature(signature);
  const path = mutatedFilePath(toolName, toolInput);
  const pathHash = path ? hash16(path) : null;
  const key = pathHash
    ? `mut|${toolName}|${pathHash}` // the path replaces the signature for a mutating command
    : `${toolName}|${hash}`;
  return { signature, hash, path, pathHash, key };
}
