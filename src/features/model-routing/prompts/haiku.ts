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
export const HAIKU_PROMPT_PREFIX = `TASK: `;

/**
 * Haiku prompt suffix - direct action
 */
export const HAIKU_PROMPT_SUFFIX = `

Return results directly. No preamble.`;

/**
 * Adapt a base prompt for Haiku execution
 */
export function adaptPromptForHaiku(basePrompt: string): string {
  // For Haiku, we want to strip unnecessary verbosity
  const condensed = condensePrompt(basePrompt);
  return HAIKU_PROMPT_PREFIX + condensed + HAIKU_PROMPT_SUFFIX;
}

/**
 * Condense a prompt for Haiku - remove unnecessary words
 */
function condensePrompt(prompt: string): string {
  // Remove common filler phrases
  const condensed = prompt
    .replace(/please\s+/gi, '')
    .replace(/could you\s+/gi, '')
    .replace(/i would like you to\s+/gi, '')
    .replace(/i need you to\s+/gi, '')
    .replace(/can you\s+/gi, '')
    .replace(/would you\s+/gi, '')
    .replace(/i want you to\s+/gi, '')
    .replace(/make sure to\s+/gi, '')
    .replace(/be sure to\s+/gi, '')
    .replace(/don't forget to\s+/gi, '')
    .trim();

  return condensed;
}

/**
 * Haiku search template
 */
export const HAIKU_SEARCH_TEMPLATE = `SEARCH: {QUERY}

RETURN:
- File paths (absolute)
- Line numbers
- Brief context

FORMAT:
\`path/file.ts:123\` - [description]
`;

/**
 * Haiku file listing template
 */
export const HAIKU_LIST_TEMPLATE = `LIST: {TARGET}

RETURN: File paths matching criteria.
`;

/**
 * Haiku documentation template
 */
export const HAIKU_DOC_TEMPLATE = `DOCUMENT: {TARGET}

REQUIREMENTS:
{REQUIREMENTS}

OUTPUT: Markdown documentation.
`;

/**
 * Haiku simple task template
 */
export const HAIKU_SIMPLE_TEMPLATE = `DO: {TASK}

CONTEXT: {CONTEXT}

RETURN: {EXPECTED_OUTPUT}
`;

/**
 * Haiku delegation template - ultra-concise
 */
export const HAIKU_DELEGATION_TEMPLATE = `TASK: {TASK}
TARGET: {TARGET}
OUTPUT: {OUTPUT_FORMAT}
`;

/**
 * Extract key action from verbose prompt
 */
export function extractKeyAction(prompt: string): string {
  // Try to extract the main verb phrase
  const actionPatterns = [
    /(?:find|search|list|show|get|locate)\s+(.+?)(?:\.|$)/i,
    /(?:where|what)\s+(?:is|are)\s+(.+?)(?:\?|$)/i,
  ];

  for (const pattern of actionPatterns) {
    const match = prompt.match(pattern);
    if (match) {
      return match[0].trim();
    }
  }

  // If no pattern matches, return first sentence
  const firstSentence = prompt.split(/[.!?]/)[0];
  return firstSentence.trim();
}

/**
 * Create minimal exploration prompt
 */
export function createExplorePrompt(query: string): string {
  return `FIND: ${query}

TOOLS: Glob, Grep, Read

OUTPUT:
<files>
- /path/file.ts — [why relevant]
</files>

<answer>
[Direct answer]
</answer>`;
}

/**
 * Create minimal documentation prompt
 */
export function createDocPrompt(target: string, requirements: string[]): string {
  return `DOCUMENT: ${target}

INCLUDE:
${requirements.map(r => `- ${r}`).join('\n')}

FORMAT: Markdown
VERIFY: Code examples work`;
}
