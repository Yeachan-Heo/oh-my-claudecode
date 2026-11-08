/**
 * Wiki Ingest
 *
 * Processes knowledge into wiki pages. A single ingest can create a new page
 * or merge into an existing one (append strategy — never replaces content).
 */
import { type WikiIngestInput, type WikiIngestResult } from './types.js';
/**
 * Ingest knowledge into the wiki.
 *
 * If a page with the same slug exists, merges content (append strategy):
 * - Frontmatter: union tags, append sources, update timestamp, keep higher confidence
 * - Content: append new content as a timestamped section (never replace)
 *
 * @param root - Project root directory
 * @param input - Knowledge to ingest
 * @returns Result with created/updated page lists
 */
export declare function ingestKnowledge(root: string, input: WikiIngestInput): WikiIngestResult;
//# sourceMappingURL=ingest.d.ts.map