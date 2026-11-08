import { z } from 'zod';
import {
  searchSessionHistory,
  type SessionHistorySearchOptions,
} from '../features/session-history-search/index.js';
import { ToolDefinition } from './types.js';

function buildToolJson(report: Awaited<ReturnType<typeof searchSessionHistory>>): string {
  return JSON.stringify(report, null, 2);
}

export const sessionSearchTool: ToolDefinition<{
  query: z.ZodString;
  limit: z.ZodOptional<z.ZodNumber>;
  sessionId: z.ZodOptional<z.ZodString>;
  since: z.ZodOptional<z.ZodString>;
  project: z.ZodOptional<z.ZodString>;
  caseSensitive: z.ZodOptional<z.ZodBoolean>;
  contextChars: z.ZodOptional<z.ZodNumber>;
  workingDirectory: z.ZodOptional<z.ZodString>;
}> = {
  name: 'session_search',
  description: 'Search prior local session history and transcript artifacts. Returns structured JSON with session ids, timestamps, source paths, and matching excerpts.',
  schema: {
    query: z.string().min(1).describe('Text query to search for in prior session history'),
    limit: z.number().int().positive().optional().describe('Maximum number of matches to return (default: 10)'),
    sessionId: z.string().optional().describe('Restrict search to a specific session id'),
    since: z.string().optional().describe('Only include matches since a relative duration (e.g. 7d, 24h) or absolute date'),
    project: z.string().optional().describe('Project filter. Defaults to current project. Use "all" to search across all local Claude projects.'),
    caseSensitive: z.boolean().optional().describe('Whether to match case-sensitively (default: false)'),
    contextChars: z.number().int().positive().optional().describe('Approximate snippet context on each side of a match (default: 120)'),
    workingDirectory: z.string().optional().describe('Working directory used to determine the current project scope'),
  },
  handler: async (args) => {
    try {
      const report = await searchSessionHistory(args as SessionHistorySearchOptions);
      return {
        content: [{
          type: 'text' as const,
          text: buildToolJson(report),
        }],
      };
    } catch (error) {
      return {
        content: [{
          type: 'text' as const,
          text: `Error searching session history: ${error instanceof Error ? error.message : String(error)}`,
        }],
        isError: true,
      };
    }
  },
};

export const sessionHistoryTools = [sessionSearchTool];
