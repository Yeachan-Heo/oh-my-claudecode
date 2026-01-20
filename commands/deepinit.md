---
description: Index full codebase recursively with hierarchical AGENTS.md files
---

Target: $ARGUMENTS

## Argument Parsing

Parse the arguments for flags and path:
- `--update` or `-u`: Update mode only (skip directories without existing AGENTS.md)
- `--dry-run`: Show what would be created without writing files
- `[path]`: Target directory (defaults to current directory if not specified)

Examples:
- `/deepinit` → Initialize current directory
- `/deepinit ./src` → Initialize ./src directory
- `/deepinit --update` → Update existing AGENTS.md files only
- `/deepinit ./src --update` → Update existing AGENTS.md in ./src

## Deep Initialization Task

You are performing a **deep codebase initialization** - creating hierarchical AGENTS.md files that document every directory in the project.

### What This Does

1. **Recursively Analyzes** every directory in the codebase
2. **Creates AGENTS.md** files that describe each directory's purpose and contents
3. **Hierarchical Tagging** - lower-level files reference their parent AGENTS.md
4. **Smart Updates** - if AGENTS.md exists, compares and merges changes

### Execution Strategy

Use **parallel exploration** with the explore agent to analyze directories, then use **executor** agents to create the AGENTS.md files.

#### Phase 1: Discovery

```
Task(subagent_type="oh-my-claude-sisyphus:explore", model="haiku", prompt="Map the directory structure of this codebase. List all directories recursively (excluding node_modules, .git, dist, build, __pycache__, .venv). Return as a tree structure.")
```

#### Phase 2: Hierarchical Generation

Start from the root and work down:

1. **Root Level First** - Create `/AGENTS.md` for the entire project
2. **First-Level Directories** - Create `src/AGENTS.md`, `lib/AGENTS.md`, etc.
3. **Deeper Levels** - Continue recursively, each referencing parent

#### Phase 3: Content Generation Per Directory

For each directory, the AGENTS.md should contain:

```markdown
<!-- Parent: ../AGENTS.md -->
# {Directory Name}

## Purpose
[What this directory contains and its role in the project]

## Key Files
- `file1.ts` - [description]
- `file2.ts` - [description]

## Subdirectories
- `subdir1/` - [brief purpose, see subdir1/AGENTS.md]
- `subdir2/` - [brief purpose, see subdir2/AGENTS.md]

## For AI Agents
[Special instructions for AI agents working in this directory]

## Dependencies
[Key dependencies or relationships with other parts of the codebase]
```

#### Phase 4: Compare and Update (if exists)

If an AGENTS.md already exists:
1. Read the existing file
2. Compare with the new analysis
3. Preserve any manual annotations (look for `<!-- MANUAL -->` tags)
4. Merge new discoveries while keeping existing documentation
5. Update outdated information

**Update Mode (`--update` flag)**:
When `--update` is specified in arguments:
- **Only process directories that already have AGENTS.md**
- Skip directories without existing documentation
- Focus on refreshing existing docs rather than creating new ones
- Use this for maintaining documentation as codebase evolves

**Dry Run Mode (`--dry-run` flag)**:
When `--dry-run` is specified:
- List all directories that would be processed
- Show which files would be created/updated
- Do NOT write any files
- Report summary of planned changes

### Parallelization Strategy

- **Batch Processing**: Process directories at the same level in parallel
- **Level Order**: Complete one level before starting the next (ensures parent references exist)
- **Use Multiple Agents**: Spawn executor agents for parallel file creation

### Quality Checks

After generation:
- [ ] Every non-empty directory has an AGENTS.md
- [ ] Parent references are correct (`<!-- Parent: ../AGENTS.md -->`)
- [ ] File descriptions are accurate
- [ ] No broken references to subdirectories

### Begin Execution

Start now. Create a todo list tracking each directory, then systematically generate AGENTS.md files from root to leaves.
