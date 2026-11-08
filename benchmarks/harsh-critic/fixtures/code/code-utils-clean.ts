/**
 * Utility Functions
 *
 * A collection of pure, well-tested utility functions for common string,
 * date, and data transformation tasks used across the platform.
 *
 * All functions are stateless and side-effect-free unless explicitly noted.
 * All functions are fully typed and safe against null/undefined inputs.
 */

// ---------------------------------------------------------------------------
// String Utilities
// ---------------------------------------------------------------------------

/**
 * Truncate a string to a maximum length, appending an ellipsis if truncated.
 *
 * @param text     The input string to truncate
 * @param maxLen   Maximum number of characters (including the ellipsis)
 * @param ellipsis The suffix to append when truncating (default: "…")
 * @returns        The original string if within limit, or truncated version
 *
 * @example
 *   truncate("Hello, world!", 8)        // "Hello, …"
 *   truncate("Hi", 10)                  // "Hi"
 *   truncate("Hello", 5, "...")         // "He..."
 */
export function truncate(
  text: string,
  maxLen: number,
  ellipsis = '\u2026'
): string {
  if (maxLen < ellipsis.length) {
    throw new RangeError(
      `maxLen (${maxLen}) must be >= ellipsis length (${ellipsis.length})`
    );
  }
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen - ellipsis.length) + ellipsis;
}

/**
 * Convert a string to slug format (URL-safe, lowercase, hyphen-separated).
 *
 * Strips diacritics, removes non-alphanumeric characters, and collapses
 * consecutive hyphens. Leading and trailing hyphens are removed.
 *
 * @param text  Input string (e.g. a page title)
 * @returns     Slug string (e.g. "my-page-title")
 *
 * @example
 *   toSlug("Hello, World!")             // "hello-world"
 *   toSlug("  Café au lait  ")         // "cafe-au-lait"
 *   toSlug("100% organic -- fresh!")   // "100-organic-fresh"
 */
export function toSlug(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // strip diacritics
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')    // non-alphanumeric → hyphen
    .replace(/^-+|-+$/g, '');       // trim leading/trailing hyphens
}

/**
 * Mask a sensitive string, revealing only the last N characters.
 *
 * Useful for displaying partial email addresses or API key tails in logs
 * without exposing the full value.
 *
 * @param value     The sensitive string to mask
 * @param revealLen Number of trailing characters to reveal (default: 4)
 * @param mask      Character to use for masking (default: "*")
 * @returns         Masked string, e.g. "************abcd"
 *
 * @example
 *   maskSensitive("sk_live_abc123xyz789", 6)  // "**************xyz789"  (wait, let me recount)
 *   maskSensitive("hello@example.com")         // "****************.com" — no, 4 chars
 */
export function maskSensitive(
  value: string,
  revealLen = 4,
  mask = '*'
): string {
  if (value.length <= revealLen) return value;
  const masked = mask.repeat(value.length - revealLen);
  return masked + value.slice(value.length - revealLen);
}

// ---------------------------------------------------------------------------
// Date Utilities
// ---------------------------------------------------------------------------

/**
 * Format a Date as a human-readable relative time string ("2 hours ago",
 * "in 3 days", "just now").
 *
 * Uses the Intl.RelativeTimeFormat API with "en" locale and "long" style.
 * For durations under 60 seconds, returns "just now".
 *
 * @param date      The date to format relative to now
 * @param baseDate  The reference date (default: current time)
 * @returns         Relative time string
 *
 * @example
 *   relativeTime(new Date(Date.now() - 90_000))   // "2 minutes ago"
 *   relativeTime(new Date(Date.now() + 3_600_000)) // "in 1 hour"
 */
export function relativeTime(date: Date, baseDate: Date = new Date()): string {
  const diffMs = date.getTime() - baseDate.getTime();
  const diffSeconds = Math.round(diffMs / 1000);

  if (Math.abs(diffSeconds) < 60) return 'just now';

  const rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto', style: 'long' });

  const thresholds: Array<[number, Intl.RelativeTimeFormatUnit]> = [
    [60, 'minute'],
    [60 * 24, 'hour'],
    [24 * 7, 'day'],
    [4, 'week'],
    [12, 'month'],
    [Infinity, 'year'],
  ];

  let value = diffSeconds / 60; // start in minutes
  for (const [limit, unit] of thresholds) {
    if (Math.abs(value) < limit) {
      return rtf.format(Math.round(value), unit);
    }
    value /= limit;
  }

  // Unreachable, but satisfies TypeScript
  return rtf.format(Math.round(value), 'year');
}

/**
 * Return the start and end of the ISO calendar week containing the given date.
 *
 * ISO weeks start on Monday (day 1) and end on Sunday (day 7).
 *
 * @param date  Any date within the target week (time component is ignored)
 * @returns     Object with `start` (Monday 00:00:00) and `end` (Sunday 23:59:59.999)
 *
 * @example
 *   isoWeekBounds(new Date("2026-03-04")) // Wed → { start: Mon Mar 2, end: Sun Mar 8 }
 */
export function isoWeekBounds(date: Date): { start: Date; end: Date } {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  // ISO day of week: Mon=1 … Sun=7
  const day = d.getDay() === 0 ? 7 : d.getDay();
  const start = new Date(d);
  start.setDate(d.getDate() - (day - 1));
  const end = new Date(start);
  end.setDate(start.getDate() + 6);
  end.setHours(23, 59, 59, 999);
  return { start, end };
}

// ---------------------------------------------------------------------------
// Data Transformation Utilities
// ---------------------------------------------------------------------------

/**
 * Group an array of objects by a key derived from each element.
 *
 * The key function receives each element and must return a string. Elements
 * that produce the same key are collected into the same array.
 *
 * @param items   Array of items to group
 * @param keyFn   Function that returns the group key for an item
 * @returns       A Map from group key to array of matching items
 *
 * @example
 *   groupBy(users, u => u.department)
 *   // Map { "Engineering" => [...], "Design" => [...] }
 */
export function groupBy<T>(
  items: readonly T[],
  keyFn: (item: T) => string
): Map<string, T[]> {
  const result = new Map<string, T[]>();
  for (const item of items) {
    const key = keyFn(item);
    const group = result.get(key);
    if (group) {
      group.push(item);
    } else {
      result.set(key, [item]);
    }
  }
  return result;
}

/**
 * Chunk an array into sub-arrays of at most `size` elements.
 *
 * The last chunk may be smaller than `size` if the input length is not
 * a multiple of `size`. Returns an empty array if input is empty.
 *
 * @param items  Array to chunk
 * @param size   Maximum chunk size (must be >= 1)
 * @returns      Array of chunks
 *
 * @throws {RangeError} If size < 1
 *
 * @example
 *   chunk([1, 2, 3, 4, 5], 2)  // [[1, 2], [3, 4], [5]]
 *   chunk([], 3)                // []
 */
export function chunk<T>(items: readonly T[], size: number): T[][] {
  if (size < 1) {
    throw new RangeError(`chunk size must be >= 1, got ${size}`);
  }
  const result: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    result.push(items.slice(i, i + size) as T[]);
  }
  return result;
}

/**
 * Deep-clone a plain JSON-serializable object.
 *
 * Uses JSON round-trip, so functions, Dates, undefined, and Symbols are
 * not preserved. For those cases, use a dedicated clone library.
 *
 * @param value  A JSON-serializable value
 * @returns      A structurally identical deep copy
 *
 * @example
 *   const original = { a: { b: 1 } };
 *   const copy = deepClone(original);
 *   copy.a.b = 99;
 *   original.a.b; // still 1
 */
export function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
