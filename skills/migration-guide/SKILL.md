---
name: migration-guide
description: Plan and execute library, framework, or language version migrations with structured breaking-change analysis and step-by-step guidance
argument-hint: "<source>@<old-version> → <target>@<new-version> [--plan-only] [--scope <path>]"
---

# Migration Guide

Use this skill when the user wants to migrate a dependency, framework, or language version and needs a structured plan that identifies breaking changes, maps affected code, and provides a safe execution path.

## When to Use

- Upgrading a major version of a library or framework (e.g., React 18 → 19, Next.js 14 → 15, Express 4 → 5)
- Replacing one library with another (e.g., Moment.js → date-fns, Enzyme → Testing Library)
- Upgrading a language runtime (e.g., Node.js 18 → 22, Python 3.9 → 3.12, Go 1.21 → 1.23)
- Moving between build tools (e.g., Webpack → Vite, CRA → Vite)
- The user says "migrate", "upgrade", "move from X to Y", or "update to latest"

## When Not to Use

- The task is a general refactor with no version/library migration intent; use `/ai-slop-cleaner` or standard refactoring
- The user wants to build a new feature on top of a new library (that's implementation, not migration)
- The migration is trivial (patch version bump with no breaking changes) — just do it directly
- The user wants a full project rewrite from scratch; use `/ralph` or `/autopilot`

## Workflow

### Phase 1: Discovery

1. Identify the migration source and target:
   - Current version/library (from lockfile, package.json, go.mod, Cargo.toml, etc.)
   - Target version/library
   - Scope: entire project or specific paths (`--scope`)

2. Gather migration intelligence:
   - Read official migration guides, changelogs, and release notes (use WebSearch/WebFetch)
   - Identify breaking changes, deprecated APIs, and removed features
   - Note new features or patterns that replace removed ones
   - Check for codemods or automated migration tools

3. Scan the codebase for affected patterns:
   - Search for deprecated API usage
   - Identify files that import/use the migrating dependency
   - Map transitive dependencies that may also need updates
   - Check test files for patterns that will break

### Phase 2: Migration Plan

Produce a structured migration plan:

```markdown
## Migration Plan: <source> → <target>

### Summary
- **From:** <library>@<version>
- **To:** <library>@<version>
- **Breaking changes:** <count>
- **Files affected:** <count>
- **Estimated effort:** <low/medium/high>
- **Codemod available:** <yes/no — link if yes>

### Breaking Changes

| # | Change | Severity | Files Affected | Migration Path |
|---|--------|----------|----------------|----------------|
| 1 | <description> | high/medium/low | <file list> | <how to fix> |

### Migration Steps

1. **Preparation** — lock behavior with tests before changing anything
2. **Dependency update** — update package versions
3. **Automated fixes** — run codemods if available
4. **Manual fixes** — address remaining breaking changes by priority
5. **Verification** — run tests, typecheck, build

### Risks & Rollback
- <identified risks>
- Rollback: revert dependency + revert code changes (atomic commit strategy)
```

If `--plan-only` is specified, stop here and present the plan for review.

### Phase 3: Execution

When executing (no `--plan-only` flag):

1. **Lock behavior first**: ensure existing tests pass before any changes. If test coverage is insufficient for affected areas, note this explicitly.
2. **Update dependencies**: modify lockfile/manifest atomically.
3. **Apply codemods**: run official migration tools if available (e.g., `npx @next/codemod`, `npx react-codemod`).
4. **Fix remaining breaks**: address each breaking change from the plan, highest severity first.
5. **Verify incrementally**: typecheck and run tests after each logical group of changes.
6. **Final verification**: full build + test suite must pass.

### Phase 4: Report

Output a migration report:

```markdown
## Migration Complete: <source> → <target>

### Changes Made
- <file>: <what changed and why>

### Verification
- Typecheck: ✅/❌
- Tests: ✅/❌ (<pass>/<total>)
- Build: ✅/❌

### Remaining Manual Steps
- <anything that requires human decision or external action>

### Notes for Reviewers
- <key decisions made during migration>
- <patterns that changed project-wide>
```

## Rules

- Always check for official migration guides before inventing migration paths.
- Prefer codemods and automated tooling over manual find-and-replace.
- Never silently drop functionality — if a feature has no equivalent in the target, flag it explicitly.
- Keep changes atomic: dependency bump + code changes should be reviewable together.
- If the migration surface is too large for one pass, recommend splitting into phases and explain the split.
- Do not introduce new patterns that conflict with the project's existing conventions.
- When uncertain about a migration path, present options and ask the user to choose.

## Examples

```bash
# Plan a React version upgrade
/oh-my-claudecode:migration-guide react@18 → react@19 --plan-only

# Migrate from Express to Fastify with scope
/oh-my-claudecode:migration-guide express@4 → fastify@5 --scope src/api/

# Upgrade Node.js runtime
/oh-my-claudecode:migration-guide node@18 → node@22

# Replace a library
/oh-my-claudecode:migration-guide moment → date-fns
```

## Integration

- Uses WebSearch/WebFetch for official migration docs and changelogs
- Can hand off to `/ralph` or `/autopilot` for execution of large migrations
- Can invoke `/verify` after execution to confirm the migration succeeded
- Works with `/plan` for pre-migration architectural decisions on complex migrations
