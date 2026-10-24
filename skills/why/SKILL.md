---
name: why
description: Investigate why code is the way it is — evidence from git history, linked issues, incident records, and observability sources, with human rulings quoted verbatim. Deliverable is a cited answer that separates evidence, inference, and guess. Use for "why was this built this way", "are we sure about Z", "should we do X or Y".
aliases: []
metadata:
  credits:
    investigation-epistemics: pstack
    author: Lauren Tan
    url: "https://github.com/cursor/plugins/tree/main/pstack"
    port: pstack-claude
    port-author: Michael Denyer
    port-url: "https://github.com/michael-denyer/pstack-claude"
---

# Why

Answer "why is it like this?" from evidence, not vibes. The deliverable is a
cited answer, not a fix; a fix that falls out of the answer goes through its
own lane.

## When to use

- "why was this built this way", "why does this exist"
- "are we sure about Z" before betting work on Z
- "should we do X or Y" where the answer lives in history, not preference

## Sources, in order of authority

1. **Human rulings.** A decision a person made is quoted verbatim with
   attribution (commit message, issue comment, PR review, chat log). Never
   paraphrase a ruling into your own words; label agent interpretations as
   interpretations, and missing originals as missing. A copy of a ruling is
   not a new decision.
2. **Code archaeology.** `git log --follow`, `git log -S`, blame on the
   deciding lines, and the diff that introduced them. Name the commit and
   what problem its message claims to solve.
3. **Linked records.** Issues and PRs reachable from the code (references in
   commit messages, `gh issue list --search`, PR review threads) — acceptance
   criteria and rejected alternatives live here.
4. **Incident and observability sources.** When configured, query them
   through their own tools (Sentry, Datadog, Databricks, dashboards,
   incident postmortems) or MCP servers (Slack, Linear, Notion). Cite the
   alert, thread, ticket, or postmortem. If a source needs credentials you
   do not have, say so and move on.

## Method

1. State the question and what would count as an answer.
2. Fan out source gathering to a read-only subagent when the history is long
   (`oh-my-claudecode:explore`); keep synthesis in the lead.
3. Reconcile: where sources conflict, the more authoritative source wins, and
   the conflict itself is reported.
4. Write the answer with three labeled tiers — **evidence** (cited),
   **inference** (your reasoning from evidence, marked), **guess** (marked).
   End with the one action the answer most supports, or "no action".

## Rules

- Every claim about a past decision names its source in the same sentence.
- Absence of evidence is reported as "no record found", never as "no reason".
- The answer never edits code. If the user asks to act on it, hand off to
  `execute` or `debug`.
