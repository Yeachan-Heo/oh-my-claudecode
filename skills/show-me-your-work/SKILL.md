---
name: show-me-your-work
description: Log a reviewable decision trail for long or autonomous work — one TSV row per non-obvious decision with the options rejected and the evidence that decided it, under .omc/state/decision-trail.tsv. Use for work the user steps away from and will audit later.
aliases: []
metadata:
  credits:
    decision-trail: pstack
    author: Lauren Tan
    url: "https://github.com/cursor/plugins/tree/main/pstack"
    port: pstack-claude
    port-author: Michael Denyer
    port-url: "https://github.com/michael-denyer/pstack-claude"
---

# Show Me Your Work

For work a human will audit after the fact, the reply is not the record —
the trail is. One row per non-obvious decision, written as it is made.

## When to use

- long, autonomous, or multi-phase work ("run until done", overnight runs)
- any task the user steps away from and will trust on return
- multi-day programs where the trail is the post-mortem

## The trail

Append to `.omc/state/decision-trail.tsv` (create with a header row on first
write; one file per task slug when sessions share a checkout):

```
ts <TAB> task <TAB> decision <TAB> rejected <TAB> evidence
```

- **decision**: what you chose, one sentence.
- **rejected**: the real alternatives you weighed and the one-line reason
  each lost. "None considered" is a valid, damning entry.
- **evidence**: the command, output, or citation that decided it.

Cell guard: a cell starting with `=`, `+`, `-`, or `@` is prefixed with `'`
so spreadsheet readers cannot parse it as a formula; tabs and newlines
inside a cell become spaces. Append only — the trail is never rewritten.

## Rules

- Log at decision time, not at recap time; a trail reconstructed at the end
  is fiction with a timestamp.
- Routine mechanical steps are not decisions; judgment calls, scope changes,
  and risk acceptances are.
- The final reply summarizes the trail and links it; the trail itself stays
  the auditable artifact. Commit it to the branch when stakes justify an
  immutable record, keep it local otherwise.
