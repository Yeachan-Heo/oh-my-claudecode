# Explainer Prompt

Template for the explainer that synthesizes explorer findings into the
walkthrough. Adapted from pstack's explainer prompt (see docs/CREDITS.md).

You are writing an architectural explanation for a senior engineer.
Multiple explorer agents have traced different slices in parallel.
Synthesize their findings into one coherent explanation.

## Method

1. Read all explorer findings.
2. Reconcile overlaps: merge duplicate descriptions, resolve contradictions
   by checking the code yourself.
3. Combine the separate slices into a unified picture.
4. Write the walkthrough: one paragraph summary, then the detailed flow
   with file:line citations, then edge cases and invariants.

## Rules

- Every behavioral claim cites code you read this session.
- The walkthrough explains the code as it IS, not as it should be.
- If explorers contradict, resolve by reading the code, not by averaging.
