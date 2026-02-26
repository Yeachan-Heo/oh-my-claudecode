/**
 * AST Tools using ast-grep
 *
 * Provides AST-aware code search and transformation:
 * - Pattern matching with meta-variables ($VAR, $$$)
 * - Code replacement while preserving structure
 * - Support for 25+ programming languages
 */

import { z } from "zod";
import { readFileSync, readdirSync, statSync, writeFileSync } from "fs";
import { join, extname, resolve } from "path";
import { createRequire } from "module";

// Dynamic import for @ast-grep/napi
// Graceful degradation: if the module is not available (e.g., in bundled/plugin context),
// tools will return a helpful error message instead of crashing
//
// IMPORTANT: Uses createRequire() (CJS resolution) instead of dynamic import() (ESM resolution)
// because ESM resolution does NOT respect NODE_PATH or Module._initPaths().
// In the MCP server plugin context, @ast-grep/napi is installed globally and resolved
// via NODE_PATH set in the bundle's startup banner.
let sgModule: typeof import("@ast-grep/napi") | null = null;
let sgLoadFailed = false;
let sgLoadError = '';

async function getSgModule(): Promise<typeof import("@ast-grep/napi") | null> {
  if (sgLoadFailed) {
    return null;
  }
  if (!sgModule) {
    try {
      // Use createRequire for CJS-style resolution (respects NODE_PATH)
      const require = createRequire(import.meta.url || __filename || process.cwd() + '/');
      sgModule = require("@ast-grep/napi") as typeof import("@ast-grep/napi");
    } catch {
      // Fallback to dynamic import for pure ESM environments
      try {
        sgModule = await import("@ast-grep/napi");
      } catch (error) {
        sgLoadFailed = true;
        sgLoadError = error instanceof Error ? error.message : String(error);
        return null;
      }
    }
  }
  return sgModule;
}

/**
 * Convert lowercase language string to ast-grep Lang enum value
 * This provides type-safe language conversion without using 'as any'
 */
function toLangEnum(
  sg: typeof import("@ast-grep/napi"),
  language: string,
): import("@ast-grep/napi").Lang {
  const langMap: Record<string, import("@ast-grep/napi").Lang> = {
    javascript: sg.Lang.JavaScript,
    typescript: sg.Lang.TypeScript,
    tsx: sg.Lang.Tsx,
    python: sg.Lang.Python,
    ruby: sg.Lang.Ruby,
    go: sg.Lang.Go,
    rust: sg.Lang.Rust,
    java: sg.Lang.Java,
    kotlin: sg.Lang.Kotlin,
    swift: sg.Lang.Swift,
    c: sg.Lang.C,
    cpp: sg.Lang.Cpp,
    csharp: sg.Lang.CSharp,
    html: sg.Lang.Html,
    css: sg.Lang.Css,
    json: sg.Lang.Json,
    yaml: sg.Lang.Yaml,
  };

  const lang = langMap[language];
  if (!lang) {
    throw new Error(`Unsupported language: ${language}`);
  }
  return lang;
}

export interface AstToolDefinition<T extends z.ZodRawShape> {
  name: string;
  description: string;
  schema: T;
  handler: (
    args: z.infer<z.ZodObject<T>>,
  ) => Promise<{ content: Array<{ type: "text"; text: string }> }>;
}

/**
 * Supported languages for AST analysis
 * Maps to ast-grep language identifiers
 */
export const SUPPORTED_LANGUAGES: [string, ...string[]] = [
  "javascript",
  "typescript",
  "tsx",
  "python",
  "ruby",
  "go",
  "rust",
  "java",
  "kotlin",
  "swift",
  "c",
  "cpp",
  "csharp",
  "html",
  "css",
  "json",
  "yaml",
];

export type SupportedLanguage = (typeof SUPPORTED_LANGUAGES)[number];

/**
 * Map file extensions to ast-grep language identifiers
 */
const EXT_TO_LANG: Record<string, string> = {
  ".js": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".jsx": "javascript",
  ".ts": "typescript",
  ".mts": "typescript",
  ".cts": "typescript",
  ".tsx": "tsx",
  ".py": "python",
  ".rb": "ruby",
  ".go": "go",
  ".rs": "rust",
  ".java": "java",
  ".kt": "kotlin",
  ".kts": "kotlin",
  ".swift": "swift",
  ".c": "c",
  ".h": "c",
  ".cpp": "cpp",
  ".cc": "cpp",
  ".cxx": "cpp",
  ".hpp": "cpp",
  ".cs": "csharp",
  ".html": "html",
  ".htm": "html",
  ".css": "css",
  ".json": "json",
  ".yaml": "yaml",
  ".yml": "yaml",
};

/**
 * Get files matching the language in a directory
 */
function getFilesForLanguage(
  dirPath: string,
  language: string,
  maxFiles = 1000,
): string[] {
  const files: string[] = [];
  const extensions = Object.entries(EXT_TO_LANG)
    .filter(([_, lang]) => lang === language)
    .map(([ext]) => ext);

  function walk(dir: string) {
    if (files.length >= maxFiles) return;

    try {
      const entries = readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (files.length >= maxFiles) return;

        const fullPath = join(dir, entry.name);

        // Skip common non-source directories
        if (entry.isDirectory()) {
          if (
            ![
              "node_modules",
              ".git",
              "dist",
              "build",
              "__pycache__",
              ".venv",
              "venv",
            ].includes(entry.name)
          ) {
            walk(fullPath);
          }
        } else if (entry.isFile()) {
          const ext = extname(entry.name).toLowerCase();
          if (extensions.includes(ext)) {
            files.push(fullPath);
          }
        }
      }
    } catch {
      // Ignore permission errors
    }
  }

  const resolvedPath = resolve(dirPath);
  const stat = statSync(resolvedPath);

  if (stat.isFile()) {
    return [resolvedPath];
  }

  walk(resolvedPath);
  return files;
}

/**
 * Format a match result for display
 */
function formatMatch(
  filePath: string,
  matchText: string,
  startLine: number,
  endLine: number,
  context: number,
  fileContent: string,
): string {
  const lines = fileContent.split("\n");
  const contextStart = Math.max(0, startLine - context - 1);
  const contextEnd = Math.min(lines.length, endLine + context);

  const contextLines = lines.slice(contextStart, contextEnd);
  const numberedLines = contextLines.map((line, i) => {
    const lineNum = contextStart + i + 1;
    const isMatch = lineNum >= startLine && lineNum <= endLine;
    const prefix = isMatch ? ">" : " ";
    return `${prefix} ${lineNum.toString().padStart(4)}: ${line}`;
  });

  return `${filePath}:${startLine}\n${numberedLines.join("\n")}`;
}

/**
 * AST Grep Search Tool - Find code patterns using AST matching
 */
export const astGrepSearchTool: AstToolDefinition<{
  pattern: z.ZodString;
  language: z.ZodEnum<[string, ...string[]]>;
  path: z.ZodOptional<z.ZodString>;
  context: z.ZodOptional<z.ZodNumber>;
  maxResults: z.ZodOptional<z.ZodNumber>;
}> = {
  name: "ast_grep_search",
  description: `Search for code patterns using AST matching. More precise than text search.

Use meta-variables in patterns:
- $NAME - matches any single AST node (identifier, expression, etc.)
- $$$ARGS - matches multiple nodes (for function arguments, list items, etc.)

Examples:
- "function $NAME($$$ARGS)" - find all function declarations
- "console.log($MSG)" - find all console.log calls
- "if ($COND) { $$$BODY }" - find all if statements
- "$X === null" - find null equality checks
- "import $$$IMPORTS from '$MODULE'" - find imports

Note: Patterns must be valid AST nodes for the language.`,
  schema: {
    pattern: z
      .string()
      .describe("AST pattern with meta-variables ($VAR, $$$VARS)"),
    language: z.enum(SUPPORTED_LANGUAGES).describe("Programming language"),
    path: z
      .string()
      .optional()
      .describe("Directory or file to search (default: current directory)"),
    context: z
      .number()
      .int()
      .min(0)
      .max(10)
      .optional()
      .describe("Lines of context around matches (default: 2)"),
    maxResults: z
      .number()
      .int()
      .min(1)
      .max(100)
      .optional()
      .describe("Maximum results to return (default: 20)"),
  },
  handler: async (args) => {
    const {
      pattern,
      language,
      path = ".",
      context = 2,
      maxResults = 20,
    } = args;

    try {
      const sg = await getSgModule();
      if (!sg) {
        return {
          content: [
            {
              type: "text" as const,
              text: `@ast-grep/napi is not available. Install it with: npm install -g @ast-grep/napi\nError: ${sgLoadError}`,
            },
          ],
        };
      }
      const files = getFilesForLanguage(path, language);

      if (files.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: `No ${language} files found in ${path}`,
            },
          ],
        };
      }

      const results: string[] = [];
      let totalMatches = 0;

      for (const filePath of files) {
        if (totalMatches >= maxResults) break;

        try {
          const content = readFileSync(filePath, "utf-8");
          const root = sg.parse(toLangEnum(sg, language), content).root();
          const matches = root.findAll(pattern);

          for (const match of matches) {
            if (totalMatches >= maxResults) break;

            const range = match.range();
            const startLine = range.start.line + 1;
            const endLine = range.end.line + 1;

            results.push(
              formatMatch(
                filePath,
                match.text(),
                startLine,
                endLine,
                context,
                content,
              ),
            );
            totalMatches++;
          }
        } catch {
          // Skip files that fail to parse
        }
      }

      if (results.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: `No matches found for pattern: ${pattern}\n\nSearched ${files.length} ${language} file(s) in ${path}\n\nTip: Ensure the pattern is a valid AST node. For example:\n- Use "function $NAME" not just "$NAME"\n- Use "console.log($X)" not "console.log"`,
            },
          ],
        };
      }

      const header = `Found ${totalMatches} match(es) in ${files.length} file(s)\nPattern: ${pattern}\n\n`;
      return {
        content: [
          {
            type: "text" as const,
            text: header + results.join("\n\n---\n\n"),
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Error in AST search: ${error instanceof Error ? error.message : String(error)}\n\nCommon issues:\n- Pattern must be a complete AST node\n- Language must match file type\n- Check that @ast-grep/napi is installed`,
          },
        ],
      };
    }
  },
};

/**
 * AST Grep Replace Tool - Replace code patterns using AST matching
 */
export const astGrepReplaceTool: AstToolDefinition<{
  pattern: z.ZodString;
  replacement: z.ZodString;
  language: z.ZodEnum<[string, ...string[]]>;
  path: z.ZodOptional<z.ZodString>;
  dryRun: z.ZodOptional<z.ZodBoolean>;
}> = {
  name: "ast_grep_replace",
  description: `Replace code patterns using AST matching. Preserves matched content via meta-variables.

Use meta-variables in both pattern and replacement:
- $NAME in pattern captures a node, use $NAME in replacement to insert it
- $$$ARGS captures multiple nodes

Examples:
- Pattern: "console.log($MSG)" → Replacement: "logger.info($MSG)"
- Pattern: "var $NAME = $VALUE" → Replacement: "const $NAME = $VALUE"
- Pattern: "$OBJ.forEach(($ITEM) => { $$$BODY })" → Replacement: "for (const $ITEM of $OBJ) { $$$BODY }"

IMPORTANT: dryRun=true (default) only previews changes. Set dryRun=false to apply.`,
  schema: {
    pattern: z.string().describe("Pattern to match"),
    replacement: z
      .string()
      .describe("Replacement pattern (use same meta-variables)"),
    language: z.enum(SUPPORTED_LANGUAGES).describe("Programming language"),
    path: z
      .string()
      .optional()
      .describe("Directory or file to search (default: current directory)"),
    dryRun: z
      .boolean()
      .optional()
      .describe("Preview only, don't apply changes (default: true)"),
  },
  handler: async (args) => {
    const { pattern, replacement, language, path = ".", dryRun = true } = args;

    try {
      const sg = await getSgModule();
      if (!sg) {
        return {
          content: [
            {
              type: "text" as const,
              text: `@ast-grep/napi is not available. Install it with: npm install -g @ast-grep/napi\nError: ${sgLoadError}`,
            },
          ],
        };
      }
      const files = getFilesForLanguage(path, language);

      if (files.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: `No ${language} files found in ${path}`,
            },
          ],
        };
      }

      const changes: {
        file: string;
        before: string;
        after: string;
        line: number;
      }[] = [];
      let totalReplacements = 0;

      for (const filePath of files) {
        try {
          const content = readFileSync(filePath, "utf-8");
          const root = sg.parse(toLangEnum(sg, language), content).root();
          const matches = root.findAll(pattern);

          if (matches.length === 0) continue;

          // Collect all edits for this file
          const edits: {
            start: number;
            end: number;
            replacement: string;
            line: number;
            before: string;
          }[] = [];

          for (const match of matches) {
            const range = match.range();
            const startOffset = range.start.index;
            const endOffset = range.end.index;

            // Build replacement by substituting meta-variables
            let finalReplacement = replacement;

            // Get all captured meta-variables
            // ast-grep captures are accessed via match.getMatch() or by variable name
            // For simplicity, we'll use a basic approach here
            const matchedText = match.text();

            // Try to get named captures
            try {
              // Replace meta-variables in the replacement string
              const metaVars =
                replacement.match(/\$\$?\$?[A-Z_][A-Z0-9_]*/g) || [];
              for (const metaVar of metaVars) {
                const varName = metaVar.replace(/^\$+/, "");
                const captured = match.getMatch(varName);
                if (captured) {
                  finalReplacement = finalReplacement.replaceAll(
                    metaVar,
                    captured.text(),
                  );
                }
              }
            } catch {
              // If meta-variable extraction fails, use pattern as-is
            }

            edits.push({
              start: startOffset,
              end: endOffset,
              replacement: finalReplacement,
              line: range.start.line + 1,
              before: matchedText,
            });
          }

          // Sort edits in reverse order to apply from end to start
          edits.sort((a, b) => b.start - a.start);

          let newContent = content;
          for (const edit of edits) {
            const before = newContent.slice(edit.start, edit.end);
            newContent =
              newContent.slice(0, edit.start) +
              edit.replacement +
              newContent.slice(edit.end);

            changes.push({
              file: filePath,
              before,
              after: edit.replacement,
              line: edit.line,
            });
            totalReplacements++;
          }

          if (!dryRun && edits.length > 0) {
            writeFileSync(filePath, newContent, "utf-8");
          }
        } catch {
          // Skip files that fail to parse
        }
      }

      if (changes.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: `No matches found for pattern: ${pattern}\n\nSearched ${files.length} ${language} file(s) in ${path}`,
            },
          ],
        };
      }

      const mode = dryRun ? "DRY RUN (no changes applied)" : "CHANGES APPLIED";
      const header = `${mode}\n\nFound ${totalReplacements} replacement(s) in ${files.length} file(s)\nPattern: ${pattern}\nReplacement: ${replacement}\n\n`;

      const changeList = changes
        .slice(0, 50)
        .map((c) => `${c.file}:${c.line}\n  - ${c.before}\n  + ${c.after}`)
        .join("\n\n");

      const footer =
        changes.length > 50
          ? `\n\n... and ${changes.length - 50} more changes`
          : "";

      return {
        content: [
          {
            type: "text" as const,
            text:
              header +
              changeList +
              footer +
              (dryRun ? "\n\nTo apply changes, run with dryRun: false" : ""),
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Error in AST replace: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  },
};

/**
 * Get all AST tool definitions
 */
export const astTools = [astGrepSearchTool, astGrepReplaceTool];
