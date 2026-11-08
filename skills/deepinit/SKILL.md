---
name: deepinit
description: Deep codebase initialization with hierarchical AGENTS.md documentation
level: 4
---

# Deep Init Skill

Creates comprehensive, hierarchical AGENTS.md documentation across the entire codebase.

## Core Concept

AGENTS.md files serve as **AI-readable documentation** that helps agents understand:
- What each directory contains
- How components relate to each other
- Special instructions for working in that area
- Dependencies and relationships

## Hierarchical Tagging System

Every AGENTS.md (except root) includes a parent reference line:

```markdown
**Parent context:** `../AGENTS.md`
```

This MUST be visible prose, never an HTML comment. Claude Code strips HTML
comments before a memory file reaches the model, so `<!-- Parent: ... -->`,
`<!-- Generated: ... -->` and a commented MANUAL boundary are invisible to the
agent that is supposed to act on them.

This creates a navigable hierarchy:
```
/AGENTS.md                          ← Root (no parent line)
├── src/AGENTS.md                   ← **Parent context:** `../AGENTS.md`
│   ├── src/components/AGENTS.md    ← **Parent context:** `../AGENTS.md`
│   └── src/utils/AGENTS.md         ← **Parent context:** `../AGENTS.md`
└── docs/AGENTS.md                  ← **Parent context:** `../AGENTS.md`
```

## Loading Model

Stock Claude Code discovers nested `CLAUDE.md` by basename and never loads a
nested `AGENTS.md`; a root `@AGENTS.md` import does not reach subdirectories
either. The nested files generated here are delivered by OMC's PostToolUse
directory-context injector, which walks up from each accessed file and injects
the nearest `AGENTS.md`/`README.md` once per session.

That means the hierarchy requires OMC's hooks to be active. When OMC hooks are
disabled (`DISABLE_OMC=1`, `OMC_SKIP_HOOKS=post-tool-use`) or the plugin is not
registered, add a root-level `CLAUDE.md` symlink or `@AGENTS.md` import for the
root file and expect nested files to stay unread.

## AGENTS.md Template

```markdown
# {Directory Name}

**Parent context:** `{relative_path_to_parent}/AGENTS.md`
**Generated:** {timestamp} · **Updated:** {timestamp}

## Purpose
{One-paragraph description of what this directory contains and its role}

## Key Files
{List each significant file with a one-line description}

| File | Description |
|------|-------------|
| `file.ts` | Brief description of purpose |

## Subdirectories
{List each subdirectory with brief purpose}

| Directory | Purpose |
|-----------|---------|
| `subdir/` | What it contains (see `subdir/AGENTS.md`) |

## For AI Agents

### Working In This Directory
{Special instructions for AI agents modifying files here}

### Testing Requirements
{How to test changes in this directory}

### Common Patterns
{Code patterns or conventions used here}

## Dependencies

### Internal
{References to other parts of the codebase this depends on}

### External
{Key external packages/libraries used}

## Manual Notes

Notes under this heading are written by humans and preserved on regeneration.
```

## Execution Workflow

### Step 1: Map Directory Structure

```
Task(subagent_type="explore", model="haiku",
  prompt="List all directories recursively. Exclude: node_modules, .git, dist, build, __pycache__, .venv, coverage, .next, .nuxt")
```

### Step 2: Create Work Plan

Generate todo items for each directory, organized by depth level:

```
Level 0: / (root)
Level 1: /src, /docs, /tests
Level 2: /src/components, /src/utils, /docs/api
...
```

### Step 3: Generate Level by Level

**IMPORTANT**: Generate parent levels before child levels to ensure parent references are valid.

For each directory:
1. Read all files in the directory
2. Analyze purpose and relationships
3. Generate AGENTS.md content
4. Write file with proper parent reference

### Step 4: Compare and Update (if exists)

When AGENTS.md already exists:

1. **Read existing content**
2. **Identify sections**:
   - Auto-generated sections (can be updated)
   - Manual sections (the `## Manual Notes` heading and everything under it are preserved)
3. **Compare**:
   - New files added?
   - Files removed?
   - Structure changed?
4. **Merge**:
   - Update auto-generated content
   - Preserve manual annotations
   - Update timestamp

### Step 5: Validate Hierarchy

After generation, run validation checks:

| Check | How to Verify | Corrective Action |
|-------|--------------|-------------------|
| Parent references resolve | Read each AGENTS.md, check the `**Parent context:**` path exists | Fix path or remove orphan |
| No orphaned AGENTS.md | Compare AGENTS.md locations to directory structure | Delete orphaned files |
| Completeness | List all directories, check for AGENTS.md | Generate missing files |
| Timestamps current | Check the `**Generated:**` / `**Updated:**` dates | Regenerate outdated files |

Validation script pattern:
```bash
# Find all AGENTS.md files
find . -name "AGENTS.md" -type f

# Check parent references
grep -r "\*\*Parent context:\*\*" --include="AGENTS.md" .
```

## Smart Delegation

| Task | Agent |
|------|-------|
| Directory mapping | `explore` |
| File analysis | `architect` |
| Content generation | `writer` |
| AGENTS.md writes | `writer` |

## Empty Directory Handling

When encountering empty or near-empty directories:

| Condition | Action |
|-----------|--------|
| No files, no subdirectories | **Skip** - do not create AGENTS.md |
| No files, has subdirectories | Create minimal AGENTS.md with subdirectory listing only |
| Has only generated files (*.min.js, *.map) | Skip or minimal AGENTS.md |
| Has only config files | Create AGENTS.md describing configuration purpose |

Example minimal AGENTS.md for directory-only containers:
```markdown
# {Directory Name}

**Parent context:** `../AGENTS.md`

## Purpose
Container directory for organizing related modules.

## Subdirectories
| Directory | Purpose |
|-----------|---------|
| `subdir/` | Description (see `subdir/AGENTS.md`) |
```

## Parallelization Rules

1. **Same-level directories**: Process in parallel
2. **Different levels**: Sequential (parent first)
3. **Large directories**: Spawn dedicated agent per directory
4. **Small directories**: Batch multiple into one agent

## Quality Standards

### Must Include
- [ ] Accurate file descriptions
- [ ] Correct parent references
- [ ] Subdirectory links
- [ ] AI agent instructions

### Must Avoid
- [ ] Generic boilerplate
- [ ] Incorrect file names
- [ ] Broken parent references
- [ ] Missing important files

## Example Output

### Root AGENTS.md
```markdown
# my-project

**Generated:** 2024-01-15 · **Updated:** 2024-01-15

## Purpose
A web application for managing user tasks with real-time collaboration features.

## Key Files
| File | Description |
|------|-------------|
| `package.json` | Project dependencies and scripts |
| `tsconfig.json` | TypeScript configuration |
| `.env.example` | Environment variable template |

## Subdirectories
| Directory | Purpose |
|-----------|---------|
| `src/` | Application source code (see `src/AGENTS.md`) |
| `docs/` | Documentation (see `docs/AGENTS.md`) |
| `tests/` | Test suites (see `tests/AGENTS.md`) |

## For AI Agents

### Working In This Directory
- Always install dependencies after modifying the project manifest
- Use TypeScript strict mode
- Follow ESLint rules

### Testing Requirements
- Run tests before committing
- Ensure >80% coverage

### Common Patterns
- Use barrel exports (index.ts)
- Prefer functional components

## Dependencies

### External
- React 18.x - UI framework
- TypeScript 5.x - Type safety
- Vite - Build tool

## Manual Notes

Custom project notes can be added under this heading.
```

### Nested AGENTS.md
```markdown
# components

**Parent context:** `../AGENTS.md`
**Generated:** 2024-01-15 · **Updated:** 2024-01-15

## Purpose
Reusable React components organized by feature and complexity.

## Key Files
| File | Description |
|------|-------------|
| `index.ts` | Barrel export for all components |
| `Button.tsx` | Primary button component |
| `Modal.tsx` | Modal dialog component |

## Subdirectories
| Directory | Purpose |
|-----------|---------|
| `forms/` | Form-related components (see `forms/AGENTS.md`) |
| `layout/` | Layout components (see `layout/AGENTS.md`) |

## For AI Agents

### Working In This Directory
- Each component has its own file
- Use CSS modules for styling
- Export via index.ts

### Testing Requirements
- Unit tests in `__tests__/` subdirectory
- Use React Testing Library

### Common Patterns
- Props interfaces defined above component
- Use forwardRef for DOM-exposing components

## Dependencies

### Internal
- `src/hooks/` - Custom hooks used by components
- `src/utils/` - Utility functions

### External
- `clsx` - Conditional class names
- `lucide-react` - Icons

## Manual Notes
```

## Triggering Update Mode

When running on an existing codebase with AGENTS.md files:

1. Detect existing files first
2. Read and parse existing content
3. Analyze current directory state
4. Generate diff between existing and current
5. Apply updates while preserving manual sections

## Performance Considerations

- **Cache directory listings** - Don't re-scan same directories
- **Batch small directories** - Process multiple at once
- **Skip unchanged** - If directory hasn't changed, skip regeneration
- **Parallel writes** - Multiple agents writing different files simultaneously
