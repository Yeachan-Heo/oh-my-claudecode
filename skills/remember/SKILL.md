---
name: remember
description: Review reusable project knowledge and decide what belongs in project memory, notepad, or durable docs
---

# Remember

Use this skill when the user wants to preserve or organize useful knowledge discovered during a session.

## Goal
Promote durable, reusable knowledge into the right memory surface instead of leaving it buried in chat history.

## Memory surfaces
- **Project memory** — durable team/project knowledge
- **Notepad priority** — short high-signal context for the next turns
- **Notepad working** — temporary active-session notes
- **Docs / AGENTS / CLAUDE files** — durable instructions and conventions when they truly belong there

## Workflow
1. Gather the relevant session findings.
2. Classify each item. When there is more to keep than room for, select in
   this order: the user's mistakes and corrections first, then preferences
   and instructions, then durable facts, then duplicates and conflicts to
   clean up:
   - user mistake or correction (what went wrong and what the user wants instead)
   - operator preference or instruction
   - durable project fact
   - duplicate / stale / conflicting information
   - temporary working note (notepad, not project memory)
3. Propose the best destination for each item.
4. Write or update only the appropriate memory surface.
5. Call out duplicates or conflicts that should be cleaned up.

## Rules
- Do not dump everything into one store.
- Prefer project memory for durable team knowledge.
- Prefer notepad for short-lived working context.
- Keep entries concise and actionable.
- If something is uncertain, mark it as uncertain rather than storing it as fact.
- When the destination is a user memory note (a file under
  `${CLAUDE_CONFIG_DIR:-$HOME/.claude}/projects/<project>/memory/`), set `metadata.source` (`user` only
  with a quote of the user's words, otherwise `agent` or `inferred`), set
  `metadata.expires` for dated state, and set `metadata.lastVerified` when
  you checked the note against the repository or system. For a repeated
  user correction, record the `count` field as described in `correct`.
  The `metadata.*` fields and `count` are a convention for the note; the agent
  that reads the note follows it, and no OMC code reads these fields.

## Output
- What was stored
- Where it was stored
- Any duplicates/conflicts found

