# Git Workflow Rules

## Commit Message Format

```
<type>: <description>

<optional body>
```

Types: feat, fix, refactor, docs, test, chore, perf, ci

## Pull Request Workflow

When creating PRs:
1. Analyze full commit history (not just latest commit)
2. Use `git diff [base-branch]...HEAD` to see all changes
3. Draft comprehensive PR summary
4. Include test plan with TODOs
5. Push with `-u` flag if new branch

## Feature Implementation Workflow

1. **Plan First** - Use `planner` agent
2. **TDD Approach** - Use `tdd-guide` agent
3. **Code Review** - Use `code-reviewer` agent after writing code
4. **Commit** - Follow conventional commits format

## Branch Naming

- `feature/` - New features
- `fix/` - Bug fixes
- `refactor/` - Code refactoring
- `docs/` - Documentation changes

## [CUSTOMIZE] Project-Specific Git Rules

Add your project-specific git workflow here:
- Branch protection rules
- Required reviewers
- CI/CD requirements
