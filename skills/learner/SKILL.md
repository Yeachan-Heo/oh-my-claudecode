---
name: learner
description: Extract a learned skill from the current conversation
level: 7
---

# Learner Skill

> Deprecated compatibility alias: use `/oh-my-claudecode:skillify` for new skill extraction workflows. This file remains for internal implementation/history and compatibility.

This is a Level 7 (self-improving) skill. It has two distinct sections:
- **Expertise**: Domain knowledge about what makes a good skill. Updated automatically as patterns are discovered.
- **Workflow**: Stable extraction procedure. Rarely changes.

Only the Expertise section should be updated during improvement cycles.

---

## Expertise

> This section contains domain knowledge that improves over time.
> It can be updated by the learner itself when new patterns are discovered.

### Core Principle

Reusable skills are not code snippets to copy-paste, but **principles and decision-making heuristics** that teach Claude HOW TO THINK about a class of problems.

**The difference:**
- BAD (mimicking): "When you see ConnectionResetError, add this try/except block"
- GOOD (reusable skill): "In async network code, any I/O operation can fail independently due to client/server lifecycle mismatches. The principle: wrap each I/O operation separately, because failure between operations is the common case, not the exception."

### Quality Gate

Before extracting a skill, ALL three must be true:
- "Could someone Google this in 5 minutes?" → NO
- "Is this specific to THIS codebase?" → YES
- "Did this take real debugging effort to discover?" → YES

### Recognition Signals

Extract ONLY after:
- Solving a tricky bug that required deep investigation
- Discovering a non-obvious workaround specific to this codebase
- Finding a hidden gotcha that wastes time when forgotten
- Uncovering undocumented behavior that affects this project

### What Makes a USEFUL Skill

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

### Anti-Patterns (DO NOT EXTRACT)

- Generic programming patterns (use documentation instead)
- Refactoring techniques (these are universal)
- Library usage examples (use library docs)
- Type definitions or boilerplate
- Anything a junior dev could Google in 5 minutes

---

## Workflow

> This section contains the stable extraction procedure.
> It should NOT be updated during improvement cycles.

### Step 1: Gather Required Information

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

### Step 2: Quality Validation

The system REJECTS skills that are:
- Too generic (no file paths, line numbers, or specific error messages)
- Easily Googleable (standard patterns, library usage)
- Vague solutions (no code snippets or precise instructions)
- Poor triggers (generic words that match everything)

### Step 3: Classify as Expertise or Workflow

Before saving, determine if the learning is:
- **Expertise** (domain knowledge, pattern, gotcha) → Save as `{topic}-expertise.md`
- **Workflow** (operational procedure, step sequence) → Save as `{topic}-workflow.md`

This classification ensures expertise can be updated independently without destabilizing workflows.

### Step 4: Save Location

- **User-level**: `${CLAUDE_CONFIG_DIR:-~/.claude}/skills/omc-learned/<skill-name>.md` - Rare. Only for truly portable insights.
- **Project-level**: `.omc/skills/<skill-name>.md` - Default. Intended to be committed with the repo when you want the team to keep the skill. In linked worktrees, uncommitted skills are still worktree-local and disappear if that worktree is deleted.

### Required File Format

Every learned skill file MUST start with YAML frontmatter so learned-skill flat-file discovery can load it.
Do **not** write plain markdown without frontmatter.

Minimum required frontmatter:

```yaml
---
name: <skill-name>
description: <one-line description>
triggers:
  - <trigger-1>
  - <trigger-2>
---
```

### Skill Body Template

```markdown
---
name: <skill-name>
description: <one-line description>
triggers:
  - <trigger-1>
  - <trigger-2>
---

# [Skill Name]

## The Insight
What is the underlying PRINCIPLE you discovered? Not the code, but the mental model.

## Why This Matters
What goes wrong if you don't know this? What symptom led you here?

## Recognition Pattern
How do you know when this skill applies? What are the signs?

## The Approach
The decision-making heuristic, not just code. How should Claude THINK about this?

## Example (Optional)
If code helps, show it - but as illustration of the principle, not copy-paste material.
```

**Key**: A skill is REUSABLE if Claude can apply it to NEW situations, not just identical ones.

## Related Commands

- /oh-my-claudecode:note - Save quick notes that survive compaction (less formal than skills)
- /oh-my-claudecode:ralph - Start a development loop with learning capture
