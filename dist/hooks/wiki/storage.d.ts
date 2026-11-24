/**
 * Wiki Storage
 *
 * File I/O layer for the LLM Wiki knowledge base.
 * All write operations go through a wiki-wide mutex (withWikiLock)
 * to prevent concurrent corruption.
 *
 * Storage layout:
 *   .omc/wiki/
 *   ├── index.md      (auto-maintained catalog)
 *   ├── log.md         (append-only operation chronicle)
 *   ├── page-slug.md   (knowledge pages)
 *   └── ...
 */
import { type WikiPage, type WikiPageFrontmatter, type WikiLogEntry } from './types.js';
/** Get the wiki directory path. */
export declare function getWikiDir(root: string): string;
/** Ensure wiki directory exists and is git-ignored. */
export declare function ensureWikiDir(root: string): string;
export interface WikiLockOptions {
    /** Maximum time to wait for the wiki lock. Ordinary callers retain the existing 5s default. */
    timeoutMs?: number;
    /** Optional absolute deadline for worker-owned work. */
    deadlineAt?: number;
}
/**
 * Execute a function under the wiki-wide file lock.
 * All write operations MUST go through this boundary.
 *
 * Uses synchronous file lock (withFileLockSync) because wiki operations
 * are called from sync hook contexts (notepad pattern).
 */
export declare function withWikiLock<T>(root: string, fn: () => T, options?: WikiLockOptions): T;
/**
 * Parse YAML frontmatter from markdown content.
 * Expects content starting with `---\n...\n---\n`.
 */
export declare function parseFrontmatter(raw: string): {
    frontmatter: WikiPageFrontmatter;
    content: string;
} | null;
/**
 * Serialize frontmatter + content to markdown string.
 */
export declare function serializePage(page: WikiPage): string;
/** Read a single wiki page by filename. Returns null if not found or unparseable. */
export declare function readPage(root: string, filename: string): WikiPage | null;
/** List all wiki page filenames (excluding index.md and log.md). */
export declare function listPages(root: string): string[];
/** Read all wiki pages. */
export declare function readAllPages(root: string): WikiPage[];
/** Read index.md content. Returns null if not found. */
export declare function readIndex(root: string): string | null;
/** Read log.md content. Returns null if not found. */
export declare function readLog(root: string): string | null;
/** Write a wiki page to disk. MUST be called inside withWikiLock. */
export declare function writePageUnsafe(root: string, page: WikiPage): void;
/** Delete a wiki page. MUST be called inside withWikiLock. */
export declare function deletePageUnsafe(root: string, filename: string): boolean;
/**
 * Regenerate index.md from all pages. MUST be called inside withWikiLock.
 *
 * Format:
 * # Wiki Index
 * ## Category
 * - [Title](filename) — first line of content
 */
export declare function updateIndexUnsafe(root: string): void;
/** Append a log entry to log.md. MUST be called inside withWikiLock. */
export declare function appendLogUnsafe(root: string, entry: WikiLogEntry): void;
/**
 * Write the reserved environment.md page. MUST be called inside withWikiLock.
 *
 * environment.md is a reserved file (excluded from index/listPages and
 * rejected by writePageUnsafe), so project-memory feeding gets a dedicated
 * write path — mirroring updateIndexUnsafe and appendLogUnsafe.
 */
export declare function writeEnvironmentUnsafe(root: string, page: WikiPage): void;
/** Write a page with automatic locking and index/log update. */
export declare function writePage(root: string, page: WikiPage): void;
/** Delete a page with automatic locking and index update. */
export declare function deletePage(root: string, filename: string): boolean;
/** Append a log entry with automatic locking. */
export declare function appendLog(root: string, entry: WikiLogEntry): void;
/** Convert a title to a filename slug. */
export declare function titleToSlug(title: string): string;
//# sourceMappingURL=storage.d.ts.map