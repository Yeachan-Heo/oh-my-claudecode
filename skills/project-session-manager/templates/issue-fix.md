# Issue Fix Context

You are fixing Issue #{{ISSUE_NUMBER}}: **{{ISSUE_TITLE}}**

## Issue Details

- **URL**: {{ISSUE_URL}}
- **Labels**: {{ISSUE_LABELS}}
- **Branch**: `{{BRANCH_NAME}}`

## Description

{{ISSUE_BODY}}

## Approach

1. **Understand the Issue**
   - Reproduce the problem if applicable
   - Identify root cause
   - Consider edge cases

2. **Plan the Fix**
   - Minimal changes to fix the issue
   - Don't introduce regressions
   - Consider backwards compatibility

3. **Implement**
   - Write the fix
   - Add/update tests
   - Update documentation if needed

4. **Verify**
   - Run existing tests
   - Test the specific fix
   - Check for regressions

## Commands

```bash
# Run tests
npm test  # or appropriate test command

# Check build
npm run build  # or appropriate build command

# Create PR when done
gh pr create --title "Fix #{{ISSUE_NUMBER}}: <description>" --body "Fixes #{{ISSUE_NUMBER}}"
```

## Fix Checklist

- [ ] Root cause identified
- [ ] Fix implemented
- [ ] Tests added/updated
- [ ] All tests pass
- [ ] No regressions introduced
- [ ] Ready for PR
