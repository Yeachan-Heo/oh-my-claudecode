/**
 * Wiki Lint
 *
 * Health checks for the wiki knowledge base.
 * Detects orphan pages, stale content, broken cross-references,
 * oversized pages, and structural contradictions.
 */
import { type WikiLintReport, type WikiConfig } from './types.js';
/**
 * Run health checks on the wiki.
 *
 * Checks performed:
 * 1. Orphan pages — no incoming [[links]] from other pages
 * 2. Stale pages — not updated in `staleDays` days
 * 3. Broken cross-references — [[links]] to non-existent pages
 * 4. Low confidence — pages marked as `confidence: low`
 * 5. Oversized — content exceeds `maxPageSize` bytes
 * 6. Structural contradictions — same topic with conflicting confidence/category
 *
 * @param root - Project root directory
 * @param config - Wiki configuration (uses defaults if not provided)
 * @returns Lint report with issues and stats
 */
export declare function lintWiki(root: string, config?: WikiConfig): WikiLintReport;
//# sourceMappingURL=lint.d.ts.map