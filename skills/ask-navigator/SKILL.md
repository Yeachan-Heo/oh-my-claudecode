---
name: ask-navigator
description: Shipyard's navigator — chart a foggy effort (destination unclear, questions not yet stateable) into a map of decision tickets on the repo's issue tracker, then work the frontier one ticket per session until the way is clear, and hand the collapsed decisions to /launch as a mission brief. Wayfinding, not building: it produces decisions, never deliverables.
argument-hint: "<loose idea | residual questions | map link or number | nothing to continue the open map>"
level: 3
pipeline: [deep-interview, ask-navigator]
---

# Ask Navigator

Ask-navigator is the shipyard's **navigator**: it takes an effort wrapped in fog — the way from here to the destination isn't visible yet — and charts it as a **map of decision tickets** on the repo's issue tracker, then works the frontier one ticket per session until the route is clear. It produces **decisions, never deliverables**: when the way is clear it hands off, it doesn't build. Delivery belongs to `/oh-my-claudecode:launch`.

**The role contract.** The captain (the human) signs the destination (W1) and the chart (W2); the navigator drafts everything else and **never answers a question that belongs to the captain** — a grilling session in which the agent answers its own questions has broken the role, not just the process. Facts are the navigator's job; decisions are the captain's.

**Fog test.** An effort has fog when either answer is no:

1. **Q1** — Can the destination be stated in one sentence: the spec, decision, or change this effort is finding its way to?
2. **Q2** — Can the first three decisions be stated precisely right now, even though none of them can be answered yet?

Both yes → no map is needed; run `/oh-my-claudecode:launch` (its fog gate sends efforts here only when an answer is no). Either no → chart first. `ask-navigator` is also reachable directly: invoke it with a loose idea, with residual questions handed over by launch's fog gate, or with no argument to continue the open map.

## Map home

The map is a **single issue** labelled `navigator:map` on the repo's issue tracker; its decision tickets are child issues of the map. The tracker should have been recorded by `/oh-my-claudecode:drydock`; if none was recorded, ask once (GitHub / GitLab / local markdown) and remember the answer inside the map's Notes.

- **Tracker-backed (GitHub, GitLab, or recorded tracker)**: one map issue, child issues per ticket, native blocking/sub-issue relationships. Concurrent sessions and the tracker's own UI render the frontier — the map lives where humans already look. Create the `navigator:map` label if the tracker doesn't have it yet; ticket types live in the ticket body, not in labels.
- **Local markdown fallback**: `.omc/wayfinder/<map-slug>/map.md` plus `decisions/NN-<slug>.md`, one file per ticket, numbered in dependency order. Local mode has no concurrent-claim guarantee: it is single-driver by convention, stated once in the map's Notes.

The map is an **index, not a store**: a decision lives in exactly one place — its ticket. The map gists each resolution in one line and links; it never restates the detail.

## Document language

Map and ticket prose follow the same document-language contract as `/oh-my-claudecode:drydock`: read `documentLanguage` from `CONTEXT.md` frontmatter when present; if the yard is not laid, ask the language question once during charting (W2) and record the resolved tag in the map's Notes so the later launch run inherits it. Paths, labels, slash commands, the `navigator:map` label, ticket-type names (`research`, `loft`, `grilling`, `task`), `HITL`/`AFK`, and `blockedBy` are stable tokens and stay byte-for-byte stable in every language.

## Chart the map

Invoked with a loose idea (or launch's residual questions). Charting is one session's work; it hand-resolves nothing.

1. **Run the audit, defer the findings.** Run the `/oh-my-claudecode:drydock` `--check` audit in report-only mode: findings never block charting (a map produces decisions, not slot landings), but they are recorded verbatim in the map's Notes — launch's yard gate will collect that debt when the effort finally enters delivery. If the yard is not laid at all (no `CONTEXT.md`, no `docs/adr/`), offer `/oh-my-claudecode:drydock` **once**; if the captain declines, proceed in tracker-only mode and defer all sediment (see Sediment).
2. **W1 — name the destination.** Call the Skill tool with "deep-interview" and pin down what this map is finding its way to: the spec, decision, or change. The destination fixes the scope, so it is settled first. **W1 is a captain signature: present the destination statement and get explicit confirmation.** If the captain cannot state a destination even with the interview's help, that is not an error — present the best candidates ranked and let the captain pick one to chart toward or park the effort.
3. **Map the frontier.** Grill again with "deep-interview", **breadth-first**: fan out across the whole space rather than deep on any one thread, surfacing the open decisions and the first steps takeable now. **If this surfaces no fog** — the way to the destination is already clear and the journey fits one session — no map is needed: stop and recommend `/oh-my-claudecode:launch`.
4. **W2 — sign the chart.** Present the proposed map: destination, initial tickets with types and blocking edges, and the fog sketch. **W2 is a captain signature**: granularity wrong here wastes every later session. Iterate until signed.
5. **Create the map and tickets.** Label the map `navigator:map`; create child tickets; wire blocking edges in a second pass (issues need ids before they can reference each other). Everything not yet sharp enough to ticket stays in **Not yet specified**.
6. **Fire the research subagents.** For each `research` ticket just created, spawn a background subagent to resolve it in parallel (see Ticket types), capturing findings where the ticket can link them.
7. **Stop** with the session-close pointer: the map link, how many tickets are on the frontier, and "next session, run `/oh-my-claudecode:ask-navigator` to work the next decision."

## Work through the map

Invoked with a map (link or number) or with no argument (pick up the open map). A ticket is optional: without one, take the next frontier ticket, not one the captain must choose.

1. **Load the map**: the low-res view, never every ticket body. Zoom into a ticket's full body on demand.
2. **Claim before work**: assign the ticket to the captain (tracker) or set `Claimed-by` (local) **first**, so concurrent sessions skip it. An open, unclaimed ticket is unclaimed. If assignment isn't possible (permissions, no handle), record the claim in a ticket comment instead.
3. **Resolve it** according to its type (see Ticket types). Zoom as needed; call the Skill tool with "deep-interview" whenever the resolution needs the captain's input.
4. **Record the resolution**: post the answer as a resolution comment/section, close the ticket (as completed; a ticket ruled beyond the destination closes as not planned), and append one line to the map's **Decisions so far** — `[<ticket title>](link): <one-line gist>`.
5. **Advance the frontier**: graduate any fog the answer has made specifiable (remove it from **Not yet specified**, create the new tickets, wire edges); if the answer reveals a ticket sits beyond the destination, **close it** and leave one line in **Out of scope**; update or delete tickets the decision invalidated.
6. **Sediment** (see Sediment).
7. **Stop after one ticket.** One resolution per session is the cadence — it is the context-window budget, not a policy. The session-close pointer names what just resolved and what is now on the frontier.

## Ticket types

Every ticket is **HITL** (worked with the captain, who speaks for themselves) or **AFK** (driven by the navigator alone). A HITL ticket only resolves through live exchange; the agent never stands in for the captain's side.

| Type | Mode | Resolved by | Use when |
|---|---|---|---|
| `research` | AFK | Background subagent: investigate against primary sources (official docs, source code, specs), leave a cited Markdown file at `docs/research/<ticket-slug>.md` (or the repo's existing notes convention when one exists), link it from the ticket | A decision waits on knowledge outside the current working directory |
| `loft` | HITL | Call the Skill tool with "loft": a throwaway artifact answers the ticket's question — a pure logic module in a clickable shell, or structurally different UI variants behind one route; the captain reacts, the answer folds into the resolution, the artifact stays on a `loft/<name>` branch | The question is precise but prose cannot settle it — it needs to be seen or clicked, not described |
| `grilling` | HITL | Call the Skill tool with "deep-interview"; the captain decides each round | Conversation is the resolution — the default case |
| `task` | HITL or AFK | The navigator drives it alone where it can; otherwise hands the captain a precise checklist | Manual work that unblocks a decision (sign up for a service, provision access, move data so its shape can be seen) — it earns its place by unblocking a decision, not by delivering the destination |

The answer is never part of the ticket body; it is recorded on resolution. Assets created while resolving are linked from the ticket, not pasted in.

## Map body

```markdown
## Destination

<what reaching the end of this map looks like: the spec, decision, or change this effort is finding its way to. One or two lines; every session orients to it before choosing a ticket.>

## Notes

<domain; skills every session should consult; standing preferences; deferred drydock --check findings (verbatim); resolved documentLanguage tag; tracker-mode caveats for local mode>

## Decisions so far

<!-- the index: one line per closed ticket, enough to judge relevance, then zoom the link for the detail the ticket holds -->

- [<closed ticket title>](link): <one-line gist of the answer>

## Not yet specified

<!-- in-scope fog you cannot ticket yet; graduates as the frontier advances -->

## Out of scope

<!-- work ruled beyond the destination; closed, never graduates -->
```

**Fog or ticket?** The test is whether you can state the question precisely now, not whether you can answer it now. Ticket when the question is already sharp, even if it is blocked. Not-yet-specified when you cannot phrase it that sharply — do not pre-slice the fog into ticket-sized pieces; one patch may graduate into several tickets, or none. **Out of scope** is a scoping act, not a step on the route: scope, not sharpness, lands work there, and it returns only if the destination is redrawn.

## Sediment

Resolutions land in the shipyard's paper trail the moment they settle — the same slots launch's Phase 1 uses:

- a term the resolutions settled or sharpened → `CONTEXT.md` glossary (one entry: definition, boundary, resolved ambiguity)
- a decision passing the ADR test (hard to reverse, surprising without context, a real tradeoff) → `docs/adr/NNNN-<slug>.md`
- a business rule or background fact → `docs/business/` (one article per business question)

When the yard is not laid (the captain declined drydock at charting time), **defer, don't skip**: record each pending landing as one line in the map's Notes under a `Deferred sediment` heading. The later `/oh-my-claudecode:launch` run's yard gate treats the un-laid surfaces as findings, and the deferred lines tell it exactly what to land first.

## Exit — hand off, don't build

The map is done when no open tickets remain and **Not yet specified** is empty. Then:

1. Collapse **Decisions so far** into a **mission brief**: objective, scope boundary, non-goals — writable now because the way is clear. Write it to `.omc/wayfinder/<map-slug>/brief.md` so the handoff passes a pointer, not content.
2. Recommend: "The way is clear. Run `/oh-my-claudecode:launch` with the brief at `.omc/wayfinder/<map-slug>/brief.md`." The map stays as the effort's logbook; launch's yard gate owns every check from there.
3. Default entry is launch Phase 1 (the paper trail is already half-full; its frontier clears fast). Only when the decisions already read like a spec may a spec be drafted and launch entered at Phase 2 with the spec path.

## Scope and non-goals

- No daemon, no mode, no always-on behavior, no runtime state machine: the map is ordinary tracker issues or repo files.
- Incoming requests that arrive as fog are the harbor's to route: a fuzzy issue handed over by `/oh-my-claudecode:harbor` charts like any loose idea, with the original thread as material.
- Never mutates Team lifecycle, task statuses, or runtime state; never publishes delivery tickets — vertical-slice build tickets belong to launch's C3, and the navigator must not pre-slice fog into them.
- Never executes a decision beyond recording it. The one exception is a `task` ticket, which does only what unblocks a decision.
- The map's Decisions-so-far is an index; a decision lives in exactly one place, its ticket.

## Completion definition

A charting session ends with a captain-signed map and fired research tickets. A working session ends with exactly one resolution recorded, the frontier advanced, and the session-close pointer emitted. The effort ends when the way is clear and the mission brief is in the captain's hands with `/oh-my-claudecode:launch` recommended — every decision the navigator made on the captain's behalf answerable with one pointer to where it was recorded.
