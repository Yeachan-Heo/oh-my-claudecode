# Feature Development Context

You are developing feature: **{{FEATURE_NAME}}**

## Details

- **Branch**: `{{BRANCH_NAME}}`
- **Base**: `{{BASE_BRANCH}}`
- **Project**: {{PROJECT}}

## Feature Scope

{{FEATURE_DESCRIPTION}}

## Development Approach

1. **Plan**
   - Define requirements
   - Break into subtasks
   - Identify dependencies

2. **Implement**
   - Follow project patterns
   - Write clean, testable code
   - Commit incrementally

3. **Test**
   - Unit tests for new code
   - Integration tests if needed
   - Manual testing

4. **Document**
   - Update relevant docs
   - Add code comments where needed
   - Update CHANGELOG if applicable

## Commands

```bash
# Run tests
npm test  # or appropriate test command

# Check build
npm run build  # or appropriate build command

# Create PR when ready
gh pr create --title "Feature: {{FEATURE_NAME}}" --body "## Summary\n\n<description>\n\n## Changes\n\n- <change 1>\n- <change 2>"
```

## Feature Checklist

- [ ] Requirements understood
- [ ] Implementation complete
- [ ] Tests written and passing
- [ ] Documentation updated
- [ ] Ready for PR
