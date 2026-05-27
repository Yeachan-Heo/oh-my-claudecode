/**
 * Wiki Types
 *
 * Type definitions for the LLM Wiki knowledge layer.
 * Inspired by Karpathy's LLM Wiki concept — persistent, self-maintained
 * markdown knowledge base that compounds over time.
 */

// ============================================================================
// Page Schema
// ============================================================================

/** Current schema version for wiki pages. Bump on breaking frontmatter changes. */
export const WIKI_SCHEMA_VERSION = 1;

/** YAML frontmatter for a wiki page. */
export interface WikiPageFrontmatter {
  /** Page title (human-readable) */
  title: string;
  /** Searchable tags */
  tags: string[];
  /** ISO timestamp of page creation */
  created: string;
  /** ISO timestamp of last update */
  updated: string;
  /** Session IDs or sources that contributed to this page */
  sources: string[];
  /** Filenames of linked pages (cross-references) */
  links: string[];
  /** Page category */
  category: WikiCategory;
  /** Confidence level of the knowledge */
  confidence: 'high' | 'medium' | 'low';
  /** Schema version for future migration support */
  schemaVersion: number;
}

/** Supported page categories.
 * Orthogonal taxonomy — each answers a different question:
 *   architecture  → what IS the system (structure, components, data models)
 *   decision      → WHY it was built that way (ADRs, tradeoffs, rejected alternatives)
 *   guide         → HOW to work with it (patterns, conventions, coding standards, workflows)
 *   setup         → HOW to run/configure it (environment, dependencies, onboarding)
 *   finding       → WHAT was learned empirically (bugs, gotchas, experiments, perf)
 *   reference     → WHERE external knowledge lives (third-party docs, specs, links)
 *   log           → WHAT happened (auto-captured session logs, incident records)
 */
export type WikiCategory =
  | 'architecture'
  | 'decision'
  | 'guide'
  | 'setup'
  | 'finding'
  | 'reference'
  | 'log';

/** A wiki page: frontmatter + markdown content + filename. */
export interface WikiPage {
  /** Filename without path (e.g., "auth-architecture.md") */
  filename: string;
  /** Parsed YAML frontmatter */
  frontmatter: WikiPageFrontmatter;
  /** Markdown content (everything after the frontmatter) */
  content: string;
}

// ============================================================================
// Operations
// ============================================================================

/** Log entry for wiki operations (appended to log.md). */
export interface WikiLogEntry {
  /** ISO timestamp */
  timestamp: string;
  /** Type of operation */
  operation: 'ingest' | 'query' | 'lint' | 'add' | 'delete';
  /** Filenames of pages affected */
  pagesAffected: string[];
  /** Human-readable summary */
  summary: string;
}

/** Input for the ingest operation. */
export interface WikiIngestInput {
  /** Page title */
  title: string;
  /** Markdown content to ingest */
  content: string;
  /** Searchable tags */
  tags: string[];
  /** Page category */
  category: WikiCategory;
  /** Source identifier (e.g., session ID) */
  sources?: string[];
  /** Confidence level */
  confidence?: 'high' | 'medium' | 'low';
}

/** Result of an ingest operation. */
export interface WikiIngestResult {
  /** Pages that were created */
  created: string[];
  /** Pages that were updated (merged) */
  updated: string[];
  /** Total pages affected */
  totalAffected: number;
}

/** Options for wiki query. */
export interface WikiQueryOptions {
  /** Filter by tags (OR match) */
  tags?: string[];
  /** Filter by category */
  category?: WikiCategory;
  /** Maximum results to return */
  limit?: number;
}

/** A single query match. */
export interface WikiQueryMatch {
  /** The matched page */
  page: WikiPage;
  /** Relevance snippet showing the match context */
  snippet: string;
  /** Match score (higher = more relevant) */
  score: number;
}

// ============================================================================
// Lint
// ============================================================================

/** Severity levels for lint issues. */
export type WikiLintSeverity = 'error' | 'warning' | 'info';

/** Types of lint issues. */
export type WikiLintIssueType =
  | 'orphan'
  | 'stale'
  | 'broken-ref'
  | 'low-confidence'
  | 'oversized'
  | 'structural-contradiction';

/** A single lint issue. */
export interface WikiLintIssue {
  /** Page with the issue */
  page: string;
  /** Severity level */
  severity: WikiLintSeverity;
  /** Issue type */
  type: WikiLintIssueType;
  /** Human-readable description */
  message: string;
}

/** Full lint report. */
export interface WikiLintReport {
  /** All issues found */
  issues: WikiLintIssue[];
  /** Summary statistics */
  stats: {
    totalPages: number;
    orphanCount: number;
    staleCount: number;
    brokenRefCount: number;
    lowConfidenceCount: number;
    oversizedCount: number;
    contradictionCount: number;
  };
}

// ============================================================================
// Configuration
// ============================================================================

/**
 * Maps legacy category names to their canonical replacements.
 * Used to migrate existing wiki pages written before the 7-category taxonomy.
 */
export const LEGACY_CATEGORY_MAP: Record<string, WikiCategory> = {
  'debugging':    'finding',
  'pattern':      'guide',
  'convention':   'guide',
  'environment':  'setup',
  'session-log':  'log',
};

/**
 * Normalize a category string, mapping legacy names to current canonical ones.
 * Returns the input unchanged if it is already a valid current category.
 */
export function normalizeCategory(cat: string): WikiCategory {
  return (LEGACY_CATEGORY_MAP[cat] ?? cat) as WikiCategory;
}

// ============================================================================

/** Wiki configuration (from .omc-config.json). */
export interface WikiConfig {
  /** Whether auto-capture is enabled at session end (default: true) */
  autoCapture: boolean;
  /** Days after which a page is considered stale (default: 30) */
  staleDays: number;
  /** Maximum page content size in bytes before lint warns (default: 10240) */
  maxPageSize: number;
}

/** Default wiki configuration. */
export const DEFAULT_WIKI_CONFIG: WikiConfig = {
  autoCapture: true,
  staleDays: 30,
  maxPageSize: 10_240, // 10KB
};
