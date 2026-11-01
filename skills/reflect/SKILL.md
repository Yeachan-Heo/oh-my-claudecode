---
name: reflect
description: "After a long task, a three-reviewer panel audits the session transcript — tooling, judgment, missed alternatives — and proposes concrete skill edits. Findings feed skillify. For banking marathon-session lessons."
aliases: []
metadata:
  credits:
    transcript-review-panel: pstack
    author: Lauren Tan
    url: "https://github.com/cursor/plugins/tree/main/pstack"
    port: pstack-claude
    port-author: Michael Denyer
    port-url: "https://github.com/michael-denyer/pstack-claude"
---

# Reflect

Long sessions teach things nobody writes down. This skill audits the
session transcript with independent reviewers and converts the findings
into proposed edits to OMC's own skills — before the lessons evaporate.

## When to use

- a marathon session just ended (or is ending) and went well or badly in
  ways worth banking
- the user asks "what did we learn", "bank this session", or says reflect

## When not to use

- routine sessions with nothing anomalous — reflection on nothing is noise
- the user wants a summary of what happened — `ketchup` does that

## Workflow

1. **Locate the transcript** for this session and hand each reviewer the
   path, not a paste — reviewers read it themselves.
2. **Seat the panel**: three read-only reviewers in one message, in the
   background, each with one lens:
   - **tooling reviewer** — which commands, skills, and agents helped or
     wasted time; what a script or skill should have existed
   - **judgment reviewer** — where calls were wrong, late, or unverifiable;
     which principle would have caught it
   - **divergent reviewer** — the alternative approaches never tried; what
     a fresh agent would have done differently
   Each returns at most three findings, each with transcript citations.
3. **Synthesize**: merge duplicates, drop unevidenced claims, rank by how
   often the lesson would recur. A lesson that applies once is a note; one
   that applies every session is a skill edit.
4. **Propose skill edits**: for each surviving recurring lesson, the
   concrete edit — which skill file, which section, what wording — or a
   proposal for a new skill via `skillify`. Human-ruling wording stays
   verbatim (`why` skill epistemics).
5. **Report** the findings and the proposed edits; apply an edit only with
   the user's go — reflection proposes, the user disposes.

## Rules

- Reviewers cite the transcript; a finding without a citation is dropped.
- The panel never edits skills itself — proposals go to the user and then
  to `skillify` for execution.
- Findings about the user's own choices are reported as observations, not
  corrections.
