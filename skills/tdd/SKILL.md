---
name: tdd
description: Test-first discipline at pre-agreed seams — one test, one implementation, tracer-bullet steps; expected values from an independent source of truth; substitutes only at the seam's declared boundary; refactoring kept out of the loop. The discipline launch Phase 4 refers to when workers implement at the seams approved in C2.
---

# TDD

Red-green in small steps, at seams that were agreed in advance. In a launch run the seam list is C2's approved output; outside launch, agree the seams with the user before the first test exists — a seam nobody approved gets no tests.

## The loop

One test → one implementation → repeat:

1. Write the next test at a seam. Run it. Watch it fail for the reason you expect — a test that cannot fail is not a test.
2. Implement the smallest change that turns it green.
3. Repeat. Each test is a tracer bullet: a narrow but complete path through the behavior, not a layer finished in isolation.

## Rules

- Expected values come from an independent source of truth — a spec line, a worked example, a documented output. Never from the implementation under test: a test that asserts what the code happens to do is a mirror, not a check.
- Substitute at the seam's declared boundary class only — in-process, locally substitutable, owned-remote port, or true-external, the class C2 records for each seam. No substitutes inside the boundary the test is exercising.
- Refactoring is not part of the loop. It belongs to the review stage; the repair worker owns it. Do not refactor mid-red-green.
- A bug fix starts with the failing test that reproduces it — reproduction before theory, the debugger's rule.

## When no seam fits

If the behavior cannot be tested at any approved seam, stop and say so: report the missing seam as a finding (it feeds `architecture-survey` and `refit`) rather than inventing a seam or testing through internals.

## Output

- The seam list used, with boundary classes
- Red/green evidence — the failing run and the passing run
- Any seam-absence findings
