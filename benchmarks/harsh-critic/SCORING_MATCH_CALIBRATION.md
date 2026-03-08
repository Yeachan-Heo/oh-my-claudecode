# Scoring Match Calibration Rationale

## Why This Change Exists

The benchmark matcher currently relies on strict substring overlap with a fixed threshold:

- Match rule: `countKeywordMatches >= 2`
- String check: raw lowercase `includes(...)`

This is brittle for real model outputs where wording is semantically correct but formatted differently:

- punctuation / separator variation: `new-hire` vs `new hire`
- symbol variation: `processPayment():47-52` vs `processPayment 47 52`
- phrase variation: keyword phrase appears with punctuation between tokens

The failure mode is false negatives in benchmark scoring, not model quality regressions.

## What This PR Changes

1. Normalizes text for matching:
- case-fold
- unicode normalization (`NFKC`)
- punctuation and separators collapsed to spaces

2. Adds phrase fallback matching:
- multi-token keywords match if all tokens are present in normalized text
- preserves direct substring matching first (fast path)

3. Uses dynamic threshold by keyword-set size:
- base remains `MIN_KEYWORD_MATCHES = 2`
- for 6-keyword findings, required matches become 3 (40% proportional floor)

## Why This Method Is Better

This method improves robustness without turning matching into fuzzy semantic search:

- deterministic and auditable (no embeddings, no LLM-in-the-loop scorer)
- still keyword-grounded (no synonym hallucination risk)
- controls accidental matches on larger keyword sets via dynamic threshold
- keeps existing behavior for 4-5 keyword findings (still requires 2)

In short: it reduces formatting-induced false negatives while preserving precision guardrails.

## Risk and Mitigations

Risk: looser normalization could increase false positives.

Mitigations:
- keyword match threshold is not globally lowered
- larger keyword sets now require more evidence (3/6 instead of 2/6)
- added regression tests for both positive and negative threshold boundaries

## Alternatives Considered

1. Keep strict `includes` + fixed threshold:
- rejected: too brittle to punctuation/format variants seen in real outputs

2. Lower fixed threshold globally to 1:
- rejected: large precision loss, especially for common terms

3. Embedding-based semantic matcher:
- rejected for now: higher complexity, less deterministic, harder to audit

## Validation

- Unit test suite passes with added calibration tests:
  - punctuation/hyphen robustness
  - 6-keyword threshold negative case (2/6 fails)
  - 6-keyword threshold positive case (3/6 passes)

- Live benchmark rerun is intentionally separate due to API cost/variance and should be done after merge for clean before/after reporting.
