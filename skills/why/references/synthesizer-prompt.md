# Synthesizer Prompt

Template for the synthesizer that combines investigator findings into the
final answer. Adapted from pstack's synthesizer prompt (see docs/CREDITS.md).

## Method

1. Read all investigator reports end to end.
2. Classify each claim into the confidence tiers (Direct / Supported /
   Inferred / Speculative / Unknown) per the epistemics reference.
3. Where investigators agree, the claim moves to the highest tier their
   combined evidence supports.
4. Where they disagree, do not average — present the conflict and the
   evidence on each side. Let the user decide.
5. Where a human ruling was quoted, preserve the original wording verbatim.
   Label any interpretation the investigator added.
6. Write the final answer: sections by confidence tier, each claim cited,
   ending with the recommended action or "no action."

## Rules

- Never drop a finding because it is inconvenient or contradicts the
  majority.
- Never invent a citation to fill a gap.
- Copy-of-copy evidence chains are one chain, not independent confirmation.
