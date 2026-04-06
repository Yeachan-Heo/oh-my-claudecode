/**
 * Wiki MCP Tools
 *
 * Provides 7 tools for the LLM Wiki knowledge layer:
 * wiki_ingest, wiki_query, wiki_lint, wiki_add, wiki_list, wiki_read, wiki_delete
 */

import { z } from 'zod';
import {
  validateWorkingDirectory,
} from '../lib/worktree-paths.js';
import {
  readPage,
  listPages,
  readIndex,
  deletePage,
  appendLog,
  titleToSlug,
} from '../hooks/wiki/index.js';
import { ingestKnowledge } from '../hooks/wiki/ingest.js';
import { queryWiki } from '../hooks/wiki/query.js';
import { lintWiki } from '../hooks/wiki/lint.js';
import type { WikiCategory } from '../hooks/wiki/types.js';
import { ToolDefinition } from './types.js';

const WIKI_CATEGORIES: [string, ...string[]] = [
  'architecture', 'decision', 'pattern', 'debugging',
  'environment', 'session-log', 'reference', 'convention',
];

// ============================================================================
// wiki_ingest
// ============================================================================

export const wikiIngestTool: ToolDefinition<{
  title: z.ZodString;
  content: z.ZodString;
  tags: z.ZodArray<z.ZodString>;
  category: z.ZodEnum<typeof WIKI_CATEGORIES>;
  sources: z.ZodOptional<z.ZodArray<z.ZodString>>;
  confidence: z.ZodOptional<z.ZodEnum<['high', 'medium', 'low']>>;
  workingDirectory: z.ZodOptional<z.ZodString>;
}> = {
  name: 'wiki_ingest',
  description: 'Process knowledge into wiki pages. Creates new pages or merges into existing ones (append strategy — never replaces). A single ingest can update multiple pages via cross-references.',
  schema: {
    title: z.string().max(200).describe('Page title (used to generate filename slug, max 200 chars)'),
    content: z.string().max(50_000).describe('Markdown content to ingest (max 50KB)'),
    tags: z.array(z.string().max(50)).max(20).describe('Searchable tags (max 20 tags, 50 chars each)'),
    category: z.enum(WIKI_CATEGORIES).describe('Page category'),
    sources: z.array(z.string().max(100)).max(10).optional().describe('Source identifiers (e.g., session IDs)'),
    confidence: z.enum(['high', 'medium', 'low']).optional().describe('Confidence level (default: medium)'),
    workingDirectory: z.string().optional().describe('Working directory (defaults to cwd)'),
  },
  handler: async (args) => {
    try {
      const root = validateWorkingDirectory(args.workingDirectory);

      const result = ingestKnowledge(root, {
        title: args.title,
        content: args.content,
        tags: args.tags,
        category: args.category as WikiCategory,
        sources: args.sources,
        confidence: args.confidence as 'high' | 'medium' | 'low' | undefined,
      });

      return {
        content: [{
          type: 'text' as const,
          text: `Wiki ingest complete.\n- Created: ${result.created.join(', ') || 'none'}\n- Updated: ${result.updated.join(', ') || 'none'}\n- Total affected: ${result.totalAffected}`,
        }],
      };
    } catch (error) {
      return {
        content: [{
          type: 'text' as const,
          text: `Error ingesting into wiki: ${error instanceof Error ? error.message : String(error)}`,
        }],
        isError: true,
      };
    }
  },
};

// ============================================================================
// wiki_query
// ============================================================================

export const wikiQueryTool: ToolDefinition<{
  query: z.ZodString;
  tags: z.ZodOptional<z.ZodArray<z.ZodString>>;
  category: z.ZodOptional<z.ZodEnum<typeof WIKI_CATEGORIES>>;
  limit: z.ZodOptional<z.ZodNumber>;
  workingDirectory: z.ZodOptional<z.ZodString>;
}> = {
  name: 'wiki_query',
  description: 'Search across all wiki pages by keywords and tags. Returns matching pages with relevance snippets. YOU synthesize answers with citations from the results — the tool returns raw matches only. NO vector embeddings.',
  schema: {
    query: z.string().describe('Search text (matched against title, tags, and content)'),
    tags: z.array(z.string()).optional().describe('Filter by tags (OR match)'),
    category: z.enum(WIKI_CATEGORIES).optional().describe('Filter by category'),
    limit: z.number().int().min(1).max(50).optional().describe('Max results (default: 20)'),
    workingDirectory: z.string().optional().describe('Working directory (defaults to cwd)'),
  },
  handler: async (args) => {
    try {
      const root = validateWorkingDirectory(args.workingDirectory);
      const matches = queryWiki(root, args.query, {
        tags: args.tags,
        category: args.category as WikiCategory | undefined,
        limit: args.limit,
      });

      if (matches.length === 0) {
        return {
          content: [{
            type: 'text' as const,
            text: `No wiki pages match "${args.query}".`,
          }],
        };
      }

      const results = matches.map((m, i) => {
        const fm = m.page.frontmatter;
        return `### ${i + 1}. ${fm.title} (${fm.category}, ${fm.confidence})\n` +
          `**File:** ${m.page.filename} | **Tags:** ${fm.tags.join(', ')} | **Score:** ${m.score}\n` +
          `**Snippet:** ${m.snippet}`;
      });

      return {
        content: [{
          type: 'text' as const,
          text: `## Wiki Query: "${args.query}"\n\n${matches.length} results:\n\n${results.join('\n\n')}`,
        }],
      };
    } catch (error) {
      return {
        content: [{
          type: 'text' as const,
          text: `Error querying wiki: ${error instanceof Error ? error.message : String(error)}`,
        }],
        isError: true,
      };
    }
  },
};

// ============================================================================
// wiki_lint
// ============================================================================

export const wikiLintTool: ToolDefinition<{
  workingDirectory: z.ZodOptional<z.ZodString>;
}> = {
  name: 'wiki_lint',
  description: 'Run health checks on the wiki. Detects orphan pages, stale content, broken cross-references, oversized pages, and structural contradictions.',
  schema: {
    workingDirectory: z.string().optional().describe('Working directory (defaults to cwd)'),
  },
  handler: async (args) => {
    try {
      const root = validateWorkingDirectory(args.workingDirectory);
      const report = lintWiki(root);

      if (report.issues.length === 0) {
        return {
          content: [{
            type: 'text' as const,
            text: `Wiki lint: ${report.stats.totalPages} pages, no issues found.`,
          }],
        };
      }

      const issueLines = report.issues.map(i =>
        `- [${i.severity.toUpperCase()}] ${i.type}: ${i.message}`
      );

      return {
        content: [{
          type: 'text' as const,
          text: `## Wiki Lint Report\n\n` +
            `**${report.stats.totalPages} pages**, ${report.issues.length} issues:\n\n` +
            issueLines.join('\n') +
            `\n\n**Summary:** ${report.stats.orphanCount} orphan, ${report.stats.staleCount} stale, ` +
            `${report.stats.brokenRefCount} broken refs, ${report.stats.contradictionCount} contradictions, ` +
            `${report.stats.oversizedCount} oversized`,
        }],
      };
    } catch (error) {
      return {
        content: [{
          type: 'text' as const,
          text: `Error linting wiki: ${error instanceof Error ? error.message : String(error)}`,
        }],
        isError: true,
      };
    }
  },
};

// ============================================================================
// wiki_add
// ============================================================================

export const wikiAddTool: ToolDefinition<{
  title: z.ZodString;
  content: z.ZodString;
  tags: z.ZodOptional<z.ZodArray<z.ZodString>>;
  category: z.ZodOptional<z.ZodEnum<typeof WIKI_CATEGORIES>>;
  workingDirectory: z.ZodOptional<z.ZodString>;
}> = {
  name: 'wiki_add',
  description: 'Quick-add a wiki page. Simpler than wiki_ingest — creates a single page directly.',
  schema: {
    title: z.string().max(200).describe('Page title (max 200 chars)'),
    content: z.string().max(50_000).describe('Page content in markdown (max 50KB)'),
    tags: z.array(z.string().max(50)).max(20).optional().describe('Tags (default: [])'),
    category: z.enum(WIKI_CATEGORIES).optional().describe('Category (default: reference)'),
    workingDirectory: z.string().optional().describe('Working directory (defaults to cwd)'),
  },
  handler: async (args) => {
    try {
      const root = validateWorkingDirectory(args.workingDirectory);
      const slug = titleToSlug(args.title);

      // Guard: reject if page already exists — use wiki_ingest to merge
      if (readPage(root, slug)) {
        return {
          content: [{
            type: 'text' as const,
            text: `Page "${slug}" already exists. Use wiki_ingest to merge content into it, or wiki_delete to remove it first.`,
          }],
          isError: true,
        };
      }

      // Delegate to ingest for consistent page creation
      const result = ingestKnowledge(root, {
        title: args.title,
        content: args.content,
        tags: args.tags || [],
        category: (args.category || 'reference') as WikiCategory,
      });

      return {
        content: [{
          type: 'text' as const,
          text: `Wiki page created: ${result.created[0]}\nPath: .omc/wiki/${result.created[0]}`,
        }],
      };
    } catch (error) {
      return {
        content: [{
          type: 'text' as const,
          text: `Error adding wiki page: ${error instanceof Error ? error.message : String(error)}`,
        }],
        isError: true,
      };
    }
  },
};

// ============================================================================
// wiki_list
// ============================================================================

export const wikiListTool: ToolDefinition<{
  workingDirectory: z.ZodOptional<z.ZodString>;
}> = {
  name: 'wiki_list',
  description: 'List all wiki pages with summaries. Reads the auto-maintained index.',
  schema: {
    workingDirectory: z.string().optional().describe('Working directory (defaults to cwd)'),
  },
  handler: async (args) => {
    try {
      const root = validateWorkingDirectory(args.workingDirectory);
      const index = readIndex(root);

      if (!index) {
        const pages = listPages(root);
        if (pages.length === 0) {
          return {
            content: [{
              type: 'text' as const,
              text: 'Wiki is empty. Use wiki_add or wiki_ingest to create pages.',
            }],
          };
        }
        return {
          content: [{
            type: 'text' as const,
            text: `Wiki has ${pages.length} pages but no index. Pages:\n${pages.map(p => `- ${p}`).join('\n')}`,
          }],
        };
      }

      return {
        content: [{
          type: 'text' as const,
          text: index,
        }],
      };
    } catch (error) {
      return {
        content: [{
          type: 'text' as const,
          text: `Error listing wiki: ${error instanceof Error ? error.message : String(error)}`,
        }],
        isError: true,
      };
    }
  },
};

// ============================================================================
// wiki_read
// ============================================================================

export const wikiReadTool: ToolDefinition<{
  page: z.ZodString;
  workingDirectory: z.ZodOptional<z.ZodString>;
}> = {
  name: 'wiki_read',
  description: 'Read a specific wiki page by filename (without .md extension is OK).',
  schema: {
    page: z.string().describe('Page filename or slug (e.g., "auth-architecture" or "auth-architecture.md")'),
    workingDirectory: z.string().optional().describe('Working directory (defaults to cwd)'),
  },
  handler: async (args) => {
    try {
      const root = validateWorkingDirectory(args.workingDirectory);
      const filename = args.page.endsWith('.md') ? args.page : `${args.page}.md`;
      const page = readPage(root, filename);

      if (!page) {
        return {
          content: [{
            type: 'text' as const,
            text: `Wiki page not found: ${filename}`,
          }],
          isError: true,
        };
      }

      const fm = page.frontmatter;
      const header = [
        `## ${fm.title}`,
        `**Category:** ${fm.category} | **Confidence:** ${fm.confidence} | **Updated:** ${fm.updated}`,
        `**Tags:** ${fm.tags.join(', ')}`,
        fm.links.length > 0 ? `**Links:** ${fm.links.join(', ')}` : '',
        fm.sources.length > 0 ? `**Sources:** ${fm.sources.join(', ')}` : '',
        '',
      ].filter(Boolean).join('\n');

      return {
        content: [{
          type: 'text' as const,
          text: `${header}\n${page.content}`,
        }],
      };
    } catch (error) {
      return {
        content: [{
          type: 'text' as const,
          text: `Error reading wiki page: ${error instanceof Error ? error.message : String(error)}`,
        }],
        isError: true,
      };
    }
  },
};

// ============================================================================
// wiki_delete
// ============================================================================

export const wikiDeleteTool: ToolDefinition<{
  page: z.ZodString;
  workingDirectory: z.ZodOptional<z.ZodString>;
}> = {
  name: 'wiki_delete',
  description: 'Delete a wiki page by filename.',
  schema: {
    page: z.string().describe('Page filename or slug to delete'),
    workingDirectory: z.string().optional().describe('Working directory (defaults to cwd)'),
  },
  handler: async (args) => {
    try {
      const root = validateWorkingDirectory(args.workingDirectory);
      const filename = args.page.endsWith('.md') ? args.page : `${args.page}.md`;
      const deleted = deletePage(root, filename);

      if (!deleted) {
        return {
          content: [{
            type: 'text' as const,
            text: `Wiki page not found: ${filename}`,
          }],
          isError: true,
        };
      }

      appendLog(root, {
        timestamp: new Date().toISOString(),
        operation: 'delete',
        pagesAffected: [filename],
        summary: `Deleted page "${filename}"`,
      });

      return {
        content: [{
          type: 'text' as const,
          text: `Deleted wiki page: ${filename}`,
        }],
      };
    } catch (error) {
      return {
        content: [{
          type: 'text' as const,
          text: `Error deleting wiki page: ${error instanceof Error ? error.message : String(error)}`,
        }],
        isError: true,
      };
    }
  },
};

// ============================================================================
// Export all wiki tools
// ============================================================================

export const wikiTools = [
  wikiIngestTool,
  wikiQueryTool,
  wikiLintTool,
  wikiAddTool,
  wikiListTool,
  wikiReadTool,
  wikiDeleteTool,
];
