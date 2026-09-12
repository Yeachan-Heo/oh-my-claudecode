---
name: loft
description: 'Loft the shape before cutting steel — answer a design question that prose cannot settle by building a throwaway artifact: a pure logic module in a clickable shell, or structurally different UI variants behind one route. The captain reacts to the artifact; the answer folds into the decision; the artifact never docks. Use when a design question stalls in words, when a navigator map carries a loft ticket, or when a spec discussion reaches "we would have to see it".'
level: 3
---

# Loft

**Cut no steel until the shape is fair.** Shipwrights loft the hull's lines full-scale and fair them before a single plate is cut. Loft applies the same order to design questions: when words have run out — two plausible answers, neither falsifiable by talk — build a cheap runnable artifact, let the captain react to it, and fold that reaction into the decision.

**The role contract.** The crew builds the artifact; the captain's only job is to react — and that reaction **is** the decision. The artifact is an instrument for seeing, never a head start on the deliverable.

## When to loft

- a design question stalls in prose: repeatedly rephrased, still not settleable ("how should the path page look", "does this state model feel right")
- a navigator map carries a `loft` ticket
- a spec discussion reaches "we would have to see it first"

Do **not** loft when:

- the question is answerable from repo evidence or by asking the captain (that is interviewing, not lofting)
- the destination itself is unclear (that is fog — `/oh-my-claudecode:ask-navigator`)
- the answer already lives in an ADR (do not re-loft settled decisions)
- the "design question" is actually a bug (that is the debugger's jurisdiction)

## Choose the fork

Pick by what the question is asking. A wrong fork wastes the whole artifact.

### Logic fork — is the model right?

For questions about state, business rules, data shape, or algorithms ("does unlocking regress on a retake?", "does this reducer hold at the edges?"):

1. Isolate the decision-bearing core — the state machine, reducer, schema, or algorithm — as a **pure module**: no DOM, no I/O, no framework. Written so that, once the shape is confirmed, it moves into the real codebase unchanged.
2. Wrap it in a single clickable HTML shell: one button per scenario, the tricky edge cases walked through in order, full state visible after every click.
3. On confirmation the module is ready to lift — it re-enters as real work through launch. During the loft itself `main` stays untouched and the shell stays behind on the branch.

### UI fork — what should it look like?

For questions of shape and arrangement ("steps or cards?", "where does progress live?"):

1. One route, **three variants that differ in structure** — information architecture, navigation model, density. Variants that differ only in styling answer nothing: three reskins are wallpaper.
2. A switcher on the page cycles the variants; embed into the existing product where possible, so real data density stresses the design instead of three tidy fake rows.
3. On confirmation, the **decision** transfers and the variants stay behind on the branch as the record of why it looks this way.

## The discipline

- One command to run — the repo's simplest existing serve command; inline the module into the shell if `file://` module CORS would bite. Loads in seconds; no build step beyond what the repo already has.
- No persistence, no tests, no abstractions, no error handling beyond the happy path. The artifact should be something you **would not want to ship** — the rules exist to keep it that way.
- Expect the first shape to be argued with: revise on the branch within the same session. The captain confirming the **final** shape is the decision; an artifact nobody argues with usually answered a question nobody had.
- The artifact's whole life is minutes to build and one session to decide. If it starts growing into production code, stop: that work is a launch effort, not a loft. Sunk cost is the failure mode this skill exists to prevent.
- One loft answers **one** question. Two questions are two lofts — or one question that was actually two.

## Fold the answer

The artifact is evidence, not a landing. When the captain reacts:

1. Record the decision where it lives — the issue comment, the spec's Implementation Decisions, or the pending-decision note — in the captain's own words plus one line of why. A fragment more precise than prose (the reducer, the state machine, the schema) may be inlined there, marked as lofted.
2. Push the artifact to a `loft/<name>` branch. It never merges: it stays as the primary source a future reader can open when the decision's "why" matters.
3. Nothing from the artifact lands in `main` — for the logic fork the confirmed module re-enters as real work through launch, for the UI fork the real page is built fresh from the decision.

## Scope and non-goals

- Loft produces **answers, not deliverables**: no runtime, no state files, nothing always-on.
- It does not diagnose (debugger), does not chart fog (`/oh-my-claudecode:ask-navigator`), does not approve its own answer (the captain's reaction is the only acceptance).
- It does not replace seam approval: a lofted UI shows the shape; the test seams for it are still approved at C2.

## Completion definition

The captain reacted, the answer sits where the decision lives, the artifact sits on its branch — and no line of the artifact is in `main`.
