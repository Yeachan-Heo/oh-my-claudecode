---
description: Extract a learned skill from the current conversation (Mnemosyne - goddess of memory)
---

# Mnemosyne - Skill Extraction

You are being asked to extract a reusable skill from the current conversation.

$ARGUMENTS

## What This Does

Mnemosyne (named after the Greek goddess of memory) saves knowledge you've discovered during problem-solving as a reusable "skill" that will be automatically loaded in future sessions when similar problems arise.

## Extraction Process

1. **Review Recent Work**: Look at what was just accomplished. What problem was solved? What approach was used?

2. **Gather Required Information**:
   - **Problem Statement**: What problem does this skill solve? (minimum 10 characters)
   - **Solution**: What is the key insight or technique? (minimum 20 characters)
   - **Triggers**: What keywords should activate this skill? (3-5 specific keywords)
   - **Scope**: User-level (portable across projects) or Project-level (specific to this codebase)?

3. **Quality Validation**: Before saving, the system checks:
   - Problem is clearly stated
   - Solution is actionable
   - Triggers are specific (not generic like "the" or "it")
   - No duplicate skill exists with similar triggers

4. **Save Location**:
   - **User-level**: ~/.claude/commands/sisyphus-learned/ - Available in all projects (loaded by Claude Code)
   - **Project-level**: .sisyphus/skills/ - Specific to this project, version-controllable

## When to Use

Use /mnemosyne after:
- Solving a tricky bug through investigation
- Discovering a non-obvious workaround
- Learning a project-specific pattern
- Finding a technique worth remembering

## Skill Format

Skills are saved as markdown files with YAML frontmatter containing:
- id: Unique identifier
- name: Human-readable name
- description: Brief description
- source: "extracted" for /mnemosyne skills
- triggers: Array of keywords that activate the skill
- quality: Score from quality validation

## Related Commands

- /note - Save quick notes that survive compaction (less formal than skills)
- /ralph-loop - Start a development loop with learning capture
