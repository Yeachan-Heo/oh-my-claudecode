/**
 * Simple JSONC (JSON with Comments) parser
 *
 * Strips single-line (//) and multi-line (slash-star) comments and trailing
 * commas from JSONC before parsing with standard JSON.parse.
 */
/**
 * Parse JSONC content by stripping comments and parsing as JSON
 */
export declare function parseJsonc(content: string): unknown;
/**
 * Strip comments and trailing commas from JSONC content
 * Handles single-line (//) and multi-line comments, and trailing commas
 * before a closing brace or bracket. Commas inside string literals are
 * preserved because string contents are copied verbatim.
 */
export declare function stripJsoncComments(content: string): string;
//# sourceMappingURL=jsonc.d.ts.map