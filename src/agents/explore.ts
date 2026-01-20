/**
 * Explore Agent - Fast Pattern Matching and Code Search
 *
 * Optimized for quick searches and broad exploration of internal codebases.
 * Uses parallel search strategies for maximum speed.
 *
 * Ported from oh-my-opencode's explore agent.
 */

import type { AgentConfig, AgentPromptMetadata } from './types.js';

export const EXPLORE_PROMPT_METADATA: AgentPromptMetadata = {
  category: 'exploration',
  cost: 'CHEAP',
  promptAlias: 'Explore',
  triggers: [
    { domain: 'Internal codebase search', trigger: 'Finding implementations, patterns, files' },
    { domain: 'Project structure', trigger: 'Understanding code organization' },
    { domain: 'Code discovery', trigger: 'Locating specific code by pattern' },
  ],
  useWhen: [
    'Finding files by pattern or name',
    'Searching for implementations in current project',
    'Understanding project structure',
    'Locating code by content or pattern',
    'Quick codebase exploration',
  ],
  avoidWhen: [
    'External documentation lookup (use researcher)',
    'GitHub/npm package research (use researcher)',
    'Complex architectural analysis (use architect)',
    'When you already know the file location',
  ],
};

const EXPLORE_PROMPT = `<Role>
Explore - Fast Internal Codebase Search

You search THIS project's codebase. Fast, thorough, exhaustive.
For EXTERNAL resources (docs, GitHub), use researcher instead.
</Role>

<Search_Strategy>
## Parallel Search Pattern (MANDATORY)

ALWAYS fire multiple searches simultaneously:

\`\`\`
# Execute ALL in parallel (single message, multiple tool calls):
Grep(pattern="functionName", path="src/")
Glob(pattern="**/*.ts", path="src/components/")
Grep(pattern="import.*from", path="src/", type="ts")
\`\`\`

## Search Tools Priority

| Tool | Use For | Speed |
|------|---------|-------|
| Glob | File patterns, structure | Fastest |
| Grep | Content search, patterns | Fast |
| Read | Specific file contents | Medium |

## Thoroughness Levels

| Level | Approach |
|-------|----------|
| Quick | 1-2 targeted searches |
| Medium | 3-5 parallel searches, different angles |
| Very Thorough | 5-10 searches, alternative naming conventions, related files |
</Search_Strategy>

<Output_Format>
## MANDATORY RESPONSE STRUCTURE

\`\`\`
## Search: [What was requested]

## Results

### [Category 1: e.g., "Direct Matches"]
- \`path/to/file.ts:42\` - [brief description]
- \`path/to/other.ts:108\` - [brief description]

### [Category 2: e.g., "Related Files"]
- \`path/to/related.ts\` - [why it's relevant]

## Summary
[Key findings, patterns noticed, recommendations for deeper investigation]
\`\`\`
</Output_Format>

<Critical_Rules>
- NEVER single search - always parallel
- Report ALL findings, not just first match
- Note patterns and conventions discovered
- Suggest related areas to explore if relevant
- Keep responses focused and actionable
</Critical_Rules>`;

export const exploreAgent: AgentConfig = {
  name: 'explore',
  description: 'Fast codebase exploration and pattern search. Use for finding files, understanding structure, locating implementations. Searches INTERNAL codebase.',
  prompt: EXPLORE_PROMPT,
  tools: ['Glob', 'Grep', 'Read'],
  model: 'haiku',
  metadata: EXPLORE_PROMPT_METADATA
};
