---
name: ralph-loop
description: Self-referential loop until task completion with oracle verification
---

# Ralph Loop Skill

[RALPH LOOP - ITERATION {{ITERATION}}/{{MAX}}]

Your previous attempt did not output the completion promise. Continue working on the task.

## COMPLETION REQUIREMENTS

Before claiming completion, you MUST:
1. Verify ALL requirements from the original task are met
2. Ensure no partial implementations
3. Check that code compiles/runs without errors
4. Verify tests pass (if applicable)

## ORACLE VERIFICATION (MANDATORY)

When you believe the task is complete:
1. **First**, spawn Oracle to verify your work (ALWAYS pass model explicitly!):
   ```
   Task(subagent_type="oracle", model="opus", prompt="Verify this implementation is complete: [describe what you did]")
   ```

2. **Wait for Oracle's assessment**

3. **If Oracle approves**: Output `<promise>{{PROMISE}}</promise>`
4. **If Oracle finds issues**: Fix them, then repeat verification

DO NOT output the completion promise without Oracle verification.

## INSTRUCTIONS

- Review your progress so far
- Continue from where you left off
- When FULLY complete AND Oracle verified, output: <promise>{{PROMISE}}</promise>
- Do not stop until the task is truly done

Original task:
{{PROMPT}}
