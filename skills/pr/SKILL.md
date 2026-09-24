---
name: pr
description: Draft a PR body from OMC's existing paper trail — the change claim gets the smallest visual that proves the point, evidence is consumed from the verify protocol (never re-collected), and reversibility comes from running the ADR test on the diff itself. Glossary language throughout.
metadata:
  credits:
    summary-visuals: show-me
    author: Dex Horthy
    organisation: Humanlayer
    url: "https://github.com/humanlayer/skills/blob/main/plugins/show-me/skills/show-me/SKILL.md"
---

# PR Body

When work lands behind a review, the PR body is the one artifact a reviewer outside the session reads. Everything it needs already exists in the paper trail — this skill assembles it and adds nothing that was not already established. The summary-visual discipline is inspired by show-me (credited in the frontmatter).

## Template

```markdown
## Summary
<one-line claim, then the smallest visual that proves it>

## Evidence
- **Before:** <output / failing check>
  **After:** <output / passing check>

## Reversibility
<Rollback: cheap via <mechanism> | expensive because <reason>>
<Blast radius: one line>
```

## Sections

### Summary

State the change in one sentence, then show the smallest view that makes the point. Match the visual to the change:

- logic or an algorithm → pseudocode
- runtime control flow → a call tree
- UI structure → a component tree
- file responsibility or a broad refactor → a shallow file tree
- component interaction or data flow → a Mermaid diagram
- the delta itself → a diff shaped like the change (component, layout, call tree, or state machine)

Show the whole block only when most of it is new, omitted context would hide ownership, or the reviewer needs a copyable target shape. One visual usually suffices; never all forms.

### Evidence

Consume the verify protocol's output — BUILD, TEST, LINT, FUNCTIONALITY evidence, freshness rule inherited. Present before/after pairs: the exact check that failed before and passes after, quoted from the output itself. When the change is visual, prefer a captured screenshot; `qa-tester` can drive the runtime for one. Never re-collect evidence here and never claim evidence the verify pass did not produce.

### Reversibility

Run the ADR test on the diff itself — the same three questions launch applies to decisions: hard to reverse? surprising without context? the result of a real trade-off? A no on all three is a cheap rollback: say by what mechanism (revert the merge, toggle the flag). Any yes means an expensive rollback: say why. Link the ADR when the change implements or touches one. Close with the blast radius in one line — what else this change can move.

### Language

Terms come from `CONTEXT.md` where a glossary exists. The PR is read outside the session; the glossary is the only vocabulary the reader shares with it.

## Triggers

- launch Phase 5, when the platform reviews through PRs: the completion report carries a PR body drafted by this skill.
- Any session that opens or materially updates a PR.

## Output

- The PR body, ready to paste
- The paper-trail pointers it relies on (verify evidence, ADRs, spec)
