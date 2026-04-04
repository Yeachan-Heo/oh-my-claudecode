# Contributing to oh-my-claudecode

Thank you for your interest in contributing to oh-my-claudecode (OMC)! This guide will help you get started and ensure your contributions align with the project's standards.

## Getting Started

1. **Fork** the repository on GitHub
2. **Clone** your fork: `git clone git@github.com:<your-username>/oh-my-claudecode.git`
3. **Add upstream**: `git remote add upstream git@github.com:Yeachan-Heo/oh-my-claudecode.git`
4. **Fetch dev branch**: `git fetch upstream dev`
5. **Create a feature branch** from `dev`: `git checkout -b feat/my-feature upstream/dev`
6. **Install dependencies**: `npm ci`

## Branch Policy

> **All PRs must target the `dev` branch, NEVER `main`.**

- `main` is the release branch. It only receives merges from `dev` during releases.
- `dev` is the development branch where all feature work is integrated.
- GitHub's PR UI defaults to `main` as the base — you must manually change it to `dev`.

When creating a PR:
```bash
gh pr create --base dev --head <your-branch>
```

**Note:** If you are using Claude Code or Codex with OMC installed, the contribution guard will automatically block PRs targeting `main` and remind you to use `dev`.

## Development Workflow

Before submitting a PR, run the full CI suite locally:

```bash
# Install dependencies
npm ci

# Type check
npx tsc --noEmit

# Lint
npm run lint

# Test
npm test -- --run

# Build
npm run build
```

All four checks must pass. The CI pipeline runs these automatically on every PR.

## Commit Convention

This project uses [Conventional Commits](https://www.conventionalcommits.org/):

```
type(scope): description
```

### Types

| Type | Use For |
|------|---------|
| `feat` | New feature |
| `fix` | Bug fix |
| `chore` | Maintenance, dependencies |
| `docs` | Documentation only |
| `style` | Formatting, no logic change |
| `refactor` | Code restructuring, no behavior change |
| `perf` | Performance improvement |
| `test` | Adding or updating tests |
| `build` | Build system changes |
| `ci` | CI configuration changes |
| `revert` | Reverting a previous commit |

### Scopes

Common scopes in this project: `hooks`, `skill`, `hud`, `team`, `tools`, `release`, `ci`, `scripts`, `notifications`, `security`, `state-tools`, `installer`

### Examples

```
feat(skill): add contribution guide compliance skill
fix(hooks): prevent wrong base branch in PR creation
chore: bump version to 4.9.4
docs: update CONTRIBUTING.md with hook guidelines
```

### Git Trailers

For non-trivial commits, include decision context via git trailers:

```
fix(hooks): prevent silent session drops

Constraint: Auth service does not support token introspection
Rejected: Extend token TTL | security policy violation
Confidence: high
Scope-risk: narrow
```

See `CLAUDE.md` `<commit_protocol>` section for the full trailer format.

## PR Guidelines

### PR Template

Every PR should include:

```markdown
## Summary
- Brief description of what changed and why

## Test plan
- [ ] How the changes were tested
- [ ] Edge cases considered
```

### Size Guidelines

- **Diff size**: Keep PRs under 1000 lines of diff. Larger PRs are harder to review.
- **File count**: Aim for fewer than 30 changed files.
- **Scope**: One concern per PR. Don't mix features, refactors, and bug fixes.

### Before Submitting

1. Ensure all CI checks pass locally
2. Verify `--base dev` is set (not `main`)
3. Write a clear Summary and Test plan
4. Review your own diff for unnecessary changes

## Skill Contributions

Skills are defined in `skills/*/SKILL.md` with YAML frontmatter:

```yaml
---
name: my-skill
description: Brief description of the skill
aliases: ["alias1", "alias2"]
triggers: ["keyword1", "keyword2"]
---
```

### Skill Structure

```
skills/
  my-skill/
    SKILL.md          # Skill definition with frontmatter
```

### Required Sections in SKILL.md

- **Purpose**: What the skill accomplishes
- **Use When / Do Not Use When**: Decision logic
- **Steps**: Phase-by-phase workflow
- **Examples**: Good and bad usage patterns

See `skills/AGENTS.md` for the full template reference.

## Agent Contributions

Agents are defined in `agents/*.md`:

- Each agent has a specific role (executor, reviewer, planner, etc.)
- Agent files define responsibilities, constraints, and integration points
- Register new agents in `AGENTS.md`

## Hook Contributions

Hooks are `.mjs` scripts in `scripts/` registered in `hooks/hooks.json`:

### Key Constraints

- **Timeout**: Each hook has a 3-5 second timeout budget
- **Format**: `.mjs` (ES modules)
- **Shared utilities**: Place in `scripts/lib/` (e.g., `stdin.mjs`, `atomic-write.mjs`)
- **Error handling**: Always catch errors and return `{ continue: true }` — never break the hook chain
- **stdin**: Use `readStdin()` from `scripts/lib/stdin.mjs` for cross-platform input reading

### Hook Output Protocol

```javascript
// Allow tool execution with context message
{ continue: true, hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: '...' } }

// Block tool execution
{ continue: true, hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: '...' } }

// Silent pass-through
{ continue: true, suppressOutput: true }
```

## Maintainers

### Bypassing the Contribution Guard

For release PRs that legitimately target `main`:

```bash
OMC_SKIP_CONTRIBUTION_GUARD=1 gh pr create --base main
```

This environment variable disables only the contribution guard, not other pre-tool enforcement.

## Getting Help

- **Issues**: https://github.com/Yeachan-Heo/oh-my-claudecode/issues
- **Discussions**: https://github.com/Yeachan-Heo/oh-my-claudecode/discussions
- **Discord**: Check the repository README for the invite link

## AI-Assisted Contributions

If you are using Claude Code or Codex to contribute:

- The OMC hooks will **automatically enforce** the branch policy and remind you of conventions
- Run `/contribute` to execute the full compliance checklist before submitting
- `CLAUDE.md` contains the contribution rules in a format optimized for AI agents
- The session-start hook will display a contribution guide reminder when working in this project
