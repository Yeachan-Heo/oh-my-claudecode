---
name: brand-steward
description: Slash-wrapper for the brand-steward agent — runs strategic foundation interview (mission, target user, anti-goals, scope boundaries, tone-of-voice hints) producing/refining .omc/constitution.md. Reads competitors data if present to inform anti-goals
argument-hint: "[--session1 | --session2 | --refine]"
level: 4
---

# Brand Steward Skill

Thin wrapper that invokes the `brand-steward` agent as a slash command. brand-steward is the strategic foundation counterpart to brand-architect: brand-steward owns mission/anti-goals/scope (strategic), brand-architect owns archetype/metaphor/grammar (expressive). Both write in stages; both can read competitor and research data when available.

## Usage

```
/oh-my-claudecode:brand-steward                      # auto-detect session
/brand-steward --session1                            # first pass (draft constitution)
/brand-steward --session2                            # refinement pass (after accumulated data)
/brand-steward --refine                              # open-ended refinement
```

### Examples

```
/brand-steward                                        # first run → session 1 interview
/brand-steward --session2                            # after 2 weeks of scout + ideate + partner data
```

<Purpose>
Invokes `brand-steward` agent to conduct the strategic discovery interview. Handles session state (first pass vs refinement) and ensures competitor and research context is read when available so anti-goals can be formulated oppositionally.
</Purpose>

<Use_When>
- First day of product — need constitution foundation.
- After 10–14 days of scout + ideate + partner data — refine anti-goals with accumulated evidence.
- Material market shift (new competitor, regulatory change) that may invalidate prior anti-goals.
- Product strategy pivot.
</Use_When>

<Do_Not_Use_When>
- You need archetype/visual system — use `/brand-architect` (different concern).
- You need specific copy polish — use copywriter agent directly.
- Single feature evaluation — use `/product-strategist`.
</Do_Not_Use_When>

<Protocol>

## Phase 0 — Session Detection

1. Read `.omc/constitution.md` if exists — note status (draft / partial / complete / absent).
2. Read `.omc/competitors/` — note landscape availability.
3. Read `.omc/research/` — note accumulated user evidence.

Decide session type:
- Absent constitution OR `--session1` → session 1 (mission, values, anti-goals from internal conviction + available competitor landscape).
- `status: partial` AND sufficient downstream data (competitors ≥3, research ≥1) OR `--session2` → session 2 (lock anti-goals, refine scope).
- `--refine` — open-ended.

## Phase 1 — Context Surface

Read and summarize to user:
- Current constitution status.
- Competitor archetypes if `.omc/brand/core.md` exists (useful for anti-goal formulation).
- Top 3 user pain points from `.omc/research/` if present.
- Recent ideate shortlists if present (reveals where anti-goals are actively tested).

## Phase 2 — Invoke Agent

Invoke `oh-my-claudecode:brand-steward` agent with directive:
- Session mode: 1 | 2 | refine.
- Context reads: constitution, competitors (especially landscape/*.md), research.
- Focus for session 1: mission, principles, target user, INITIAL anti-goals (tagged tentative).
- Focus for session 2: LOCK anti-goals citing specific competitor moves, refine scope, calibrate tone hints.
- Output: `.omc/constitution.md` with explicit `status: draft | partial | complete` header.

## Phase 3 — Post-Invocation Summary

Report:
- Session produced constitution at `status: X`.
- Key anti-goals (top 3) with their competitor/evidence citation.
- Gaps remaining → recommended next steps.
- If session 1 → recommend running `/brand-architect` next, then scheduling session 2 in 10–14 days.

</Protocol>

<Input_Contract>
Optional flags:
- `--session1` — force first-pass interview
- `--session2` — force refinement pass (requires `.omc/competitors/` and `.omc/research/`)
- `--refine` — open-ended refinement

No positional args — agent reads context.
</Input_Contract>

<Output>
- `.omc/constitution.md` — updated with new session data, status field advanced if appropriate.
- `.omc/brand/steward-sessions/YYYY-MM-DD-<session-id>.md` — session record.
</Output>

<Failure_Modes_To_Avoid>
- Running session 2 without competitor or research context — defeats the purpose of refinement.
- Locking anti-goals in session 1 when they should be tentative.
- Silently overwriting constitution (must advance status explicitly).
</Failure_Modes_To_Avoid>

<Integration_Notes>
- Delegates to `oh-my-claudecode:brand-steward` agent.
- Recommended sequence: `/competitor-scout --new-only` → `/brand-steward --session1` → `/brand-architect` → (2 weeks of product work) → `/brand-steward --session2`.
- Related: `/brand-architect` (expressive counterpart), `/product-strategist` (per-feature gate using anti-goals this produces).
</Integration_Notes>
