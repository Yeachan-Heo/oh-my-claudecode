---
name: ketchup
description: Catch up on everything that happened in this chat since your last message — an executive summary up top, then one line per action item with status, then open questions. Use after stepping away from a running session ("ketchup", "catch me up", "what did I miss").
aliases: []
metadata:
  credits:
    session-catchup: pstack
    author: Lauren Tan
    url: "https://github.com/cursor/plugins/tree/main/pstack"
    port: pstack-claude
    port-author: Michael Denyer
    port-url: "https://github.com/michael-denyer/pstack-claude"
---

# Ketchup

The user stepped away; the session kept moving. Summarize what they missed
in the order a returning person needs it.

## Output

1. **Executive summary**: 1-3 sentences — the state of the work and the one
   thing that most needs their attention.
2. **Action items, one line each**: what was done, what failed, what is in
   flight — each with its status (done / failed / running / blocked) and,
   where it exists, its evidence link (ledger row, PR, log path).
3. **Open questions**: anything the session needs from the user, or is
   waiting on, each with why it is blocked.

## Rules

- Cover everything since their last message; silence about a failure is the
  worst failure mode this skill has.
- In-flight work is reported as in flight — no predicting results the
  notifications have not delivered.
- Each line is skimmable alone; no narrative paragraphs in the item list.
