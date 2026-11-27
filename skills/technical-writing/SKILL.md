---
name: technical-writing
description: "One layered standard for shipping prose — docs, RFCs, readmes, PR descriptions, commit messages: outcome first, one meaning one home, checkable statements, no filler. Composes with minimal-prose-discipline."
aliases: []
metadata:
  credits:
    layered-writing-standard: pstack
    author: Lauren Tan
    url: "https://github.com/cursor/plugins/tree/main/pstack"
    port: pstack-claude
    port-author: Michael Denyer
    port-url: "https://github.com/michael-denyer/pstack-claude"
---

# Technical Writing

Prose that ships — docs, RFCs, readmes, PR descriptions, commit messages —
follows one standard so readers can navigate any of them the same way.

## The standard

1. **Outcome first.** The first sentence says what changed for whom and what
   the reader can now do. Context comes after the reader knows why they
   care.
2. **One meaning, one home.** Each fact lives in exactly one place; every
   other mention links there. Duplicated facts rot at different speeds.
3. **Checkable statements.** Prefer a statement the reader can verify with a
   command or a glance over an adjective. "Builds in ~40s" beats "fast".
4. **Layered structure.** Summary, then detail, then edge cases — each layer
   readable alone, each deeper layer skippable.
5. **No filler.** No restating the obvious, no throat-clearing, no AI tells
   (`ai-slop-cleaner` territory; this skill composes with it).

## Cut every word that does no work

- If the sentence survives without a word, the word goes. "In order to" is
  "to".
- Use the short, everyday word: "use", not "utilize".
- Write the real symbol, file, flag, or command name, not a synonym or a
  description of it.
- Don't invent jargon. Use the words a developer would say out loud; say
  what a named pattern means the first time.
- When a rule makes a sentence worse, fix the sentence another way or leave
  it alone.

## Pick the mode first (Diátaxis)

One document, one mode. Don't mix modes; split and link instead.

- **Tutorial: learning by doing.** Say what the learner will build. Every
  step produces a visible result, and you say what they should see.
  Explanation gets one clause and a link.
- **How-to: steps to a goal.** Solve the reader's problem. Assume
  competence. Action only. Allow forks. Name the guide by the task.
- **Reference: facts for lookup.** Only describe. Be dry, complete, and
  sure. Mirror the structure of the thing described.
- **Explanation: understanding and why.** One bounded topic. Give context:
  design decisions, history, constraints, alternatives. Opinion is allowed
  here and nowhere else.

## Write sentences to the reader

- Talk to the reader as "you", in the present tense. Say who does what;
  passive only when the actor is unknown or beside the point.
- Write instructions as commands. Put the condition before the instruction
  and the common case first.
- Vary sentence lengths: split the sentence that carries two thoughts, keep
  the long one that carries one. Have a view in explanation; keep reference
  dry.
- Keep "only" and "not" next to the word they change. Break up long noun
  strings. Make every "it", "they", and "this" point at one obvious thing.
- Keep "the" and "a". Give each word one meaning, and pick one word per
  action.
- Use periods, not semicolons or em dashes. No slashes and no "(s)".
- Never "simply", "easy", or "quickly" in a procedure. Skip idioms and
  metaphors.
- Headings carry the point, in sentence case. One h1 per page, no skipped
  levels.

## Per surface

- **Commit message**: subject says what changed in one line ≤72 chars; body
  says why, and the constraint that made the change necessary.
- **PR description**: claim, evidence (before/after), reversibility — the
  `pr` skill owns the full template.
- **README**: what it is, who it is for, the shortest working example, then
  everything else.
- **RFC/design doc**: problem, constraints, options considered with why the
  losers lost (feeds from `architect`), decision, migration.

## Rules

- Write clean as you draft; a cleanup pass after drafting does not remove
  these patterns.
- Every claim carries its evidence or its label in the same sentence.
- Delete more than you add; the reader's time is the budget
  (`principles` skill, Minimize reader load).
