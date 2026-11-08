# PR Review Context

You are reviewing PR #{{PR_NUMBER}}: **{{PR_TITLE}}**

## PR Details

- **Author**: @{{PR_AUTHOR}}
- **Branch**: `{{HEAD_BRANCH}}` → `{{BASE_BRANCH}}`
- **URL**: {{PR_URL}}

## Description

{{PR_BODY}}

## Changed Files

{{CHANGED_FILES}}

## Review Focus

1. **Code Quality**
   - Follow existing patterns and conventions
   - Clean, readable, maintainable code
   - Appropriate abstractions

2. **Correctness**
   - Does it do what it claims?
   - Edge cases handled?
   - Error handling appropriate?

3. **Security**
   - Input validation
   - No hardcoded secrets
   - Safe dependencies

4. **Testing**
   - Adequate test coverage
   - Tests are meaningful
   - Edge cases tested

5. **Documentation**
   - Code is self-documenting
   - Complex logic explained
   - API changes documented

## Commands

```bash
# View diff
git diff {{BASE_BRANCH}}...HEAD

# Run the narrowest relevant tests first
# If this clean review worktree has a symlinked node_modules from the source repo,
# focused vitest commands should work without a fresh install.
npm run test:run -- <changed-test-paths>  # preferred focused verification
npm test  # or appropriate full test command if focused coverage is insufficient

# Check build
npm run build  # or appropriate build command
```

## Review Checklist

- [ ] Code follows project style
- [ ] No obvious bugs or logic errors
- [ ] Security concerns addressed
- [ ] Tests pass and cover changes
- [ ] Documentation updated if needed
