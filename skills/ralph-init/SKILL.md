---
name: ralph-init
description: Initialize a PRD (Product Requirements Document) for structured ralph-loop execution
---

# Ralph Init Skill

[RALPH-INIT - PRD CREATION MODE]

## What is PRD?

A PRD (Product Requirements Document) structures your task into discrete user stories for ralph-loop.

## Your Task

Create `.omc/prd.json` and `.omc/progress.txt` based on the task description.

### prd.json Structure

```json
{
  "project": "[Project Name]",
  "branchName": "ralph/[feature-name]",
  "description": "[Feature description]",
  "userStories": [
    {
      "id": "US-001",
      "title": "[Short title]",
      "description": "As a [user], I want to [action] so that [benefit].",
      "acceptanceCriteria": ["Criterion 1", "Typecheck passes"],
      "priority": 1,
      "passes": false
    }
  ]
}
```

### progress.txt Structure

```
# Ralph Progress Log
Started: [ISO timestamp]

## Codebase Patterns
(No patterns discovered yet)

---
```

### Guidelines

1. **Right-sized stories**: Each completable in one focused session
2. **Verifiable criteria**: Include "Typecheck passes", "Tests pass"
3. **Independent stories**: Minimize dependencies between stories
4. **Priority order**: Foundational work (DB, types) before UI

After creating files, report summary and suggest running `/ralph-loop` to start.

Task to break down:
{{ARGUMENTS}}
