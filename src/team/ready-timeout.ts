/**
 * OMC_TEAM_READY_TIMEOUT_MS parsing shared by scale-up (scaling.ts) and the
 * startup inbox wait (tmux-session.ts). Kept dependency-free because
 * scaling.ts already imports tmux-session.ts.
 */

export const READY_TIMEOUT_ENV = "OMC_TEAM_READY_TIMEOUT_MS";

const STARTUP_READY_TIMEOUT_MIN_MS = 30_000;
// The startup wait runs inside the launch-attempt fence, so a long value
// would hold stop and retire for its whole length.
const STARTUP_READY_TIMEOUT_MAX_MS = 120_000;

const DECIMAL_INTEGER_TEXT =
  /^(?:(\d+)(?:\.(\d*))?|\.(\d+))(?:[eE]([+-]?\d+))?$/;

function parseExactInteger(raw: string): number | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  const negative = trimmed.startsWith("-");
  const magnitude =
    negative || trimmed.startsWith("+") ? trimmed.slice(1) : trimmed;
  const match = DECIMAL_INTEGER_TEXT.exec(magnitude);
  if (!match) return undefined;
  const integerDigits = match[1] ?? "";
  const fractionDigits = match[2] ?? match[3] ?? "";
  const exponent = match[4] === undefined ? 0 : Number(match[4]);
  const shift = fractionDigits.length - exponent;
  if (shift > 0) {
    const significand = integerDigits + fractionDigits;
    if (/[1-9]/.test(significand)) {
      const trailingZeros =
        significand.length - significand.replace(/0+$/, "").length;
      if (trailingZeros < shift) return undefined;
    }
  }
  const parsed = (negative ? -1 : 1) * Number(magnitude);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

/**
 * The variable as an exact integer, or undefined when it is unset, blank, or
 * not an integer (`abc`, `1.5`, `NaN`, `Infinity`). Rejecting before any
 * clamp matters: `Math.max(30000, NaN)` is NaN.
 */
export function parseReadyTimeoutMs(
  env: NodeJS.ProcessEnv,
): number | undefined {
  const raw = env[READY_TIMEOUT_ENV];
  return raw == null ? undefined : parseExactInteger(String(raw));
}

/** Startup wait: the variable clamped to 30000..120000ms, else 30000ms. */
export function resolveStartupReadyTimeoutMs(env: NodeJS.ProcessEnv): number {
  const parsed = parseReadyTimeoutMs(env);
  if (parsed === undefined) return STARTUP_READY_TIMEOUT_MIN_MS;
  return Math.min(
    Math.max(STARTUP_READY_TIMEOUT_MIN_MS, parsed),
    STARTUP_READY_TIMEOUT_MAX_MS,
  );
}

const DISPLAY_MAX_CHARS = 32;
// JSON.stringify already escapes C0 controls, quotes and lone surrogates; this
// catches what it leaves raw: DEL, C1 (U+009B is a terminal CSI), line and
// paragraph separators, and bidi controls (U+061C included) that reorder the
// rest of the line.
const UNSAFE_DISPLAY_CHARS = /[\u007f-\u009f\u2028\u2029\p{Bidi_Control}]/gu;

function displayValue(raw: string): string {
  if (/^[\x21-\x7e]{1,32}$/.test(raw)) return raw;
  const quoted = JSON.stringify(raw.slice(0, DISPLAY_MAX_CHARS)).replace(
    UNSAFE_DISPLAY_CHARS,
    (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
  return raw.length > DISPLAY_MAX_CHARS
    ? `${quoted}... (truncated, ${raw.length} chars)`
    : quoted;
}

/**
 * One-line note on what the variable was set to and the wait the caller used.
 */
export function describeStartupReadyTimeout(
  env: NodeJS.ProcessEnv,
  effectiveMs: number,
): string {
  const raw = env[READY_TIMEOUT_ENV];
  const setting =
    raw == null
      ? `${READY_TIMEOUT_ENV} unset`
      : `${READY_TIMEOUT_ENV}=${displayValue(raw)}`;
  return (
    `${setting} (effective ${effectiveMs}ms; ` +
    `startup wait is clamped to ${STARTUP_READY_TIMEOUT_MIN_MS}..${STARTUP_READY_TIMEOUT_MAX_MS}ms)`
  );
}
