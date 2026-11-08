# Exploration Task Template

Use this template when delegating exploration, research, or search tasks.

---

## TASK

[Clear, specific description of what needs to be explored or researched]

Example:
- Find all implementations of the `UserService` class
- Research how authentication is handled in the codebase
- Explore the database schema and migration history

---

## EXPECTED OUTCOME

[What the orchestrator expects to receive back]

Example:
- List of file paths with line numbers
- Summary of patterns found
- Structured report of findings with code snippets
- Recommendations based on findings

---

## CONTEXT

[Background information to guide the exploration]

Example:
- This is a TypeScript monorepo using pnpm workspaces
- We're investigating a bug in user authentication
- The team previously used class-based services but is migrating to functional patterns
- Focus on files in the `src/auth` and `src/services` directories

---

## MUST DO

- Use appropriate search tools (Grep, Glob) efficiently
- Return structured, actionable results
- Include file paths and line numbers
- Highlight any patterns or anomalies discovered
- [Add task-specific requirements]

---

## MUST NOT DO

- Do not modify any files
- Do not make assumptions without evidence
- Do not search node_modules or build directories
- Do not return raw dumps without analysis
- [Add task-specific constraints]

---

## REQUIRED SKILLS

- Efficient search and pattern matching
- Code comprehension and analysis
- Ability to identify architectural patterns
- [Add task-specific skills]

---

## REQUIRED TOOLS

- Grep for content search
- Glob for file pattern matching
- Read for examining specific files
- [Add task-specific tools]

---

## USAGE EXAMPLE

```typescript
import { createDelegationPrompt } from '@/features/model-routing/prompts';

const prompt = createDelegationPrompt('LOW', 'Find all usages of deprecated API', {
  deliverables: 'List of files with line numbers where the deprecated API is used',
  successCriteria: 'Complete list with no false positives',
  context: 'We are migrating from v1 to v2 API',
  mustDo: [
    'Search for both old and new API patterns',
    'Group results by directory',
    'Note any migration-in-progress patterns'
  ],
  mustNotDo: [
    'Do not search test files',
    'Do not include commented-out code'
  ],
  requiredSkills: [
    'Regex pattern matching',
    'Understanding of API versioning patterns'
  ],
  requiredTools: [
    'Grep with regex support',
    'Glob for TypeScript files'
  ]
});
```
