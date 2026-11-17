/**
 * Wiki MCP Tools
 *
 * Provides 7 tools for the LLM Wiki knowledge layer:
 * wiki_ingest, wiki_query, wiki_lint, wiki_add, wiki_list, wiki_read, wiki_delete
 */
import { z } from 'zod';
import { ToolDefinition } from './types.js';
declare const WIKI_CATEGORIES: [string, ...string[]];
export declare const wikiIngestTool: ToolDefinition<{
    title: z.ZodString;
    content: z.ZodString;
    tags: z.ZodArray<z.ZodString>;
    category: z.ZodEnum<typeof WIKI_CATEGORIES>;
    sources: z.ZodOptional<z.ZodArray<z.ZodString>>;
    confidence: z.ZodOptional<z.ZodEnum<['high', 'medium', 'low']>>;
    workingDirectory: z.ZodOptional<z.ZodString>;
}>;
export declare const wikiQueryTool: ToolDefinition<{
    query: z.ZodString;
    tags: z.ZodOptional<z.ZodArray<z.ZodString>>;
    category: z.ZodOptional<z.ZodEnum<typeof WIKI_CATEGORIES>>;
    limit: z.ZodOptional<z.ZodNumber>;
    workingDirectory: z.ZodOptional<z.ZodString>;
}>;
export declare const wikiLintTool: ToolDefinition<{
    workingDirectory: z.ZodOptional<z.ZodString>;
}>;
export declare const wikiAddTool: ToolDefinition<{
    title: z.ZodString;
    content: z.ZodString;
    tags: z.ZodOptional<z.ZodArray<z.ZodString>>;
    category: z.ZodOptional<z.ZodEnum<typeof WIKI_CATEGORIES>>;
    workingDirectory: z.ZodOptional<z.ZodString>;
}>;
export declare const wikiListTool: ToolDefinition<{
    workingDirectory: z.ZodOptional<z.ZodString>;
}>;
export declare const wikiReadTool: ToolDefinition<{
    page: z.ZodString;
    workingDirectory: z.ZodOptional<z.ZodString>;
}>;
export declare const wikiDeleteTool: ToolDefinition<{
    page: z.ZodString;
    workingDirectory: z.ZodOptional<z.ZodString>;
}>;
export declare const wikiTools: (ToolDefinition<{
    title: z.ZodString;
    content: z.ZodString;
    tags: z.ZodArray<z.ZodString>;
    category: z.ZodEnum<typeof WIKI_CATEGORIES>;
    sources: z.ZodOptional<z.ZodArray<z.ZodString>>;
    confidence: z.ZodOptional<z.ZodEnum<["high", "medium", "low"]>>;
    workingDirectory: z.ZodOptional<z.ZodString>;
}> | ToolDefinition<{
    query: z.ZodString;
    tags: z.ZodOptional<z.ZodArray<z.ZodString>>;
    category: z.ZodOptional<z.ZodEnum<typeof WIKI_CATEGORIES>>;
    limit: z.ZodOptional<z.ZodNumber>;
    workingDirectory: z.ZodOptional<z.ZodString>;
}> | ToolDefinition<{
    workingDirectory: z.ZodOptional<z.ZodString>;
}> | ToolDefinition<{
    title: z.ZodString;
    content: z.ZodString;
    tags: z.ZodOptional<z.ZodArray<z.ZodString>>;
    category: z.ZodOptional<z.ZodEnum<typeof WIKI_CATEGORIES>>;
    workingDirectory: z.ZodOptional<z.ZodString>;
}> | ToolDefinition<{
    page: z.ZodString;
    workingDirectory: z.ZodOptional<z.ZodString>;
}>)[];
export {};
//# sourceMappingURL=wiki-tools.d.ts.map