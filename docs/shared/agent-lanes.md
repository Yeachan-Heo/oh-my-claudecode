# Agent Lanes and Skill Taxonomy

This is the single source of truth for how the 19 bundled agents group into lanes and how skills split into workflow and utility categories. Documentation should reference this file instead of duplicating the lists. Model tiers per agent live in [agent-tiers.md](agent-tiers.md).

## Agent Lanes

| Lane | Agents | Purpose |
|------|--------|---------|
| **Build & Analysis** | `explore`, `analyst`, `planner`, `architect`, `debugger`, `executor`, `verifier`, `tracer` | Understand, plan, implement, verify |
| **Review** | `code-reviewer`, `security-reviewer` | Independent quality and security gates |
| **Domain** | `test-engineer`, `designer`, `writer`, `qa-tester`, `scientist`, `git-master`, `document-specialist`, `code-simplifier` | Specialized craft areas |
| **Coordination** | `critic` | Final quality gate on plans and consensus loops |

## Skill Taxonomy

**Workflow skills** run multi-step work end to end:
`autopilot`, `ralph`, `ultragoal`, `ultrawork`, `ultraqa`, `team`, `omc-teams`, `ccg`, `omc-plan`, `ralplan`, `sciomc`, `external-context`, `deepinit`, `deep-interview`, `deep-dive`, `self-improve`, `autoresearch`, `ai-slop-cleaner`

**Utility skills** configure, diagnose, or assist:
`cancel`, `ask`, `skillify`, `learner` (deprecated alias), `skill`, `trace`, `hud`, `configure-notifications`, `release`, `writer-memory`, `project-session-manager`, `visual-verdict`, `omc-setup`, `mcp-setup`, `omc-doctor`, `setup`, `debug`, `verify`, `remember`, `wiki`, `omc-reference`, `merge-readiness`, `local-build-reminder`

Runtime truth comes from the builtin skill loader scanning `skills/*/SKILL.md`; when this list and the directory disagree, the directory wins.
