---
name: minimal-code-discipline
description: YAGNI-ladder coding discipline for writing changes — existence-first, reuse before writing, dependency ladder, shortest correct diff, with non-negotiables that must never be minimized away
level: 3
---

# Minimal Code Discipline

Use this skill to apply a minimal-code (YAGNI-ladder) discipline while planning and writing code changes. It keeps diffs small and obviously correct without sacrificing the checks that keep users safe.

This skill complements `ai-slop-cleaner`: that skill cleans slop after it lands; this one keeps it from being written.

## When to Use

Use this skill when:
- the user asks for a minimal, lean, YAGNI, or smallest-possible-diff implementation
- a plan or in-flight change is growing beyond the stated request
- writing new code where scope creep, reinvented helpers, or speculative generality are likely
- reviewing a proposed diff for size before implementation

## When Not to Use

Do not use this skill when:
- the user explicitly asks for a broad, feature-rich, or future-proofed build (their explicit scope wins)
- the task is exploratory scaffolding the user has marked as throwaway
- minimization pressure would touch protected behavior (see Non-Negotiables)

## The Discipline

**Existence first.** Ask whether the change needs to exist at all; skip work that serves only a speculative future need.

**Reuse before writing.** Search the codebase for an existing helper, type, or pattern before writing anything new. Never copy a helper that already lives a few files away — reuse it or extract it to one shared location.

**Dependency ladder.** Reach for the standard library first, then platform-native capability, then an already-installed dependency. Hand-written code is the last resort. Do not introduce a new dependency when a few lines of code suffice, unless the user explicitly requested or approved it.

**Understand before minimizing.** Read the affected code and follow its execution path first. Ship the shortest correct diff once the problem is understood — code you never write never breaks.

**Boring over clever.** Prefer boring, obviously-correct code over clever code.

**Mark the ceiling.** Record deliberate simplifications with a short comment naming the accepted limit and what would justify replacing it.

**Root cause, not symptoms.** Fix bugs at the root cause shared by every caller, not with a separate patch for each reported symptom.

## Non-Negotiables

Never minimize away:
- validation wherever a trust boundary is crossed
- error handling that guards against data loss
- security controls
- accessibility fundamentals
- scope the user explicitly requested

## Verification

Before reporting completion, confirm:
- every added line earns its place (no speculative generality, no duplicate helpers)
- the diff is the shortest one that correctly solves the stated problem
- non-negotiables are intact
- tests still pass and behavior is unchanged except as requested
