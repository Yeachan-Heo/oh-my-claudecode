/**
 * AST Tools using ast-grep
 *
 * Provides AST-aware code search and transformation:
 * - Pattern matching with meta-variables ($VAR, $$$)
 * - Code replacement while preserving structure
 * - Support for 25+ programming languages
 */
import { z } from "zod";
export interface AstToolDefinition<T extends z.ZodRawShape> {
    name: string;
    description: string;
    schema: T;
    handler: (args: z.infer<z.ZodObject<T>>) => Promise<{
        content: Array<{
            type: "text";
            text: string;
        }>;
    }>;
}
/**
 * Supported languages for AST analysis
 * Maps to ast-grep language identifiers
 */
export declare const SUPPORTED_LANGUAGES: [string, ...string[]];
export type SupportedLanguage = (typeof SUPPORTED_LANGUAGES)[number];
/**
 * AST Grep Search Tool - Find code patterns using AST matching
 */
export declare const astGrepSearchTool: AstToolDefinition<{
    pattern: z.ZodString;
    language: z.ZodEnum<[string, ...string[]]>;
    path: z.ZodOptional<z.ZodString>;
    context: z.ZodOptional<z.ZodNumber>;
    maxResults: z.ZodOptional<z.ZodNumber>;
}>;
/**
 * AST Grep Replace Tool - Replace code patterns using AST matching
 */
export declare const astGrepReplaceTool: AstToolDefinition<{
    pattern: z.ZodString;
    replacement: z.ZodString;
    language: z.ZodEnum<[string, ...string[]]>;
    path: z.ZodOptional<z.ZodString>;
    dryRun: z.ZodOptional<z.ZodBoolean>;
}>;
/**
 * Get all AST tool definitions
 */
export declare const astTools: (AstToolDefinition<{
    pattern: z.ZodString;
    language: z.ZodEnum<[string, ...string[]]>;
    path: z.ZodOptional<z.ZodString>;
    context: z.ZodOptional<z.ZodNumber>;
    maxResults: z.ZodOptional<z.ZodNumber>;
}> | AstToolDefinition<{
    pattern: z.ZodString;
    replacement: z.ZodString;
    language: z.ZodEnum<[string, ...string[]]>;
    path: z.ZodOptional<z.ZodString>;
    dryRun: z.ZodOptional<z.ZodBoolean>;
}>)[];
//# sourceMappingURL=ast-tools.d.ts.map