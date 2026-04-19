---
name: brand-steward
description: Slash-wrapper for the brand-steward agent — invokes strategic discovery interview for mission, target user, anti-goals, scope boundaries, tone hints. Conversational mode (one question per turn, no pre-menus, no numbered blocks). Minimal wrapper — delegates to agent immediately
argument-hint: "[--session1 | --session2 | --refine]"
level: 4
---

# Brand Steward Skill

Minimal slash-wrapper for the `brand-steward` agent. The wrapper does NO narration of context, NO pre-menus, NO teammate/SendMessage relay. It reads session state silently and hands off to the agent via a direct Task invocation with a session-mode directive. All interaction is between the user and the agent directly — in a conversational loop, one question per turn.

## Usage

```
/oh-my-claudecode:brand-steward                      # auto-detect session
/brand-steward --session1                            # first pass
/brand-steward --session2                            # refinement pass
/brand-steward --refine                              # open-ended refinement
```

<Purpose>
Single command that invokes `brand-steward` agent to conduct conversational brand discovery. Wrapper is intentionally thin: it detects the session mode and invokes the agent — no pre-amble, no context narration, no menus. The agent owns the dialogue start-to-finish.
</Purpose>

<Use_When>
- First day of product — need constitution foundation.
- After 10–14 days of scout + ideate + partner data — refine anti-goals with accumulated evidence.
- Material market shift (new competitor, regulatory change) that may invalidate anti-goals.
- Product strategy pivot.
</Use_When>

<Do_Not_Use_When>
- You need archetype / visual system / grammar — use `/brand-architect` (different concern).
- You need specific copy polish — use copywriter agent directly.
- Single-feature evaluation — use `/product-strategist`.
</Do_Not_Use_When>

<Protocol>

## Phase 0 — Silent Session Detection

Read silently (no output to user):
1. `.omc/constitution.md` if exists — note `status` field.
2. Presence of `.omc/competitors/` and count of dossiers.
3. Presence of `.omc/research/` and count of synthesis artifacts.

Determine session mode:
- `--session1` flag OR constitution absent OR `status: draft` with no fills → session 1.
- `--session2` flag OR (`status: partial` AND competitors≥3 AND research≥1) → session 2.
- `--refine` → open-ended refinement.

Prerequisites check: Phase 0 does NOT gate on absent context. If competitors are missing for session 2, brand-steward itself will ask the user whether to proceed or run competitor-scout first. The wrapper does not over-validate.

## Phase 1 — Direct Invocation

Invoke `oh-my-claudecode:brand-steward` agent via Task tool (NOT as a teammate, NOT via SendMessage, NOT via TeamCreate). The agent runs in a direct conversational channel with the user.

Invocation directive:
- Session mode: 1 | 2 | refine.
- Available context paths (agent reads them directly in its Phase A): constitution, competitors, research, brand.
- Enforcement: conversational discipline per agent Investigation_Protocol (≤80 words first message, one question per turn, no pre-menus, no numbered blocks).

The wrapper produces NO user-facing output between invocation and agent's first message. Do not announce context, do not narrate setup, do not pre-menu language choices — the agent handles all of this in dialogue.

## Phase 2 — Post-Completion (optional)

After the agent completes (constitution written + terminal message delivered), the wrapper itself produces NO additional output. The agent's terminal message is the summary.

If the user needs a reminder of next steps, they can ask; the wrapper does not proactively narrate.

</Protocol>

<Input_Contract>
Optional flags:
- `--session1` — force first-pass interview
- `--session2` — force refinement pass
- `--refine` — open-ended refinement

No positional args. The agent reads context from `.omc/` in its own Phase A.
</Input_Contract>

<Output>
- `.omc/constitution.md` — updated by agent; `status` field advanced when evidence supports promotion.
- Agent's in-conversation synthesis message (no wrapper-generated summary).
</Output>

<Failure_Modes_To_Avoid>
- **Narrating Phase 0 context ingestion to the user.** "I've read your competitors and research — here's what I found" is exactly the pre-amble that buries the agent's first question. Silent reads only.
- **Pre-menu for language choice.** Language preference is a dialogue question the agent asks when relevant, not a wrapper-side selection.
- **Invoking brand-steward as a teammate (TeamCreate + SendMessage relay).** That creates a proxy-UX where the user talks to a middleman. Use direct Task invocation only.
- **Announcing session mode to the user.** Session detection is internal. The agent knows the mode from the directive.
- **Adding post-completion summary.** The agent's terminal message is the summary. Anything from the wrapper on top is noise.
- **Validating prerequisites too aggressively.** Session 2 without competitors is fine — the agent will flag it in conversation, not fail at wrapper level.
</Failure_Modes_To_Avoid>

<Integration_Notes>
- Delegates to `oh-my-claudecode:brand-steward` agent via direct Task invocation.
- Recommended sequence: `/competitor-scout --new-only` → `/brand-steward --session1` → `/brand-architect` → (2 weeks of product work) → `/brand-steward --session2`.
- Related: `/brand-architect` (expressive counterpart — archetype + grammar), `/product-strategist` (per-feature gate using anti-goals this produces).
- The conversational discipline is enforced in the AGENT prompt, not in this wrapper. Wrapper stays minimal so future changes to conversation shape happen in one place.
</Integration_Notes>
