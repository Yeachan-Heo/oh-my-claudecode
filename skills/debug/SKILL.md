---
name: debug
description: Diagnose the current OMC session or repo state using logs, traces, state, and focused reproduction
---

# Debug

Use this skill when the user wants help diagnosing a current OMC/Claude-Code session problem, workflow breakage, or confusing runtime behavior.

## Goal
Find the real failure signal quickly and explain the next corrective step.

## Workflow
1. Read the user’s issue description carefully.
2. Inspect the most relevant local evidence first:
   - trace tools
   - state tools
   - notepad / project memory when relevant
   - failing tests or commands
3. Reproduce the issue narrowly if possible.
4. Distinguish symptoms from root cause.
5. Recommend the smallest next fix or verification step.

## Rules
- Prefer real evidence over guesses.
- Use the trace/state surfaces when the issue involves orchestration, hooks, or agent flow.
- If the issue is actually a product/runtime bug rather than app code, say so plainly.
- Do not prescribe broad rewrites before isolating the failure.

## Output
- Observed failure
- Root-cause hypothesis
- Evidence for that hypothesis
- Smallest next action

