---
name: learner
description: Extract a learned skill from the current conversation
---

# Skill Extraction

You are being asked to extract a reusable skill from the current conversation.

$ARGUMENTS

## What This Does

This command extracts REUSABLE SKILLS - not just code snippets to copy-paste, but **principles and decision-making heuristics** that teach Claude HOW TO THINK about a class of problems.

**The difference:**
- BAD (mimicking): "When you see ConnectionResetError, add this try/except block"
- GOOD (reusable skill): "In async network code, any I/O operation can fail independently due to client/server lifecycle mismatches. The principle: wrap each I/O operation separately, because failure between operations is the common case, not the exception."

A good skill changes how Claude APPROACHES problems, not just what code it produces.

## Extraction Process

1. **Evaluate Worth**: Before extracting, ask yourself:
   - "Could someone Google this in 5 minutes?" → If yes, STOP. Don't extract.
   - "Is this specific to THIS codebase?" → If no, STOP. Don't extract.
   - "Did this take real debugging effort to discover?" → If no, STOP. Don't extract.

2. **Gather Required Information**:
   - **Problem Statement**: The SPECIFIC error, symptom, or confusion that occurred
     - Include actual error messages, file paths, line numbers
     - Example: "TypeError in src/hooks/session.ts:45 when sessionId is undefined after restart"
   - **Solution**: The EXACT fix, not general advice
     - Include code snippets, file paths, configuration changes
     - Example: "Add null check before accessing session.user, regenerate session on 401"
   - **Triggers**: Keywords that would appear when hitting this problem again
     - Use error message fragments, file names, symptom descriptions
     - Example: ["sessionId undefined", "session.ts TypeError", "401 session"]
   - **Scope**: Almost always Project-level unless it's a truly universal insight

3. **Quality Validation**: The system REJECTS skills that are:
   - Too generic (no file paths, line numbers, or specific error messages)
   - Easily Googleable (standard patterns, library usage)
   - Vague solutions (no code snippets or precise instructions)
   - Poor triggers (generic words that match everything)

4. **Save Location**:
   - **User-level**: ~/.claude/skills/omc-learned/ - Rare. Only for truly portable insights.
   - **Project-level**: .omc/skills/ - Default. Version-controlled with repo.

## What Makes a USEFUL Skill

**CRITICAL**: Not every solution is worth saving. A good skill is:

1. **Non-Googleable**: Something you couldn't easily find via search
   - BAD: "How to read files in TypeScript" ❌
   - GOOD: "This codebase uses custom path resolution in ESM that requires fileURLToPath + specific relative paths" ✓

2. **Context-Specific**: References actual files, error messages, or patterns from THIS codebase
   - BAD: "Use try/catch for error handling" ❌
   - GOOD: "The aiohttp proxy in server.py:42 crashes on ClientDisconnectedError - wrap StreamResponse in try/except" ✓

3. **Actionable with Precision**: Tells you exactly WHAT to do and WHERE
   - BAD: "Handle edge cases" ❌
   - GOOD: "When seeing 'Cannot find module' in dist/, check tsconfig.json moduleResolution matches package.json type field" ✓

4. **Hard-Won**: Took significant debugging effort to discover
   - BAD: Generic programming patterns ❌
   - GOOD: "Race condition in worker.ts - the Promise.all at line 89 needs await before the map callback returns" ✓

## Anti-Patterns (DO NOT EXTRACT)

- Generic programming patterns (use documentation instead)
- Refactoring techniques (these are universal)
- Library usage examples (use library docs)
- Type definitions or boilerplate
- Anything a junior dev could Google in 5 minutes

## When to Use

Use /learner ONLY after:
- Solving a tricky bug that required deep investigation
- Discovering a non-obvious workaround specific to this codebase
- Finding a hidden gotcha that wastes time when forgotten
- Uncovering undocumented behavior that affects this project

## Skill Format

Skills are saved as markdown with this structure:

### YAML Frontmatter
- id, name, description, source, triggers, quality (standard metadata)

### Body Structure (Required)

```markdown
# [Skill Name]

## The Insight
What is the underlying PRINCIPLE you discovered? Not the code, but the mental model.
Example: "Async I/O operations are independently failable. Client lifecycle != server lifecycle."

## Why This Matters
What goes wrong if you don't know this? What symptom led you here?
Example: "Proxy server crashes on client disconnect, taking down other requests."

## Recognition Pattern
How do you know when this skill applies? What are the signs?
Example: "Building any long-lived connection handler (proxy, websocket, SSE)"

## The Approach
The decision-making heuristic, not just code. How should Claude THINK about this?
Example: "For each I/O operation, ask: what if this fails right now? Handle it locally."

## Example (Optional)
If code helps, show it - but as illustration of the principle, not copy-paste material.
```

**Key**: A skill is REUSABLE if Claude can apply it to NEW situations, not just identical ones.

## Related Commands

- /note - Save quick notes that survive compaction (less formal than skills)
- /ralph - Start a development loop with learning capture
