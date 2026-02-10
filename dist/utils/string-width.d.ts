/**
 * CJK-aware String Width Utilities
 *
 * Provides functions for calculating visual width of strings containing
 * CJK (Chinese, Japanese, Korean) characters, which are typically displayed
 * as double-width in terminal emulators.
 *
 * This is a lightweight implementation without external dependencies.
 * For full Unicode support, consider using the 'string-width' npm package.
 *
 * Related: Issue #344 - Korean IME input visibility
 */
/**
 * Check if a character code point is a CJK (double-width) character.
 *
 * This covers the main CJK Unicode ranges:
 * - CJK Unified Ideographs
 * - Hangul Syllables
 * - Hiragana and Katakana
 * - Full-width ASCII and punctuation
 * - CJK Compatibility Ideographs
 */
export declare function isCJKCharacter(codePoint: number): boolean;
/**
 * Check if a character is a zero-width character.
 * These characters don't contribute to visual width.
 */
export declare function isZeroWidth(codePoint: number): boolean;
/**
 * Get the visual width of a single character.
 * - CJK characters: 2 (double-width)
 * - Zero-width characters: 0
 * - Regular ASCII and most others: 1
 */
export declare function getCharWidth(char: string): number;
/**
 * Calculate the visual width of a string in terminal columns.
 * Accounts for CJK double-width characters.
 *
 * Note: This strips ANSI escape codes before calculating width.
 *
 * @param str - The string to measure
 * @returns Visual width in terminal columns
 */
export declare function stringWidth(str: string): number;
/**
 * Strip ANSI escape codes from a string.
 */
export declare function stripAnsi(str: string): string;
/**
 * Truncate a string to fit within a maximum visual width.
 * CJK-aware: accounts for double-width characters.
 *
 * @param str - The string to truncate
 * @param maxWidth - Maximum visual width in terminal columns
 * @param suffix - Suffix to append if truncated (default: "...")
 * @returns Truncated string that fits within maxWidth
 */
export declare function truncateToWidth(str: string, maxWidth: number, suffix?: string): string;
/**
 * Pad a string to a minimum visual width (right-pad with spaces).
 * CJK-aware: accounts for double-width characters.
 *
 * @param str - The string to pad
 * @param minWidth - Minimum visual width
 * @param padChar - Character to pad with (default: space)
 * @returns Padded string
 */
export declare function padToWidth(str: string, minWidth: number, padChar?: string): string;
/**
 * Slice a string by visual width instead of character count.
 * CJK-aware: accounts for double-width characters.
 *
 * @param str - The string to slice
 * @param startWidth - Start position in visual columns (0-based)
 * @param endWidth - End position in visual columns (exclusive)
 * @returns Sliced string
 */
export declare function sliceByWidth(str: string, startWidth: number, endWidth?: number): string;
//# sourceMappingURL=string-width.d.ts.map