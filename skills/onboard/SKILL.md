---
name: onboard
description: Generate codebase onboarding guides - architecture tour, getting started walkthrough, tech debt assessment, and team knowledge transfer
level: 3
aliases: [onboarding, tour, getting-started, archeology]
argument-hint: [guide|tour|techdebt|team] - default is guide
---

# Onboard Skill

Generate comprehensive onboarding materials for a codebase. Helps new team members (human or AI) get productive quickly by mapping architecture, documenting key patterns, identifying tech debt, and creating actionable getting-started guides.

## Usage

```
/oh-my-claudecode:onboard
/oh-my-claudecode:onboard guide
/oh-my-claudecode:onboard tour
/oh-my-claudecode:onboard techdebt
/oh-my-claudecode:onboard team
```

Or say: "onboard me", "how does this codebase work", "architecture tour", "tech debt assessment", "getting started guide"

## Modes

| Mode | Output | Best For |
|------|--------|----------|
| `guide` | Getting Started guide | New developer joining the project |
| `tour` | Architecture walkthrough | Understanding system design |
| `techdebt` | Tech debt assessment | Planning improvement work |
| `team` | Team knowledge doc | Standardizing team practices |

## Workflow

### Mode: Guide (default)

#### 1. Codebase Reconnaissance

Spawn parallel explore agents to map the project:

```
Task(subagent_type="oh-my-claudecode:explore", model="haiku", prompt="MAP CODEBASE STRUCTURE:
1. List top-level directories with purpose
2. Identify entry points (main files, index files, app entry)
3. Find configuration files (package.json, tsconfig, etc.)
4. Identify test locations and patterns
5. Find documentation files (README, docs/, CONTRIBUTING)
Return a structured directory map with descriptions.")
```

```
Task(subagent_type="oh-my-claudecode:explore", model="haiku", prompt="MAP TECH STACK:
1. Language(s) and versions
2. Frameworks and major libraries
3. Build system and tooling
4. Test framework and coverage setup
5. Linting and formatting tools
6. Database and storage
7. API style (REST, GraphQL, gRPC)
Return a structured tech stack summary.")
```

#### 2. Identify Key Patterns

Analyze the codebase for conventions:

- **Directory structure pattern**: monorepo, modular, layered, feature-based?
- **Naming conventions**: camelCase, snake_case, component naming?
- **Import patterns**: absolute vs relative, barrel exports?
- **Error handling**: try/catch, Result types, error boundaries?
- **State management**: context, Redux, Zustand, signals?
- **Data fetching**: REST clients, GraphQL, tRPC, server actions?
- **Testing patterns**: unit test location, integration test setup, fixtures?

#### 3. Generate Getting Started Guide

Output a structured guide:

```markdown
# Getting Started with {project_name}

## Quick Start (5 minutes)

### Prerequisites
- {runtime} {version}+
- {package_manager}
- {other_tools}

### Setup
{numbered_setup_steps_with_commands}

### Verify
{verification_command_and_expected_output}

## Architecture Overview

### Directory Structure
{tree_with_annotations}

### Tech Stack
{framework_and_library_summary}

### Key Concepts
{3_5_most_important_patterns_or_abstractions}

## Development Workflow

### Running Locally
{dev_server_commands}

### Running Tests
{test_commands_with_options}

### Building
{build_commands}

### Linting & Formatting
{lint_format_commands}

## Key Files to Read First

1. **{file}** - {why_read_this_first}
2. **{file}** - {why_this_is_important}
3. **{file}** - {key_concept_here}

## Common Tasks

### Adding a new {feature_type}
{step_by_step_for_common_task}

### Debugging {common_issue}
{debugging_approach}

## Gotchas & Tribal Knowledge

- {gotcha_1}
- {gotcha_2}
- {gotcha_3}
```

### Mode: Tour

#### 1. Architecture Deep Dive

Delegate to architect for analysis:

```
Task(subagent_type="oh-my-claudecode:architect", model="opus", prompt="ARCHITECTURE ANALYSIS:
Analyze the codebase at {project_path} and provide:
1. System architecture diagram (ASCII/Mermaid)
2. Data flow from user input to response
3. Key abstractions and their relationships
4. External dependencies and integration points
5. Scaling characteristics and bottlenecks
6. Architecture pattern identification (MVC, hexagonal, microservices, etc.)
Cite every finding with file:line references.")
```

#### 2. Generate Architecture Tour

Output a walkthrough that traces a request through the system:

```markdown
# Architecture Tour: {project_name}

## System Diagram
{ascii_or_mermaid_diagram}

## Request Lifecycle
Follow a typical {request_type} through the system:

### 1. Entry Point: {file}:{line}
{what_happens_here}

### 2. Routing: {file}:{line}
{how_routing_works}

### 3. Business Logic: {file}:{line}
{core_logic_explanation}

### 4. Data Access: {file}:{line}
{how_data_is_stored_and_retrieved}

### 5. Response: {file}:{line}
{how_response_is_formed}

## Key Abstractions
{table_of_abstractions_with_file_references}

## Integration Points
{external_services_and_how_they_connect}
```

### Mode: Tech Debt

#### 1. Automated Analysis

Run available analysis tools:

```bash
# Check for outdated dependencies
npm outdated 2>/dev/null || pip list --outdated 2>/dev/null || cargo outdated 2>/dev/null

# Check for TODO/FIXME/HACK markers
grep -r "TODO\|FIXME\|HACK\|XXX\|DEPRECATED" --include="*.ts" --include="*.js" --include="*.py" --include="*.rs" --include="*.go" -c . 2>/dev/null | sort -t: -k2 -rn | head -20
```

#### 2. Code Quality Signals

Check for:
- **Test coverage gaps**: files with no corresponding test files
- **Large files**: files over 500 lines (complexity risk)
- **Circular dependencies**: import cycles
- **Dead code**: exported but unused functions/types
- **Outdated patterns**: deprecated APIs, old framework patterns
- **Missing types**: `any` usage in TypeScript, untyped parameters
- **Error handling gaps**: unhandled promise rejections, bare catches

#### 3. Generate Tech Debt Report

```markdown
# Tech Debt Assessment: {project_name}

## Health Score: {score}/100

## Critical Debt (fix now)
| Issue | Location | Impact | Effort |
|-------|----------|--------|--------|
{critical_items}

## High Debt (fix this quarter)
| Issue | Location | Impact | Effort |
|-------|----------|--------|--------|
{high_items}

## Medium Debt (plan for)
| Issue | Location | Impact | Effort |
|-------|----------|--------|--------|
{medium_items}

## Metrics
- TODO/FIXME count: {n}
- Outdated dependencies: {n}
- Files >500 lines: {n}
- Test coverage estimate: {pct}%
- Type safety gaps: {n} `any` usages

## Recommended Action Plan
1. {highest_impact_lowest_effort_first}
2. {next_priority}
3. {next_priority}
```

### Mode: Team

Generates team-oriented documentation combining guide + conventions:

1. Run the `guide` workflow
2. Extract team conventions from existing code patterns
3. Generate a team knowledge document with:
   - Coding standards (inferred from codebase)
   - PR review checklist
   - On-call/debugging playbook
   - Architecture Decision Records (existing decisions)
   - Recommended CLAUDE.md additions for the team

## Exit Conditions

| Condition | Action |
|-----------|--------|
| **Guide generated** | Output the getting started guide |
| **Tour complete** | Output the architecture walkthrough |
| **Tech debt assessed** | Output the debt report with action plan |
| **Team doc generated** | Output the team knowledge document |
| **Empty project** | Note that project appears empty, suggest initializing |

## Output Location

All generated documents are written to `docs/` or displayed inline depending on project preference:
- If `docs/` exists: write to `docs/ONBOARDING.md`, `docs/ARCHITECTURE.md`, or `docs/TECH-DEBT.md`
- If no `docs/`: display inline and offer to create the file

## Notes

- **Read-only analysis**: The guide and tour modes only read the codebase. Tech debt mode may run analysis tools but never modifies code.
- **Complements deepinit**: `/deepinit` creates AGENTS.md for AI agents. `/onboard` creates guides for human developers.
- **Incremental**: Run again after major changes to keep docs current.
- **Uses explore agents**: Leverages haiku-tier explore agents for fast parallel codebase scanning.
- **Architect for depth**: Uses opus-tier architect agent for the tour mode's deep analysis.

---

Begin onboarding analysis now. Parse the mode argument and start codebase reconnaissance.
