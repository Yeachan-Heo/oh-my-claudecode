---
name: research
description: Investigate an open question and return grounded, sourced findings
---

# Research

Use this skill when the next step depends on something not yet known. Research
answers questions; it does not implement.

This is the canonical research lane. `deep-dive`, `sciomc`, and `autoresearch`
route here.

## Goal
Replace assumptions with evidence, and say plainly what remains uncertain.

## Workflow
1. State the question precisely enough to know when it is answered.
2. Search the repo and its docs first — local evidence outranks recollection.
3. For external SDKs, frameworks, or APIs, consult official documentation.
4. Sweep more than one way when the answer could hide: by file, by symbol, by caller, by history.
5. Synthesize into findings, each tied to where it came from.

## Scale
- **Narrow lookup** — answer it directly.
- **Multiple independent questions** — investigate in parallel.
- **Unknown-size discovery** — keep going until additional passes surface nothing new.

## Rules
- Cite the source: file and line, or the document consulted.
- Distinguish what was verified from what was inferred.
- Report contradicting evidence rather than picking the tidier story.
- Do not implement as a side effect of researching.

## Output
- The question
- Findings, each with its source
- What remains unknown or unverifiable
- Recommended next step, if one follows
