/**
 * Haiku-Optimized Prompt Adaptations
 *
 * Haiku (LOW tier) prompts are designed for:
 * - Maximum speed and efficiency
 * - Concise, direct instructions
 * - Simple, focused tasks
 * - Minimal cognitive overhead
 */
/**
 * Haiku prompt prefix - minimal overhead
 */
export declare const HAIKU_PROMPT_PREFIX = "TASK: ";
/**
 * Haiku prompt suffix - direct action
 */
export declare const HAIKU_PROMPT_SUFFIX = "\n\nReturn results directly. No preamble.";
/**
 * Adapt a base prompt for Haiku execution
 */
export declare function adaptPromptForHaiku(basePrompt: string): string;
/**
 * Haiku search template
 */
export declare const HAIKU_SEARCH_TEMPLATE = "SEARCH: {QUERY}\n\nRETURN:\n- File paths (absolute)\n- Line numbers\n- Brief context\n\nFORMAT:\n`path/file.ts:123` - [description]\n";
/**
 * Haiku file listing template
 */
export declare const HAIKU_LIST_TEMPLATE = "LIST: {TARGET}\n\nRETURN: File paths matching criteria.\n";
/**
 * Haiku documentation template
 */
export declare const HAIKU_DOC_TEMPLATE = "DOCUMENT: {TARGET}\n\nREQUIREMENTS:\n{REQUIREMENTS}\n\nOUTPUT: Markdown documentation.\n";
/**
 * Haiku simple task template
 */
export declare const HAIKU_SIMPLE_TEMPLATE = "DO: {TASK}\n\nCONTEXT: {CONTEXT}\n\nRETURN: {EXPECTED_OUTPUT}\n";
/**
 * Haiku delegation template - ultra-concise
 */
export declare const HAIKU_DELEGATION_TEMPLATE = "TASK: {TASK}\nTARGET: {TARGET}\nOUTPUT: {OUTPUT_FORMAT}\n";
/**
 * Extract key action from verbose prompt
 */
export declare function extractKeyAction(prompt: string): string;
/**
 * Create minimal exploration prompt
 */
export declare function createExplorePrompt(query: string): string;
/**
 * Create minimal documentation prompt
 */
export declare function createDocPrompt(target: string, requirements: string[]): string;
//# sourceMappingURL=haiku.d.ts.map