/**
 * Project Memory Formatter
 * Generates context strings for injection
 */
import { ProjectMemory, ProjectMemoryContext } from "./types.js";
/**
 * The writers of the text cleaning module (scripts/lib/context-text-sanitize.mjs) that the summary uses when the
 * caller passes it: identifiers (hot paths, commands) are written exactly with escapeIdentifier, and the summary is
 * fitted to its budget by whole lines with fitLines, so no identifier is cut in half.
 */
export interface SummaryWriters {
    escapeIdentifier(value: unknown, max?: number): string;
    fitLines(value: unknown, max: number): string;
}
/**
 * Format project memory as a concise summary
 * Used for context injection (includes directives for compaction resilience)
 * Without `writers` the summary is the same as it always was.
 */
export declare function formatContextSummary(memory: ProjectMemory, context?: ProjectMemoryContext, writers?: SummaryWriters): string;
export declare function projectMemoryFrameEnabled(env?: NodeJS.ProcessEnv): boolean;
/**
 * Same contract as formatContextSummary, wrapped in the reference-only frame.
 * Identifiers are written exactly (escaped, not cleaned) and the prose is cleaned
 * before the frame is added; the frame sits outside the character budget. An empty
 * summary returns an empty string without the frame. The cleaning module is
 * imported only here, so the default summary does not depend on it. If the import
 * fails, the framed summary is written without cleaning (fail-open).
 */
export declare function formatContextSummaryWithFrame(memory: ProjectMemory, context?: ProjectMemoryContext): Promise<string>;
/**
 * Format project memory as full details (for debugging)
 */
export declare function formatFullContext(memory: ProjectMemory): string;
//# sourceMappingURL=formatter.d.ts.map