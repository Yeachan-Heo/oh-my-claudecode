# Shipyard — Governed Delivery & Shared Harness

Shipyard is the delivery methodology behind four opt-in skills: `drydock`, `ask-navigator`, `launch`, and `minimal-code-discipline`. Its premise in one line:

> **Everyone ships, and nobody ships randomly** — agents continuously run everything repeatable and acceptable-by-evidence; humans decide what cannot be judged by the system or what fails expensively.

This page is the map of the methodology: the boundary principle, the roles, the four pillars, the surface layout, the working metaphor, and how the five skills compose. The skills themselves (`/oh-my-claudecode:drydock`, `/oh-my-claudecode:ask-navigator`, `/oh-my-claudecode:loft`, `/oh-my-claudecode:launch`, `/oh-my-claudecode:minimal-code-discipline`) are the executable form.

## The verifiability boundary

Every step in a launch run answers one test question: *if this is done wrong, can the system detect it? Can it redo or roll back automatically?*

- **Both yes → agents run it continuously** (the repeatable ~80%): fact-finding, spec/ticket drafting, lofting design questions, tdd implementation, builds, tests, code-review, verify, scheduling.
- **Either no → the human decides it** (the critical ~20%): acceptance criteria, seam selection, ticket granularity, irreversible architecture decisions, final acceptance.

It is not "let agents do as much as possible" — it is "delegate exactly what can be accepted, nothing more."

## The roles

Roles divide by decision authority, not by species:

| Role | Who | Signature moments |
| --- | --- | --- |
| The captain | the human | W1 destination, W2 chart, C1–C5 — seven signatures per effort; everything else is delegated |
| The navigator | the agent drafts, the captain confirms | `ask-navigator` on an ocean passage; launch's Phase 1 frontier interview is the same navigator on inland waters |
| The harbormaster | the agent inspects, the captain rules | `harbor` at the intake: verify every claim, present the docket; the captain signs accept / reject / merge |
| The crew | every builder, human or agent | starting needs no permission; landing goes into a shipyard slot |
| The classification society | the standards, surveyed | `docs/standards/` + `design-system/`, checked by the yard gate, code-review, and verify |

The captain is always human because fog-of-war decisions cannot be verified in advance — there is no spec yet to detect against. Agents hold every other role because drafting, building, and inspecting are evidence-checkable.

The premise sentence is the role model compressed: **everyone ships** is the admission rule (humans and agents are both crew); **nobody ships randomly** is the discipline (every landing passes a slot and a class check). Fog is the third case: without a navigator, a foggy effort either stops shipping or ships randomly — the navigator is how it obeys both halves: chart first, build later.

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
| The fog | An effort whose destination isn't stateable yet | Nobody ships randomly — and nobody ships into fog without a chart |
| The navigator | `/oh-my-claudecode:ask-navigator` | Charts the fog as a map of decision tickets; hands off, never builds |
| The loft | `/oh-my-claudecode:loft` | Cut no steel until the shape is fair: a throwaway artifact answers a design question before real work begins |
| The harbor | `/oh-my-claudecode:harbor` | The port's gate: external requests inspected, dispositioned, and turned into work orders — never merges, never decides |
| The classification society | `docs/standards/` + `design-system/` | A ship must pass class to sail = changes must pass standards to merge |
| The charts | specs + tickets | Launch's output; build from the chart |
| The logbook | `docs/adr/` | Decisions, auditable after the fact |
| The launch | `/oh-my-claudecode:launch` | Everyone may launch — and not one class check may be skipped |

## The six skills compose

- **`drydock`** lays the keel once per repo (surfaces + seeds + `--check` drift audit). The `--check` report states per-finding confidence and whether the finding is actionable after excluding a user-declared scratch/throwaway scope; today it has no executable or machine-readable severity contract (planned follow-up).
- **`ask-navigator`** charts foggy efforts (destination unclear → a map of decision tickets on the tracker, worked one ticket per session) and hands the collapsed decisions to launch as a mission brief. Resolutions sediment into the same paper-trail slots launch's Phase 1 uses. It produces decisions, never deliverables.
- **`loft`** answers a design question that prose cannot settle with a throwaway artifact — a pure logic module in a clickable shell, or structurally different UI variants behind one route. The captain reacts; the answer lands in the decision; the artifact never docks. Called by launch's Phase 1 detour and the navigator's `loft` tickets.
- **`harbor`** is the intake gate for external work: sweeps incoming issues and PRs, verifies every claim (reproduce, check out, run), routes fog to the navigator, and hands the maintainer a short docket whose only remaining work is signing. Facts are harbor's to gather autonomously; dispositions and merges are the captain's to sign. The recurring-request clusters in its sweep summary are the feedback loop's outer ear — demand signals from the world, sedimenting into `docs/business/` or promoting into ideas.
- **`launch`** runs delivery per feature (fog gate → yard gate → C1 brief → C2 spec+seams → C3 tickets → frontier execution with C4 decision stops → C5 closeout with a `--check` re-audit), with the human at exactly the checkpoints that fail expensively. The fog gate routes an effort whose destination cannot be stated to the navigator before the run starts. The yard gate blocks on high-confidence actionable drydock findings (listing them verbatim and producing no artifacts) and admits only a clean audit or a narrowly, explicitly overridden low-confidence / false-positive / scratch-scope finding — no general bypass.
- **`minimal-code-discipline`** is an opt-in discipline for code written inside tickets (YAGNI ladder, smallest correct diff).

The gates form one chain with the same anatomy — run checks, list findings verbatim, sign only what fails expensively: **harbor gate** (take this external request?) → **fog gate** (can the destination be stated?) → **yard gate** (are the surfaces laid and clean?) → C1–C5 (quality signatures).

They share one rule of thumb: **starting needs no permission; landing goes into a shipyard slot.** A change that cannot say which slot it lands in (or explicitly none) is the smell.

## The feedback loop

Shipyard corrects itself through its file-backed paper trail: navigator resolutions sediment into `CONTEXT.md`, `docs/adr/`, and `docs/business/` as decisions settle; launch closeout reconciles the spec, `CONTEXT.md`, and ADRs, while recurring corrections can sediment into `CLAUDE.md` and `docs/standards/` through the launch C5 sediment pass and reviews; and harbor's sweep summary surfaces recurring request clusters from outside — the loop's outer ear, turning what the world keeps asking for into `docs/business/` knowledge or fresh ideas. `/oh-my-claudecode:drydock --check` audits harness drift. These skills do not add a separate findings store, shipped/wontfixed state machine, hidden ledger, or `sy check`/`context-lint` commands.

## When to reach for what

- one-point fix → `execute` directly (no shipyard ceremony)
- multi-step feature → `launch`
- foggy effort (destination unclear, questions not yet stateable) → `ask-navigator` first; it hands back a mission brief
- external requests piling up (issues, bug reports, PRs) → `harbor` sweeps the intake and hands over a signature queue
- new repo, or a repo where knowledge lives in heads → `drydock` first
- writing-time code discipline inside any of the above → `minimal-code-discipline`

Shipyard adds no daemon, no mode, no always-on behavior: the surfaces are ordinary repository files, the skills are plain instructions, and the canonical `plan → execute → review → verify` spine remains the default path. Shipyard is opt-in at every door.
