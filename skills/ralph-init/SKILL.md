---
name: ralph-init
description: Initialize a PRD (Product Requirements Document) for structured ralph-loop execution
---

# Ralph Init

Initialize a PRD (Product Requirements Document) for structured ralph-loop execution. Creates a structured requirements document that Ralph can use for goal-driven iteration.

## Usage

```
/oh-my-claudecode:ralph-init "project or feature description"
```

## Behavior

1. **Gather requirements** via interactive interview or from the provided description
2. **Create PRD** at `.omc/plans/prd-{slug}.md` with:
   - Problem statement
   - Goals and non-goals
   - Acceptance criteria (testable)
   - Technical constraints
   - Implementation phases
3. **Output the PRD path** and instruct the user to run ralph separately

**IMPORTANT: This is a planning-only skill. After creating the PRD, you MUST stop and wait for user input. Do NOT automatically start execution, invoke ralph, or begin implementing the PRD. Simply tell the user the PRD path and how to start ralph with it.**

## Output

A structured PRD file saved to `.omc/plans/` that serves as the definition of done for Ralph execution.

## Next Steps

After creating the PRD, start execution with:
```
/oh-my-claudecode:ralph "implement the PRD"
```

Ralph will iterate until all acceptance criteria in the PRD are met and architect-verified.
