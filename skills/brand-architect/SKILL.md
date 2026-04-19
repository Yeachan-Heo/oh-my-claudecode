---
name: brand-architect
description: Slash-wrapper for the brand-architect agent — runs brand system discovery (Jungian archetype, core metaphor, variation grammar) producing .omc/brand/core.md + grammar.md. Self-sufficient: runs discovery even without prior constitution, optionally triggering competitor-scout first
argument-hint: "[--refine | --discovery | --after-scout]"
level: 4
---

# Brand Architect Skill

Thin wrapper that invokes the `brand-architect` agent through a slash command. Handles prerequisite detection (missing constitution or competitors data) and sequences a quick competitor-scout sweep before discovery when no competitive context exists.

## Usage

```
/oh-my-claudecode:brand-architect                    # auto-detect mode
/brand-architect --discovery                          # force full discovery (greenfield)
/brand-architect --refine                             # refine existing brand/core + grammar
/brand-architect --after-scout                        # assume competitors data fresh; skip scout prerequisite check
```

### Examples

```
/brand-architect                                      # smart default: checks prereqs, runs appropriate mode
/brand-architect --discovery                          # explicit greenfield — will propose scout first if no competitors
/brand-architect --refine                             # iterate on existing brand system after accumulated data
```

<Purpose>
Invokes the `brand-architect` agent to design the brand SYSTEM (core + grammar). Handles pre-flight checks:
1. If no `.omc/competitors/` data exists and mode is discovery, prompts user to run competitor-scout first (archetype selection without competitive whitespace analysis is LOW-confidence).
2. If no `.omc/constitution.md`, warns that strategic foundation is absent; brand-architect will produce brand-only output and flag partial status.
3. If `.omc/brand/core.md` already exists, auto-detects refine mode unless overridden.
</Purpose>

<Use_When>
- Starting a new product and need the brand system defined.
- Brand expressions feel incoherent or drift-prone and grammar needs rethinking.
- Launching into a new segment/market where archetype may need secondary axis.
- After competitor-scout surfaced a new dominant player whose archetype forces positioning review.
</Use_When>

<Do_Not_Use_When>
- Mission and anti-goals are unclear — run brand-steward first.
- Need a specific marketing expression, not the system — use brand-variations-generate.
- Single-variation polish — use copywriter or designer directly.
</Do_Not_Use_When>

<Protocol>

## Phase 0 — Prerequisite Detection

1. Read `.omc/constitution.md` — note status (complete / partial / draft / absent).
2. Glob `.omc/competitors/` — count dossiers.
3. Check `.omc/brand/core.md` and `.omc/brand/grammar.md` — note existence.

Decide mode:
- `--refine` flag OR (core exists AND grammar exists AND no flag) → refinement mode.
- `--discovery` flag OR no prior brand artifacts → discovery mode.
- `--after-scout` bypasses the scout-prerequisite check.

## Phase 1 — Prerequisite Satisfaction

If discovery mode AND `.omc/competitors/` has <3 dossiers AND not `--after-scout`:
- Recommend: "Brand archetype selection needs competitive whitespace analysis. Run `/oh-my-claudecode:competitor-scout '<niche>'` first, then retry. Or pass `--after-scout` to proceed with LOW-confidence archetype."
- STOP unless user explicitly overrides.

If discovery mode AND constitution absent:
- Warn: "No constitution.md — brand-architect will produce brand-only output and flag partial status. Strategic foundation (brand-steward) recommended as follow-up."
- Proceed.

## Phase 2 — Invoke Agent

Invoke `oh-my-claudecode:brand-architect` agent with directive:
- Mode: discovery | refinement (detected).
- Read `.omc/constitution.md`, `.omc/competitors/**`, `.omc/research/**` (optional), `.omc/brand/**` (refinement).
- Produce `.omc/brand/core.md` + `.omc/brand/grammar.md` per agent's Investigation_Protocol.
- Write session record to `.omc/brand/discovery/YYYY-MM-DD-<slug>.md`.

## Phase 3 — Post-Invocation Summary

Report to user:
- Primary archetype chosen + rejected archetypes + rationale.
- Core metaphor.
- Grammar summary (N invariants, M variables, K combination-rules).
- Confidence summary (HIGH/MEDIUM/LOW dimensions from agent output).
- Next actions: `/brand-variations-generate` to produce campaigns from this grammar; `brand-steward` if constitution gaps remain; `competitor-scout --refresh` in 14d to catch archetype shifts.

</Protocol>

<Input_Contract>
Optional flags:
- `--refine` — force refinement mode
- `--discovery` — force discovery mode
- `--after-scout` — skip scout prerequisite check

No positional args — agent reads context from `.omc/`.
</Input_Contract>

<Output>
Primary artifacts:
- `.omc/brand/core.md` (archetype, metaphor, voice ladder, narrative invariants)
- `.omc/brand/grammar.md` (invariants, variables, combination-rules)
- `.omc/brand/discovery/YYYY-MM-DD-<slug>.md` (session record)

Prior versions moved to `.omc/brand/archive/` in refinement mode.
</Output>

<Failure_Modes_To_Avoid>
- Running discovery without competitor data and not flagging LOW-confidence archetype.
- Skipping the refinement-mode detection when prior brand artifacts exist (would silently overwrite).
- Proceeding without warning when constitution is absent.
- Bypassing the archive step on refinement (losing history).
</Failure_Modes_To_Avoid>

<Integration_Notes>
- Delegates to `oh-my-claudecode:brand-architect` agent.
- Prerequisite for: `/oh-my-claudecode:brand-variations-generate` (needs brand/core + grammar).
- Composes with: `/oh-my-claudecode:competitor-scout` (recommended before first discovery); `brand-steward` agent (complementary — strategic foundation).
- Handoff after: campaign-composer (generate expressions from grammar) + creative-director (enforce).
</Integration_Notes>
