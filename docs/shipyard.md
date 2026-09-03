# Shipyard — Governed Delivery & Shared Harness

Shipyard is the delivery methodology behind three opt-in skills: `drydock`, `launch`, and `minimal-code-discipline`. Its premise in one line:

> **Everyone ships, and nobody ships randomly** — agents continuously run everything repeatable and acceptable-by-evidence; humans decide what cannot be judged by the system or what fails expensively.

This page is the map of the methodology: the boundary principle, the four pillars, the surface layout, the working metaphor, and how the three skills compose. The skills themselves (`/oh-my-claudecode:drydock`, `/oh-my-claudecode:launch`, `/oh-my-claudecode:minimal-code-discipline`) are the executable form. For the visual quick-start with emoji and mermaid diagrams, see [shipyard-guide.md](./shipyard-guide.md).

## The verifiability boundary

Every step in a launch run answers one test question: *if this is done wrong, can the system detect it? Can it redo or roll back automatically?*

- **Both yes → agents run it continuously** (the repeatable ~80%): fact-finding, spec/ticket drafting, tdd implementation, builds, tests, code-review, verify, scheduling.
- **Either no → the human decides it** (the critical ~20%): acceptance criteria, seam selection, ticket granularity, irreversible architecture decisions, final acceptance.

It is not "let agents do as much as possible" — it is "delegate exactly what can be accepted, nothing more."

## The four pillars → five surfaces

A repo that humans and agents both build on carries four pillars across five conceptual surfaces. `/oh-my-claudecode:drydock` lays them; every later session inherits them by reading.

| Conceptual surface | Concrete paths | Carries / filled by |
| --- | --- | --- |
| Shared context | `CONTEXT.md` + `docs/business/` + `docs/adr/` + OMC wiki | Glossary, business knowledge, and decision records; launch writes the file-backed paper trail and wiki compounds session knowledge |
| Rules | `CLAUDE.md` + `docs/standards/` | Thin conventions/principles/index plus architecture, data, and process standards; drydock seeds them and the launch C5 sediment pass/reviews sediment recurring corrections |
| Project skills | `.omc/skills/` | Reusable project capabilities and practices; contributors add them through the skillify quality gate |
| Design system | `design-system/` | Tokens, components, and patterns; drydock seeds it for UI repos and may create a stub or skip it for non-UI repos |
| MCP / CLI tools | `.mcp.json` + `scripts/` | MCP servers and repository automation; drydock seeds empty tool surfaces and integrations are added only when needed |

## The metaphor family (for teaching the system)

| Metaphor | Maps to | In one line |
| --- | --- | --- |
| The shipyard | The whole harness | A shared facility; everyone comes here to build |
| The keel | Shared context + rules surfaces | Lay the skeleton first; the hull grows upward |
| The classification society | `docs/standards/` + `design-system/` | A ship must pass class to sail = changes must pass standards to merge |
| The charts | specs + tickets | Launch's output; build from the chart |
| The logbook | `docs/adr/` | Decisions, auditable after the fact |
| The launch | `/oh-my-claudecode:launch` | Everyone may launch — and not one class check may be skipped |

## The three skills compose

- **`drydock`** lays the keel once per repo (surfaces + seeds + `--check` drift audit).
- **`launch`** runs delivery per feature (yard gate → C1 brief → C2 spec+seams → C3 tickets → frontier execution with C4 decision stops → C5 closeout with a `--check` re-audit), with the human at exactly the checkpoints that fail expensively. The yard gate refuses to start unless the full drydock `--check` audit is clean — a yard that fails inspection ships nothing.
- **`minimal-code-discipline`** is an opt-in discipline for code written inside tickets (YAGNI ladder, smallest correct diff).

They share one rule of thumb: **starting needs no permission; landing goes into a shipyard slot.** A change that cannot say which slot it lands in (or explicitly none) is the smell.

## The feedback loop

Shipyard corrects itself through its file-backed paper trail: launch closeout reconciles the spec, `CONTEXT.md`, and ADRs, while recurring corrections can sediment into `CLAUDE.md` and `docs/standards/` through the launch C5 sediment pass and reviews. `/oh-my-claudecode:drydock --check` audits harness drift. These skills do not add a separate findings store, shipped/wontfixed state machine, hidden ledger, or `sy check`/`context-lint` commands.

## When to reach for what

- one-point fix → `execute` directly (no shipyard ceremony)
- multi-step feature → `launch`
- new repo, or a repo where knowledge lives in heads → `drydock` first
- writing-time code discipline inside any of the above → `minimal-code-discipline`

Shipyard adds no daemon, no mode, no always-on behavior: the surfaces are ordinary repository files, the skills are plain instructions, and the canonical `plan → execute → review → verify` spine remains the default path. Shipyard is opt-in at every door.
