# Implementation Task Template

Use this template when delegating code implementation, refactoring, or modification tasks.

---

## TASK

[Clear, specific description of what needs to be implemented]

Example:
- Add error handling to the payment processing service
- Refactor UserController to use dependency injection
- Implement pagination for the blog posts API endpoint
- Add TypeScript type definitions for the configuration module

---

## EXPECTED OUTCOME

[What the orchestrator expects to receive back]

Example:
- Working implementation with tests
- Refactored code following project patterns
- Updated files with proper error handling
- Documentation for new features
- Summary of changes made

---

## CONTEXT

[Background information to guide the implementation]

Example:
- This project uses Express.js with TypeScript
- Follow the existing repository pattern in `src/repositories`
- Error handling should use the custom `AppError` class
- All public APIs should have JSDoc comments
- The team prefers functional programming style over classes

---

## MUST DO

- Follow existing code patterns and conventions
- Add appropriate error handling
- Include TypeScript types for all new code
- Write or update tests for modified functionality
- Ensure backward compatibility
- Run linter and fix any warnings
- [Add task-specific requirements]

---

## MUST NOT DO

- Do not modify unrelated files
- Do not introduce breaking changes without approval
- Do not skip type definitions
- Do not commit commented-out code
- Do not remove existing tests
- [Add task-specific constraints]

---

## REQUIRED SKILLS

- TypeScript/JavaScript proficiency
- Understanding of project architecture
- Ability to follow existing patterns
- Test-driven development mindset
- [Add task-specific skills]

---

## REQUIRED TOOLS

- Read for examining existing code
- Edit for making changes
- Write for creating new files
- Bash for running tests and builds
- [Add task-specific tools]

---

## USAGE EXAMPLE

```typescript
import { createDelegationPrompt } from '@/features/model-routing/prompts';

const prompt = createDelegationPrompt('MEDIUM', 'Add rate limiting middleware', {
  deliverables: 'Rate limiting middleware integrated into Express app with tests',
  successCriteria: 'All tests pass, rate limits enforced correctly, no breaking changes',
  context: `
    Express.js API using TypeScript
    Existing middleware in src/middleware/
    Using express-rate-limit library (already installed)
    Apply rate limits: 100 requests per 15 minutes per IP
  `,
  mustDo: [
    'Create middleware in src/middleware/rate-limit.ts',
    'Apply to all API routes in src/routes/index.ts',
    'Add configuration options via environment variables',
    'Write unit tests in src/middleware/__tests__/rate-limit.test.ts',
    'Add JSDoc documentation',
    'Update README with rate limit information'
  ],
  mustNotDo: [
    'Do not modify existing route handlers',
    'Do not hard-code rate limit values',
    'Do not break existing tests',
    'Do not add dependencies without checking'
  ],
  requiredSkills: [
    'Express.js middleware patterns',
    'TypeScript type definitions',
    'Jest testing framework',
    'Environment variable configuration'
  ],
  requiredTools: [
    'Read to examine existing middleware',
    'Edit to modify route configuration',
    'Write to create new middleware file',
    'Bash to run tests (npm test)'
  ]
});
```

---

## VERIFICATION CHECKLIST

Before marking the task complete, ensure:

- [ ] Code compiles without TypeScript errors
- [ ] All tests pass (including existing tests)
- [ ] Linter passes with no warnings
- [ ] Code follows project conventions
- [ ] All new code has appropriate types
- [ ] Public APIs have documentation
- [ ] No console.log or debugging code remains
- [ ] Git diff reviewed for unintended changes
