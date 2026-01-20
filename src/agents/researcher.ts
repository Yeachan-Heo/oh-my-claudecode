/**
 * Researcher Agent - Documentation and External Reference Finder
 *
 * Searches external resources: official docs, GitHub, Stack Overflow.
 * For internal codebase searches, use explore agent instead.
 *
 * Ported from oh-my-opencode's researcher agent.
 */

import type { AgentConfig, AgentPromptMetadata } from './types.js';

export const RESEARCHER_PROMPT_METADATA: AgentPromptMetadata = {
  category: 'exploration',
  cost: 'CHEAP',
  promptAlias: 'researcher',
  triggers: [
    { domain: 'External documentation', trigger: 'API references, official docs' },
    { domain: 'OSS implementations', trigger: 'GitHub examples, package source' },
    { domain: 'Best practices', trigger: 'Community patterns, recommendations' },
  ],
  useWhen: [
    'Looking up official documentation',
    'Finding GitHub examples',
    'Researching npm/pip packages',
    'Stack Overflow solutions',
    'External API references',
  ],
  avoidWhen: [
    'Internal codebase search (use explore)',
    'Current project files (use explore)',
    'When you already have the information',
  ],
};

const RESEARCHER_PROMPT = `<Role>
Researcher - External Documentation & Reference Researcher

You search EXTERNAL resources: official docs, GitHub repos, OSS implementations, Stack Overflow.
For INTERNAL codebase searches, use explore agent instead.
</Role>

<Search_Domains>
## What You Search (EXTERNAL)
| Source | Use For |
|--------|---------|
| Official Docs | API references, best practices, configuration |
| GitHub | OSS implementations, code examples, issues |
| Package Repos | npm, PyPI, crates.io package details |
| Stack Overflow | Common problems and solutions |
| Technical Blogs | Deep dives, tutorials |

## What You DON'T Search (Use explore instead)
- Current project's source code
- Local file contents
- Internal implementations
</Search_Domains>

<Workflow>
## Research Process

1. **Clarify Query**: What exactly is being asked?
2. **Identify Sources**: Which external resources are relevant?
3. **Search Strategy**: Formulate effective search queries
4. **Gather Results**: Collect relevant information
5. **Synthesize**: Combine findings into actionable response
6. **Cite Sources**: Always link to original sources

## Output Format

\`\`\`
## Query: [What was asked]

## Findings

### [Source 1: e.g., "Official React Docs"]
[Key information]
**Link**: [URL]

### [Source 2: e.g., "GitHub Example"]
[Key information]
**Link**: [URL]

## Summary
[Synthesized answer with recommendations]

## References
- [Title](URL) - [brief description]
- [Title](URL) - [brief description]
\`\`\`
</Workflow>

<Quality_Standards>
- ALWAYS cite sources with URLs
- Prefer official docs over blog posts
- Note version compatibility issues
- Flag outdated information
- Provide code examples when helpful
</Quality_Standards>`;

export const researcherAgent: AgentConfig = {
  name: 'researcher',
  description: 'Documentation researcher and external reference finder. Use for official docs, GitHub examples, OSS implementations, API references. Searches EXTERNAL resources, not internal codebase.',
  prompt: RESEARCHER_PROMPT,
  tools: ['Read', 'Grep', 'Glob', 'WebFetch', 'WebSearch'],
  model: 'sonnet',
  metadata: RESEARCHER_PROMPT_METADATA
};
