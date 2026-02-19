<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-01-28 | Updated: 2026-02-19 -->

# skills

40 skill directories for workflow automation and specialized behaviors (42 runtime skill names including compatibility aliases).

## Purpose

Skills are reusable workflow templates that can be invoked via `/oh-my-claudecode:skill-name`. Each skill provides:
- Structured prompts for specific workflows
- Activation triggers (manual or automatic)
- Integration with execution modes

## Key Files

### Execution Mode Skills

| File | Skill | Purpose |
|-----------|-------|---------|
| `autopilot/SKILL.md` | autopilot | Full autonomous execution from idea to working code |
| `ultrawork/SKILL.md` | ultrawork | Maximum parallel agent execution |
| `ralph/SKILL.md` | ralph | Persistence until verified complete |
| `ultrapilot/SKILL.md` | ultrapilot | Parallel autopilot with file ownership |
| `team/SKILL.md` | team (+ `swarm` alias) | N coordinated agents with task claiming |
| `pipeline/SKILL.md` | pipeline | Sequential agent chaining |
| `ultraqa/SKILL.md` | ultraqa | QA cycling until goal met |

### Planning Skills

| File | Skill | Purpose |
|-----------|-------|---------|
| `plan/SKILL.md` | plan | Strategic planning with interview workflow |
| `ralplan/SKILL.md` | ralplan | Iterative planning (Planner+Architect+Critic) |
| `review/SKILL.md` | review | Review plan with Critic |
| `analyze/SKILL.md` | analyze | Deep analysis and investigation |
| `ralph-init/SKILL.md` | ralph-init | Initialize PRD for structured ralph |

### Code Quality Skills

| File | Skill | Purpose |
|-----------|-------|---------|
| `code-review/SKILL.md` | code-review | Comprehensive code review |
| `security-review/SKILL.md` | security-review | Security vulnerability detection |
| `tdd/SKILL.md` | tdd | Test-driven development workflow |
| `build-fix/SKILL.md` | build-fix | Fix build and TypeScript errors |

### Exploration Skills

| File | Skill | Purpose |
|-----------|-------|---------|
| `deepsearch/SKILL.md` | deepsearch | Thorough codebase search |
| `deepinit/SKILL.md` | deepinit | Generate hierarchical AGENTS.md |
| `sciomc/SKILL.md` | sciomc | Parallel scientist orchestration |

### Utility Skills

| File | Skill | Purpose |
|-----------|-------|---------|
| `orchestrate/SKILL.md` | orchestrate | Core multi-agent orchestration (always active) |
| `learner/SKILL.md` | learner | Extract reusable skill from session |
| `note/SKILL.md` | note | Save notes for compaction resilience |
| `cancel/SKILL.md` | cancel | Cancel any active OMC mode |
| `hud/SKILL.md` | hud | Configure HUD display |
| `doctor/SKILL.md` | doctor | Diagnose installation issues |
| `omc-setup/SKILL.md` | omc-setup | One-time setup wizard |
| `mcp-setup/SKILL.md` | mcp-setup | Configure MCP servers |
| `help/SKILL.md` | help | Usage guide |
| `skill/SKILL.md` | skill | Manage local skills |

### Domain Skills

| File | Skill | Purpose |
|-----------|-------|---------|
| `frontend-ui-ux/SKILL.md` | frontend-ui-ux | Designer-developer aesthetic |
| `git-master/SKILL.md` | git-master | Git expertise, atomic commits |
| `project-session-manager/SKILL.md` | project-session-manager (+ `psm` alias) | Isolated dev environments |
| `writer-memory/SKILL.md` | writer-memory | Agentic memory for writers |
| `release/SKILL.md` | release | Automated release workflow |

## For AI Agents

### Working In This Directory

#### Skill Template Format

```markdown
---
name: skill-name
description: Brief description
triggers:
  - "keyword1"
  - "keyword2"
agent: executor  # Optional: which agent to use
model: sonnet    # Optional: model override
---

# Skill Name

## Purpose
What this skill accomplishes.

## Workflow
1. Step one
2. Step two
3. Step three

## Usage
How to invoke this skill.

## Configuration
Any configurable options.
```

#### Skill Invocation

```bash
# Manual invocation
/oh-my-claudecode:skill-name

# With arguments
/oh-my-claudecode:skill-name arg1 arg2

# Auto-detected from keywords
"autopilot build me a REST API"  # Triggers autopilot skill
```

#### Creating a New Skill

1. Create `new-skill/SKILL.md` directory and file with YAML frontmatter
2. Define purpose, workflow, and usage
3. Add to skill registry (auto-detected from frontmatter)
4. Optionally add activation triggers
5. Create corresponding `commands/new-skill.md` file (mirror)
6. Update `docs/REFERENCE.md` (Skills section, count)
7. If execution mode skill, also create `src/hooks/new-skill/` hook

### Common Patterns

**Skill chaining:**
```markdown
## Workflow
1. Invoke `explore` agent for context
2. Invoke `architect` for analysis
3. Invoke `executor` for implementation
4. Invoke `qa-tester` for verification
```

**Conditional behavior:**
```markdown
## Workflow
1. Check if tests exist
   - If yes: Run tests first
   - If no: Create test plan
2. Proceed with implementation
```

### Testing Requirements

- Skills are verified via integration tests
- Test skill invocation with `/oh-my-claudecode:skill-name`
- Verify trigger keywords activate correct skill
- For git-related skills, follow `templates/rules/git-workflow.md`

## Dependencies

### Internal
- Loaded by skill bridge (`scripts/build-skill-bridge.mjs`)
- References agents from `agents/`
- Uses hooks from `src/hooks/`

### External
None - pure markdown files.

## Skill Categories

| Category | Skills | Trigger Keywords |
|----------|--------|------------------|
| Execution | autopilot, ultrawork, ralph, ultrapilot, swarm, pipeline | "autopilot", "ulw", "ralph", "swarm", "eco" |
| Planning | plan, ralplan, review, analyze, ralph-init | "plan this", "analyze" |
| Quality | code-review, security-review, tdd, build-fix | "review", "security", "tdd" |
| Exploration | deepsearch, deepinit, research | "search", "research" |
| Utility | learner, note, cancel, hud, doctor, omc-setup, mcp-setup, help | "stop", "cancel" |
| Domain | frontend-ui-ux, git-master, psm, writer-memory, release | UI context, git context |

## Auto-Activation

Some skills activate automatically based on context:

| Skill | Auto-Trigger Condition |
|-------|----------------------|
| autopilot | "autopilot", "build me", "I want a" |
| ultrawork | "ulw", "ultrawork" |
| ralph | "ralph", "don't stop until" |
| frontend-ui-ux | UI/component work detected |
| git-master | Git operations detected |
| cancel | "stop", "cancel", "abort" |

<!-- MANUAL: -->
