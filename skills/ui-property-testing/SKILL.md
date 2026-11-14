---
name: ui-property-testing
description: "Property-based testing for web and terminal UIs: write temporal properties (always/eventually), extractors, and action generators, then explore the UI autonomously to break them. For \"property-test this UI\" or UI fuzzing."
aliases: []
metadata:
  credits:
    ui-property-testing: pstack
    author: Lauren Tan
    url: "https://github.com/cursor/plugins/tree/main/pstack"
    port: pstack-claude
    port-author: Michael Denyer
    port-url: "https://github.com/michael-denyer/pstack-claude"
---

# UI Property Testing

Property-based testing for web and terminal UIs. Unlike example-based tests
(Playwright/Cypress scripts, snapshot tests) that describe how the UI behaves
for *particular* cases, a property describes how it behaves *in general* —
an invariant that must always hold, or a condition that must eventually be
reached — and an autonomous explorer generates and runs the interaction
sequences that try to break it.

Mechanism credit: the property/extractor/action-generator discipline derives
from [bombadil](https://github.com/antithesishq/bombadil) (Antithesis),
re-expressed for OMC on Playwright and agent-driven exploration.

## When to use

- "property-test this UI", "fuzz this interface", "find bugs I can't think of"
- a UI has invariants worth more than point examples: totals that must stay
  consistent, dialogs that must always close, flows that must eventually land
- hardening a surface before release, beyond what scripted E2E covers

## When not to use

- the behavior is fully covered by existing scripted E2E cases
- there are no invariants worth stating — example-based tests are cheaper
- the surface is not automatable (no browser/terminal driver available)

## Tool selection

- **bombadil CLI** (`command -v bombadil`): drive the real tool —
  `bombadil browser test <url> <spec.ts>` (or `terminal test
  --specification=<spec> <command>`); specs are ES modules exporting only
  properties and action generators, so the discipline below writes
  bombadil-compatible specs directly.
- **Otherwise**: Playwright drives the exploration loop, and this skill's
  explorer discipline fills the role of the fuzzer (see the exploration
  contract).

## The spec

A spec is one ES module exporting only **properties** and **action
generators**:

- **Extractors** run on every captured state and return JSON-serializable
  data as a stateful cell (`.current` reads it):
  `const title = extract(state => state.document.title || "")`.
- **Properties** are temporal statements over cells:
  `always(() => title.current !== "")` — the thunk is evaluated in every
  state; `eventually(() => resultsShown.current).within(10, "seconds")`.
  Compose with `.and(...)`. Export each property with a meaningful name —
  it names the failure report.
- **Action generators** return the possible actions per state, parameterized
  by value ranges: `actions(() => [search("Bombadil"), myWait()])`. Custom
  actions register a function the driver executes:
  `registerCustomAction("search", async (document, window, query) => ...)`.
- Ship sensible **defaults** alongside custom properties: uncaught
  exceptions, unhandled promise rejections, console errors, HTTP 4xx/5xx —
  these find bugs before any custom invariant does.

## Exploration contract (no bombadil CLI)

When driving the loop as the explorer:

1. Load the spec, load the surface, capture state 0 (run all extractors,
   evaluate all property thunks).
2. Loop: for the current state, enumerate actions from every action
   generator; pick one (vary across runs — seeded randomness, different
   ranges), execute it via the driver, settle (network idle or explicit
   wait), capture the next state, evaluate every property thunk.
3. A property thunk returning false — or a driver exception, console error,
   or 4xx/5xx — is a **violation**: record the full action trace immediately.
4. **Shrink**: from the failing trace, drop actions from the end and middle
   (halving passes) and re-run; keep any shorter trace that still violates
   the same property. Repeat until no single-action removal reproduces. Do
   at least two confirmation re-runs of the minimized trace — a violation
   that does not reproduce is flakiness, not a bug.
5. **Report** with evidence: the minimized action sequence, the property
   that broke, the extractor values at the failing state, and the
   reproduction command. A clean run with N explored states and no
   violations is also a result — say so.

## Rules

- Properties state invariants, not test steps — never encode a scripted
  scenario as an `always`.
- Every reported violation carries the trace that reproduces it; a violation
  without a reproducible trace is flakiness — rerun twice before reporting.
- The explorer never edits product code; findings are reported, not fixed.
- A spec exports only properties and action generators — helpers live in
  imported modules.
- Respect `data:` seeds: the same seed must explore the same sequence, or
  the run is not reproducible and the evidence is void.
