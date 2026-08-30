# Shipyard — Governed Delivery & Shared Harness

Shipyard is the delivery methodology behind three opt-in skills: `drydock`, `launch`, and `minimal-code-discipline`. Its premise in one line:

> **Everyone ships, and nobody ships randomly** — agents continuously run everything repeatable and acceptable-by-evidence; humans decide what cannot be judged by the system or what fails expensively.

This page is the map of the methodology: the boundary principle, the four pillars, the surface layout, the working metaphor, and how the three skills compose. The skills themselves (`/oh-my-claudecode:drydock`, `/oh-my-claudecode:launch`, `/oh-my-claudecode:minimal-code-discipline`) are the executable form.

## The verifiability boundary

Every step in a launch run answers one test question: *if this is done wrong, can the system detect it? Can it redo or roll back automatically?*

- **Both yes → agents run it continuously** (the repeatable ~80%): fact-finding, spec/ticket drafting, tdd implementation, builds, tests, code-review, verify, scheduling.
- **Either no → the human decides it** (the critical ~20%): acceptance criteria, seam selection, ticket granularity, irreversible architecture decisions, final acceptance.

It is not "let agents do as much as possible" — it is "delegate exactly what can be accepted, nothing more."

## The four pillars → five surfaces

A repo that humans and agents both build on carries four pillars across five conceptual surfaces, represented by the concrete paths below. `/oh-my-claudecode:drydock` lays them; every later session inherits them by reading.

| Surface | Carries | Filled by |
| --- | --- | --- |
| `CLAUDE.md` | Thin entry: project conventions / architecture principles / standards index / load-bearing decision pointers | drydock seed; retro & reviews sediment |
| `CONTEXT.md` | Glossary (the slot agents write into the moment a term settles; vocabulary is law) | launch Phase 1; domain-modeling |
| `docs/adr/` | Decision records in full (the logbook) | launch convergence and C4 follow-up; domain-modeling |
| `docs/standards/` | architecture.md / data.md / process.md | retro & code-review sediment |
| `docs/business/` | Business knowledge (one article answers one business question) | launch Phase 1 |
| `design-system/` | tokens/ + components/ + patterns/ | frontend review sediment |
| `.omc/skills/` | Project skills: reusable capabilities / specialized tools / prompt templates / specialized practices | anyone (skillify quality gate) |
| `.mcp.json` + `scripts/` | MCP servers + CLI toolchain / automation scripts | PR |

## The metaphor family (for teaching the system)

| Metaphor | Maps to | In one line |
| --- | --- | --- |
| The shipyard | The whole harness | A shared facility; everyone comes here to build |
| The keel | `CLAUDE.md` + `CONTEXT.md` | Lay the skeleton first; the hull grows upward |
| The classification society | `docs/standards/` + `design-system/` | A ship must pass class to sail = changes must pass standards to merge |
| The charts | specs + tickets | Launch's output; build from the chart |
| The logbook | `docs/adr/` | Decisions, auditable after the fact |
| The launch | `/oh-my-claudecode:launch` | Everyone may launch — and not one class check may be skipped |

## The three skills compose

- **`drydock`** lays the keel once per repo (surfaces + seeds + `--check` drift audit).
- **`launch`** runs delivery per feature (C1 brief → C2 spec+seams → C3 tickets → frontier execution with C4 decision stops → C5 closeout), with the human at exactly the checkpoints that fail expensively.
- **`minimal-code-discipline`** is an opt-in discipline for code written inside tickets (YAGNI ladder, smallest correct diff).

They share one rule of thumb: **starting needs no permission; landing goes into a shipyard slot.** A change that cannot say which slot it lands in (or explicitly none) is the smell.

## The feedback loop

Shipyard corrects itself through its plain-file paper trail: launch closeout reconciles the spec, `CONTEXT.md`, ADRs, and business docs, while recurring corrections can sediment into `CLAUDE.md` and `docs/standards/` through retros and reviews. `/oh-my-claudecode:drydock --check` audits harness drift. These skills do not add a separate findings store, shipped/wontfixed state machine, hidden ledger, or `sy check`/`context-lint` commands.

## When to reach for what

- one-point fix → `execute` directly (no shipyard ceremony)
- multi-step feature → `launch`
- new repo, or a repo where knowledge lives in heads → `drydock` first
- writing-time code discipline inside any of the above → `minimal-code-discipline`

Shipyard adds no daemon, no mode, no always-on behavior: the surfaces are plain markdown, the skills are plain instructions, and the canonical `plan → execute → review → verify` spine remains the default path. Shipyard is opt-in at every door.
