# Epistemics

How to reason about confidence when evidence is historical, fragmentary, and
sometimes contradictory — and how to tell the user without flattening nuance
into false certainty. Code shows what it does, not *why* it exists. The why
lives in commits, PRs, tickets, docs, and conversations — all incomplete,
biased, and sometimes missing.

Adapted from pstack's epistemics reference (see docs/CREDITS.md).

## Claims about human decisions

When the exact scope of a human ruling matters, locate the person's original
attributable words. Preserve a source pointer, the speaker, and enough
original wording to establish scope. Label an agent summary or interpretation
as such, regardless of its age. A paraphrase alone cannot establish the
original instruction's exact scope. If the original is unavailable, say so
and leave that scope uncertain; do not invent a firm restriction or
permission.

For example, "avoid that endpoint during this migration" and an agent's "the
user permanently forbids that endpoint" are different claims. Report the
scoped original and the broader interpretation separately.

## Confidence Tiers

Every claim in the output must sit in one tier. The tier sets its section and
its phrasing.

### 1. Direct

An explicit, textual citation answers the question: something an author
actually *wrote* that says why. Examples: a PR description, a ticket, a code
comment, a design doc, a chat message.

Phrasing: confident, cited. "This exists because X."

### 2. Supported

Multiple pieces of indirect evidence converge on one conclusion. No single
source states it explicitly, but the pattern across sources makes it likely.

Phrasing: confident but clearly derived, citing each item.

### 3. Inferred

A reasonable reading of the context that nothing explicitly supports. It is
*your interpretation*, not a fact from the record.

Phrasing: hedged, with the chain explicit. "Given A and B, C seems likely
because D."

### 4. Speculative

A plausible hypothesis on thin evidence, where other explanations fit
equally well. Worth presenting, since the user may know which is right.

Phrasing: "One possibility is X, but we have no direct evidence."

### 5. Unknown

You looked and couldn't find out. A valid, important outcome. Document it.

Phrasing: "We searched X, Y, and Z and found no evidence of why." Be
specific about *what* you searched.

## Phrasing Guide

**Confidence words** imply Direct or Supported evidence and need a citation
immediately adjacent. Never use them for inferences: "because", "the reason
is", "was designed to", "fixes", "the team decided".

**Hedges** signal interpretation, not report: "appears to", "seems to",
"likely", "suggests", "is consistent with", "one reading is", "plausibly",
"may have been", "the evidence points toward".

**Words to avoid:** "obviously", "clearly", "of course", "just" (as in "it's
just X for performance"), "I think" / "I believe".

## Avoid Rationalization

Code that "makes sense" today may have been written for reasons that no
longer apply. Don't retrofit a clean rationale onto messy history. Don't
assume the author did the "right" thing and work backward to justify it.
Don't assume a consistent pattern was intentional when it might be
copy-paste.

## The Sycophancy Trap

Users often embed a hypothesis: "Why do we do it this way, I assume it's for
performance?" Don't simply confirm it. Treat it as one candidate among
others and check the evidence independently.

## When Evidence Contradicts

Surface both sources in the output, with citations. Don't pick the one that
fits a tidier narrative.

## When Evidence Is Missing

An honest "we don't know" is one of the most valuable outputs. Name each gap
concretely: the question, the sources searched, what you searched for in
each, and what you found.

## Before Finalizing

Check every claim: has a citation or moves to Inferred or Hypotheses. Its
phrasing matches its tier. The output has a "What We Don't Know" section.
