---
name: team-conventions
description: Standardize team CLAUDE.md, git conventions, code review protocols, knowledge sharing, and AI governance policies
level: 3
aliases: [team-rules, conventions, governance, team-standards]
argument-hint: [setup|claudemd|git|review|knowledge|governance] - default is setup
---

# Team Conventions Skill

Standardize how your team uses Claude Code. Covers shared CLAUDE.md, git conventions, code review protocol, knowledge sharing, and AI governance policies.

## Usage

```
/oh-my-claudecode:team-conventions
/oh-my-claudecode:team-conventions setup
/oh-my-claudecode:team-conventions claudemd
/oh-my-claudecode:team-conventions git
/oh-my-claudecode:team-conventions review
/oh-my-claudecode:team-conventions governance
```

Or say: "standardize team setup", "team git conventions", "code review protocol", "AI governance policy"

## Modes

| Mode | Output | Purpose |
|------|--------|---------|
| `setup` | Full team standardization wizard | First-time team setup |
| `claudemd` | Shared CLAUDE.md generation | Synchronize AI behavior |
| `git` | Git conventions document | Commit, branch, PR standards |
| `review` | Code review protocol | AI code review checklist |
| `knowledge` | Knowledge sharing system | Prompt library, learnings |
| `governance` | AI usage policy | Compliance, audit, access |

## Workflow

### Mode: Setup (Full Wizard)

Runs all modes sequentially with interactive prompts:

1. Generate team CLAUDE.md
2. Define git conventions
3. Create code review protocol
4. Set up knowledge sharing
5. Generate governance policy

### Mode: Team CLAUDE.md

#### 1. Analyze Existing Setup

```
Task(subagent_type="oh-my-claudecode:explore", model="haiku", prompt="ANALYZE TEAM SETUP:
1. Read CLAUDE.md at project root
2. Read any ~/.claude/CLAUDE.md
3. Read .claude/settings.json
4. Read any AGENTS.md files
5. List all team members' individual conventions
Report what exists and what's missing for team consistency.")
```

#### 2. Generate Shared CLAUDE.md

A team CLAUDE.md should include:

```markdown
# {Project Name} — Team CLAUDE.md

## Project Context
- {one-line project description}
- Tech stack: {language, framework, database}
- Architecture: {pattern — monolith, microservices, etc.}

## Coding Standards
- {language style guide reference}
- {naming conventions}
- {file organization rules}
- {import ordering}

## Testing Requirements
- Minimum coverage: {pct}%
- Test location: {pattern — co-located, __tests__, etc.}
- Required test types: {unit, integration, e2e}

## Git Conventions
- Branch naming: {pattern}
- Commit format: {conventional commits, etc.}
- PR requirements: {reviews needed, CI must pass}

## AI Usage Guidelines
- AI-generated code requires: {human review, test coverage}
- AI attribution: {required in commit trailers}
- Prohibited AI tasks: {list any restrictions}

## Key Architecture Decisions
- {ADR-001: Decision and rationale}
- {ADR-002: Decision and rationale}

## Common Pitfalls
- {Gotcha 1 — what to avoid and why}
- {Gotcha 2}
```

#### 3. Confirm and Write

Present the generated CLAUDE.md and confirm before writing.

### Mode: Git Conventions

Generate git workflow standards:

```markdown
# Git Conventions

## Branch Naming
- Feature: `feature/{ticket}-{short-description}`
- Bug fix: `fix/{ticket}-{short-description}`
- Hotfix: `hotfix/{description}`
- Release: `release/{version}`

## Commit Messages
Format: Conventional Commits
```
<type>(<scope>): <description>

[optional body]

[optional trailers]
Co-Authored-By: Claude {model} <noreply@anthropic.com>
```

Types: feat, fix, refactor, test, docs, chore, ci, perf, style

## AI Attribution
All AI-assisted commits MUST include:
- `Co-Authored-By: Claude {model} <noreply@anthropic.com>` trailer
- If substantially AI-generated: note in commit body

## Pull Requests
- Title: Same format as commit messages
- Description: ## Summary, ## Changes, ## Test Plan
- Required: 1 human review minimum
- CI must pass before merge
- Squash merge to main (clean history)

## Protected Branches
- `main`: No direct push, require PR + review + CI
- `release/*`: Same as main
```

### Mode: Code Review Protocol

Generate review checklist for AI-generated code:

```markdown
# Code Review Protocol for AI-Assisted Development

## Before Review
□ AI tool and model noted (Claude Sonnet/Opus, etc.)
□ Test suite passes locally
□ Linting passes

## Review Checklist
### Correctness
□ Does the code actually solve the stated problem?
□ Are edge cases handled?
□ Are error paths tested?

### AI-Specific Checks
□ No hallucinated APIs or imports (verify they exist)
□ No over-engineering (AI tends to add unnecessary abstractions)
□ No "AI slop" (excessive comments, redundant type annotations)
□ No security vulnerabilities (AI may not understand auth context)
□ No hardcoded values that should be configurable
□ Dependencies actually exist and are appropriate versions

### Quality
□ Follows existing codebase patterns (not introducing new ones)
□ Tests are meaningful (not just happy-path coverage padding)
□ Error messages are helpful (not generic)
□ No unnecessary files or exports created

### Performance
□ No O(n²) patterns on large collections
□ No unnecessary re-renders (React)
□ No N+1 queries (database)

## After Review
□ All findings addressed (not just acknowledged)
□ Regression tests added for any bugs found
□ Knowledge shared (add gotchas to CLAUDE.md if applicable)
```

### Mode: Knowledge Sharing

Set up team knowledge capture:

```markdown
# Knowledge Sharing System

## Prompt Library
Location: `.claude/prompts/`
- Team members add effective prompts as .md files
- Prompts include context, constraints, and expected output format
- Review and curate monthly

## Learnings Log
Location: `docs/AI_LEARNINGS.md`
- Log when AI produces incorrect/suboptimal output
- Document: what happened, why, how to prevent
- Review in weekly retrospective

## CLAUDE.md Updates
- Any team member can propose CLAUDE.md changes via PR
- Changes require team lead approval
- Review quarterly for stale entries

## Onboarding
- New members run `/oh-my-claudecode:onboard` on first day
- Pair with experienced Claude Code user for first week
- Share team prompt library access
```

### Mode: Governance

Generate AI usage policy:

```markdown
# AI Usage Governance Policy

## Allowed Uses
- Code generation with human review
- Code review and quality analysis
- Documentation generation
- Test generation
- Debugging assistance
- Architecture exploration

## Restrictions
- No AI-generated code in {sensitive areas} without senior review
- No sending proprietary code to external AI services without approval
- No AI-generated security-critical code without security review
- API keys and secrets must never appear in AI prompts

## Compliance
- All AI-assisted commits attributed (Co-Authored-By trailer)
- AI tool usage logged for audit (session history)
- Quarterly review of AI usage patterns
- Cost tracking and budget per team/project

## Access Control
- Model tier access: {who can use Opus vs Sonnet}
- MCP server access: {approved servers only}
- Skill access: {approved skills list}

## Incident Response
- If AI produces harmful code: revert, report, add to CLAUDE.md
- If AI exposes secrets: rotate immediately, audit blast radius
- If AI generates legally problematic code: legal review, remove
```

## Exit Conditions

| Condition | Action |
|-----------|--------|
| **Setup complete** | All documents generated and confirmed |
| **Single mode complete** | Document generated for requested mode |
| **Team already standardized** | Show current state, suggest improvements |

## Notes

- **Collaborative**: All generated documents should be reviewed by the team before adoption.
- **Iterative**: Start with basic conventions, refine as the team develops preferences.
- **Non-prescriptive**: Templates are starting points — customize for your team's culture.
- **Version controlled**: All convention docs should be committed to the repo.
- **Complements /deepinit**: Use `/deepinit` for technical AGENTS.md docs. Use `/team-conventions` for team process docs.

---

Begin team conventions setup now. Parse the mode and start the wizard or generate the requested document.
