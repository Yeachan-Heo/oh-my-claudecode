---
name: personal-mode
description: "Draft a user-level behavior profile from recent transcripts — cross-project preferences, habits, and standing calls stored under the user skills dir so every project's agents work the way you work. For 'make agents work like me'."
aliases: []
metadata:
  credits:
    personal-mode-concept: pstack
    author: Lauren Tan
    url: "https://github.com/cursor/plugins/tree/main/pstack"
    port: pstack-claude
    port-author: Michael Denyer
    port-url: "https://github.com/michael-denyer/pstack-claude"
---

# Personal Mode

Project skills say how to work in *this* repo. A personal mode says how
*you* work, everywhere: the calls you would make, the depth you want, the
ceremony you skip. This skill drafts one from evidence — your recent
transcripts — not from a questionnaire.

## When to use

- the user asks for agents to work like them across projects, or to
  remember their working style
- the same correction keeps coming up in unrelated repos

## When not to use

- repo-specific conventions — those are project skills (`skillify`)
- one-off preferences — `remember` stores those cheaply

## Workflow

1. **Gather evidence**: recent transcripts across the user's projects
   (with the user's say-so for which span). Look for *repeated* signals:
   corrections the user made more than once, reply-length or
   verbosity preferences, risk calls (autonomy grants, pause points),
   tools they always or never want used.
2. **Draft the profile** as skill edits, grouped and each tied to the
   transcript moments that evidence it. A preference seen once is a
   hypothesis; state it as one and ask.
3. **Confirm with the user** — every line of a personal mode is a standing
   call the user is making about their own agents; nothing lands unconfirmed.
4. **Write** the confirmed profile to a separate user skills entry,
   `${CLAUDE_CONFIG_DIR:-$HOME/.claude}/skills/personal-mode-profile/SKILL.md`.
   Keep this generated profile separate from the bundled `personal-mode`
   workflow so the generator remains discoverable and editable. A user skill
   is opt-in context; it is not a global instruction applied to every task.
   Use frontmatter, triggers, and short checkable rules — a personal mode
   that restates platitudes is dead weight
   (`minimal-prose-discipline` applies).
5. **Report** what was captured, what was hypothesized but unconfirmed,
   and how to edit it later (`skill` command).

## Rules

- Evidence first: every profile line cites the transcript moments behind
  it; a line without evidence is asked about, not written.
- The profile layers *under* project skills — a repo's explicit rules win.
- Personal modes contain no secrets, tokens, or private data — only
  working-style calls.
- Re-running this skill revises; it never silently overwrites — show the
  diff and confirm.
