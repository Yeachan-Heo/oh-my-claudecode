---
name: design-partner-manager
description: Long-running design partner program manager — initialize program, recruit partners, onboard, run structured feedback cycles, synthesize findings via ux-researcher into .omc/research/, and graduate partners at launch
argument-hint: "--init | --recruit | --onboard | --session | --synthesize | --graduate | --status"
level: 4
---

# Design Partner Manager Skill

Manages the lifecycle of a pre-launch design partner program: program foundation, recruitment, onboarding, recurring feedback sessions, synthesis into research artifacts, and graduation at launch. Produces the structured qualitative signal that replaces production metrics when the product has no real users yet. Feeds `.omc/partners/` and, through synthesis, `.omc/research/`.

## Usage

Skill has multiple entry points controlled by flags. Each entry point is a self-contained protocol.

```
/oh-my-claudecode:design-partner-manager --init
/design-partner-manager --recruit "<criteria>"
/design-partner-manager --onboard <partner-id>
/design-partner-manager --session [<feature-slug>]
/design-partner-manager --synthesize [--since=YYYY-MM-DD]
/design-partner-manager --graduate <partner-id>
/design-partner-manager --status
```

### Entry points overview

| Flag | When | What it does |
|---|---|---|
| `--init` | Program does not exist (run once at start) | Establishes program goals, criteria, cadence, session formats; creates `.omc/partners/program.md` |
| `--recruit "<criteria>"` | Program exists; need more partners | Produces outreach materials, target list, tracking file |
| `--onboard <partner-id>` | Partner accepted | Produces onboarding kit (NDA template pointer, expectations, cadence, session-one agenda) |
| `--session [<feature-slug>]` | Recurring feedback cycle | Produces session agenda + structured note template per active partner; optional feature scope |
| `--synthesize [--since=<date>]` | After sessions accumulate | Invokes ux-researcher to convert session notes into cited research artifacts |
| `--graduate <partner-id>` | Near launch or partner exit | Exit survey, testimonial request, retention decision (user → advocate / alumni / inactive) |
| `--status` | Any time | Program health dashboard |

### Examples

```
/design-partner-manager --init
/design-partner-manager --recruit "B2B ops teams, 50-200 employees, current tool: spreadsheets, pain: manual reconciliation"
/design-partner-manager --onboard partner-acme-jane
/design-partner-manager --session matching-algorithm
/design-partner-manager --synthesize --since=2026-04-01
/design-partner-manager --graduate partner-acme-jane
/design-partner-manager --status
```

<Purpose>
Design partner programs produce the highest-leverage qualitative signal available pre-launch — but only when run with discipline. Ad-hoc partner programs drift into "friends who agree with us" and produce false validation. This skill encodes the discipline: selection criteria that guard against sycophancy, structured sessions that surface issues instead of praise, synthesis that converts notes into citable research, and graduation that ends the relationship cleanly instead of letting partners drift into passive users.
</Purpose>

<Use_When>
- Pre-launch product with core features in deepening sprints (pre-launch-sprint Week 3 depends on this).
- No real users yet; need qualitative signal to replace metrics.
- 5–20 handpicked design partners is the target range (never mass-market).
- User invokes `/design-partner-manager` with any entry-point flag.
</Use_When>

<Do_Not_Use_When>
- Product is already launched with real users — use ux-researcher directly on app feedback + session recordings.
- Beta program with 500+ users — that is a beta, not a design partner program; tooling and synthesis differ.
- Feature is class=context — no design partners needed for commodity work.
- One-off user interview — just run an interview and have ux-researcher synthesize; a program is overhead for a single session.
</Do_Not_Use_When>

<Why_This_Exists>
Every experienced founder knows that 5–20 design partners are the single highest-ROI input pre-launch. Every same founder also knows that design partner programs drift:
- Partners get chosen because they said yes, not because they match the ICP.
- Sessions become status updates instead of structured research.
- Notes pile up without synthesis, so findings stay locked in calendar events.
- Partners who should have graduated stay on, producing noise instead of signal.
- No clear exit means every partner feels like a retained customer, creating scope pressure to keep shipping for them specifically rather than the market.

This skill makes the default path the disciplined path. Selection criteria are explicit. Session agendas enforce structure. Synthesis is automated via ux-researcher. Graduation is a first-class operation.

It also resolves a specific OMC gap: agents like `ux-researcher` synthesize existing data, but nothing in OMC collected that data in the pre-launch phase. This skill fills that end of the pipe, feeding `.omc/research/` with artifacts that downstream agents (product-strategist, ideate, ux-architect, pre-launch-sprint) consume.
</Why_This_Exists>

<Entry_Point_Protocols>

## `--init` — Program Foundation

**Agent:** product-strategist + user (interactive)
**Input:** `.omc/constitution.md` + target-user section
**Output:** `.omc/partners/program.md`

**Protocol:**
1. Read constitution's target-user section.
2. Produce program document with:
   - **Goals**: what this program is for (e.g., "validate core mechanics with target ICP, gather specific pain points, build launch champions").
   - **Selection criteria**: ICP fit (role, industry, size, tool stack, current pain), anti-criteria (friends-of-team disqualified), commitment level, geographic scope.
   - **Partner count target**: minimum 5 for a core-feature sprint, comfortable 10–15, maximum 20.
   - **Cadence**: session frequency (biweekly is the common default), total program duration (typically 8–16 weeks).
   - **Session formats**: kick-off (60 min), recurring feedback (45 min), feature deep-dives (60 min on specific surfaces), exit interview (30 min).
   - **Compensation / incentive model**: free access + listed as launch partner / equity in some B2B contexts / cash in consumer contexts / nothing if genuine pull exists.
   - **NDA / mutual confidentiality**: pointer to template, not template itself.
   - **Scope boundaries**: what partners get input on vs what stays with the team (strategy, pricing, and brand are generally team-only; feature UX, mechanics, workflow are partner-fair).
   - **Graduation criteria**: program ends when [launch / target partner count hit goals / 16 weeks elapsed].
3. Write to `.omc/partners/program.md`.
4. Create supporting scaffolding:
   - `.omc/partners/roster.md` (empty table to be populated by `--onboard`)
   - `.omc/partners/outreach/` (directory for `--recruit` artifacts)
   - `.omc/partners/sessions/` (directory for session notes)
   - `.omc/partners/synthesis/` (directory for synthesized outputs)
   - `.omc/partners/graduated/` (directory for exit artifacts)

**HARD STOP:** Constitution absent or has no target-user section. Run `/oh-my-claudecode:brand-steward` first — selection criteria without an ICP produce a random-friends list.

---

## `--recruit "<criteria>"` — Outreach Generation

**Agents:** copywriter + (optional) competitor-scout for adjacent-tool users
**Input:** Program document + criteria string
**Output:** `.omc/partners/outreach/YYYY-MM-DD-<slug>.md`

**Protocol:**
1. Read `.omc/partners/program.md` and current roster (to avoid duplicates).
2. Parse criteria string into structured filters (role, industry, size, tool stack, pain).
3. Produce:
   - **Target persona profile**: verbatim ICP intersected with criteria.
   - **Channel plan**: where these people exist (specific subreddits, Slack communities, LinkedIn groups, conferences, tool-specific forums, competitor customers). Use competitor-scout's data if available.
   - **Outreach templates** (3 variations for A/B/C testing): cold DM, warm intro request, community-post. Each should pass the "would a stranger in my ICP respond to this?" test. Avoid: "we're building X, would you be interested in a demo?" (low response rate). Prefer: specific pain-centered question leading to offer.
   - **Tracking table schema**: candidate name, source, status (contacted / responded / qualified / onboarded / declined), first-contact date, notes.
4. Do NOT invent specific candidate names or contact info — that is the user's task, not the agent's.
5. Write outreach artifact.

**HARD STOP:** Criteria so narrow that no plausible channels exist (e.g., "CTOs of US hospitals with ≥10 000 beds" — that's ~15 people globally). Widen criteria or plan bespoke outreach.

---

## `--onboard <partner-id>` — Onboarding Kit

**Agents:** copywriter + (lightly) product-strategist
**Input:** Partner identifier + program document
**Output:** `.omc/partners/<partner-id>/onboarding.md` + roster update

**Protocol:**
1. Create `.omc/partners/<partner-id>/` directory.
2. Generate onboarding kit:
   - **Welcome message** (email draft, brand-voice per constitution).
   - **What to expect** (session cadence, time commitment, confidentiality).
   - **Access instructions** (staging URL placeholder — user fills in actual URL).
   - **Kick-off session agenda** (60 min): (1) their context and current workflow, (2) primary pain points, (3) product overview, (4) initial reactions, (5) establish preferred feedback channel.
   - **NDA/CDA reference** (pointer to legal template — this skill does not generate legal documents).
   - **Graduation expectations** (end-state clarity up front; partners appreciate knowing when it ends).
3. Update `.omc/partners/roster.md`:
   ```markdown
   | partner-id | name | role | company | ICP-fit | onboarded | status | notes |
   |---|---|---|---|---|---|---|---|
   ```
4. Status starts as `onboarded`. Advances through `active` → `graduating` → `alumni`/`advocate`/`inactive`.

**HARD STOP:** Partner ID already exists in roster. Halt with duplicate warning.

---

## `--session [<feature-slug>]` — Feedback Cycle

**Agents:** ux-researcher (for agenda design) + user (facilitates sessions)
**Input:** Roster + optional feature scope + prior session notes
**Output:** Per-partner agenda + note template at `.omc/partners/<partner-id>/sessions/YYYY-MM-DD-<type>.md`

**Protocol:**
1. Read roster; filter to `active` partners.
2. For each active partner, generate a session packet:
   - **Context recap** (one paragraph referencing their prior sessions if present).
   - **Agenda** (structured, 45 min default):
     - If `<feature-slug>` supplied: feature-specific deep-dive with task-based prompts ("show us how you would use this to accomplish X").
     - Else: recurring review (what's worked / what hasn't / what's missing / open questions).
   - **Structured note template** — questions the facilitator asks, with space for:
     - Verbatim quotes (most valuable output; get quotes, not paraphrases).
     - Observed behaviors (what they did vs what they said).
     - Workflow friction points.
     - Unprompted requests.
     - Confusion moments (gold for UX).
     - Partner's priority ordering (what matters most to them).
   - **Anti-patterns to avoid during the session** (checklist for the facilitator):
     - Don't lead with solutions.
     - Don't defend decisions when questioned.
     - Don't end with a demo (end with their questions).
     - Don't skip the silence — partners often talk when you wait.
3. Do NOT write fabricated session content — the template is for the user to fill during/after the session.
4. After session, user saves filled template to `.omc/partners/<partner-id>/sessions/YYYY-MM-DD-<type>.md`.

**HARD STOP:** Zero `active` partners. Run `--recruit` and `--onboard` first.

---

## `--synthesize [--since=<date>]` — Research Synthesis

**Agent:** ux-researcher
**Input:** Session notes from `.omc/partners/**/sessions/` since `--since` date (default: last 14 days)
**Output:** `.omc/partners/synthesis/YYYY-MM-DD-<topic>.md` + **linked copy** at `.omc/research/YYYY-MM-DD-<topic>.md`

**Protocol:**
1. Glob session notes from partner directories since `--since` (or last 14 days).
2. Invoke `oh-my-claudecode:ux-researcher` with directive: "Synthesize session notes from the provided paths. Cite every finding with partner-id + session-date + quote. Extract convergent themes (appearing in ≥2 partner sessions) vs unique individual observations. Produce structured research artifact."
3. ux-researcher produces:
   - **Convergent themes** (≥2 partners) — each with verbatim citations, partner count, severity (blocker / major friction / minor friction / delight).
   - **Unique observations** — single-partner findings worth tracking but weaker signal.
   - **Behavioral patterns** — what partners did (from observation, not self-report).
   - **Unprompted feature requests** — ranked by convergence.
   - **Open questions** — things no session surfaced but would be valuable; schedule for future sessions.
4. Write to `.omc/partners/synthesis/` AND copy (or link) to `.omc/research/` so downstream agents (product-strategist, ideate, ux-architect, pre-launch-sprint) can consume it as standard research input.

**HARD STOP:** Zero session notes in window. Nothing to synthesize; run sessions first.

---

## `--graduate <partner-id>` — Exit Protocol

**Agents:** copywriter (exit materials) + ux-researcher (exit synthesis)
**Input:** Partner ID + complete session history
**Output:** `.omc/partners/graduated/<partner-id>/` + roster update

**Protocol:**
1. Generate exit interview agenda (30 min):
   - Overall experience with the program.
   - What they would tell a peer about the product (launch-testimonial potential).
   - Top 3 things they hope the team prioritizes.
   - Top 3 things they hope the team does NOT do (anti-goal signals).
   - Willingness to: (a) testimonial, (b) case study, (c) reference call, (d) advisory role, (e) just alumni.
2. Exit-synthesis: ux-researcher produces a "partner journey" retrospective — what changed during their engagement, what they influenced, residual concerns.
3. Generate exit-message draft (copywriter, brand-voice).
4. Update roster status to `alumni` / `advocate` (if willing to testimonial+) / `inactive` (if disengaged).
5. Move partner folder to `.omc/partners/graduated/<partner-id>/`.

**HARD STOP:** None — but if partner was never active (onboarded but no sessions), record that as learning for `--recruit` criteria calibration.

---

## `--status` — Program Health Dashboard

**Agent:** design-partner-manager (this skill, no external agent)
**Input:** Program document + roster + sessions + synthesis artifacts
**Output:** Terminal summary + `.omc/partners/status/YYYY-MM-DD.md`

**Protocol:**
1. Count partners by status (onboarded / active / graduating / alumni / advocate / inactive).
2. Count sessions per partner (lifetime + last-30-days).
3. Compute health signals:
   - **Coverage**: are partners hitting ICP criteria, or has the roster drifted?
   - **Engagement**: what % of active partners had a session in the last 30 days?
   - **Synthesis freshness**: days since last `--synthesize` run.
   - **Convergence rate**: what fraction of findings are convergent (≥2 partners) vs unique?
   - **Inactive flag**: partners with no session in 45+ days → recommend `--graduate` as `inactive`.
4. Top issues (from latest synthesis).
5. Recommended next actions (with specific entry-point commands).

</Entry_Point_Protocols>

<Execution_Policy>
- Each entry point is independent — no forced sequence at invocation. `--init` is required before any other entry point; `--recruit`/`--onboard` populate the program; `--session`/`--synthesize` are recurring; `--graduate` ends individual engagements; `--status` is always safe.
- Program document at `.omc/partners/program.md` is the single source of truth for criteria; entries under `roster.md` are derived.
- Session notes are written by the USER after sessions (this skill provides templates, not fabricated content).
- Synthesis is the ONLY writeback into `.omc/research/` — downstream agents consume `.omc/research/` uniformly whether data came from partners, app telemetry, or interviews.
- Composable with `/oh-my-claudecode:loop` for synthesis cadence: `/loop 7d /design-partner-manager --synthesize`.
- Composable with `/oh-my-claudecode:pre-launch-sprint` as its Week 3 external-validation dependency.
</Execution_Policy>

<Input_Contract>
Primary argument: one entry-point flag (required).

Entry-point-specific arguments:
- `--init` — no args.
- `--recruit "<criteria>"` — criteria string (ICP + pain filters).
- `--onboard <partner-id>` — slug matching future roster entry.
- `--session [<feature-slug>]` — optional feature scope.
- `--synthesize [--since=<date>]` — optional date filter (default: last 14d).
- `--graduate <partner-id>` — existing partner slug.
- `--status` — no args.
</Input_Contract>

<Output>
Program artifact tree under `.omc/partners/`:

```
.omc/partners/
├── program.md                              # goals, criteria, cadence, graduation criteria
├── roster.md                               # current partners with status
├── outreach/YYYY-MM-DD-<slug>.md           # recruitment artifacts
├── <partner-id>/
│   ├── onboarding.md
│   └── sessions/YYYY-MM-DD-<type>.md       # filled by user
├── sessions/                               # (if grouping by date rather than partner)
├── synthesis/YYYY-MM-DD-<topic>.md         # ux-researcher output
├── graduated/<partner-id>/                 # exit artifacts
└── status/YYYY-MM-DD.md                    # health dashboard snapshots
```

Research cross-link:

```
.omc/research/YYYY-MM-DD-<topic>.md         # copy / link of synthesis artifact
```
</Output>

<Failure_Modes_To_Avoid>
- **Recruiting "friends who'll say yes".** Invisible failure until launch. The program document's selection criteria exist to make ICP fit explicit; add an anti-criteria line listing "friends, investors, advisors who are not in ICP."
- **Running sessions without structured note templates.** Unstructured notes produce paraphrase, not quotes. Synthesis value comes from verbatim quotes with attribution — enforce template use.
- **Piling up session notes without synthesis.** Notes that don't reach `.omc/research/` are locked value. Run `--synthesize` biweekly minimum; loop-automate it.
- **Never graduating partners.** Programs that accumulate partners past the graduation criteria drift into "relationship management," not research. Force graduation at program-end or `inactive`-detection.
- **Partners driving roadmap directly.** Partner input informs prioritization; it does not replace priority-engine or product-strategist. Convergent partner signal is ONE input; strategy and metrics are others.
- **Synthesizing without citation.** Every finding in the synthesis must cite partner-id + session-date + quote. Without citations, findings are indistinguishable from team opinions.
- **Using partner sessions to demo instead of listen.** Session agendas end with partner questions, not team demos. A demo-heavy session produces praise (low signal), not insight.
- **Promising features in sessions.** Partners interpret "we'll build X" as a commitment; team interprets it as exploration. Gap causes churn. Session etiquette: "we'll add to our list" is the maximum promise.
- **Running this skill for launched products.** App telemetry + interviews replace design partners post-launch. This skill is structurally pre-launch.
- **Initializing without a constitution.** Selection criteria need an ICP; ICP lives in the constitution. `--init` HARD STOPs if constitution is absent.
- **Sharing partner quotes without attribution control.** Cross-check NDA before quoting partners in public-facing artifacts (landing pages, investor decks). Synthesis artifacts under `.omc/partners/` are internal by default.
</Failure_Modes_To_Avoid>

<Integration_Notes>
- Reads: `.omc/constitution.md`, prior `.omc/partners/**` state.
- Writes: exclusively under `.omc/partners/**`; cross-links synthesis into `.omc/research/`.
- Depends on: `oh-my-claudecode:ux-researcher` (synthesis), `oh-my-claudecode:copywriter` (outreach / onboarding / exit materials), optionally `oh-my-claudecode:product-strategist` (program foundation), optionally `oh-my-claudecode:competitor-scout` (channel identification for recruiting).
- Feeds: `oh-my-claudecode:pre-launch-sprint` Week 3 external validation; `oh-my-claudecode:ideate` Phase 0 context; `oh-my-claudecode:product-strategist` strategy context; any skill that consumes `.omc/research/`.
- Automation: pair with `/oh-my-claudecode:loop` for recurring synthesis: `/loop 14d /design-partner-manager --synthesize`.
- Status cadence: pair with `/loop 7d /design-partner-manager --status` for weekly health snapshot.
- NDA / legal templates are explicitly OUT of scope — this skill references them as user-owned legal documents, never generates binding legal text.
- Contact data (emails, phone numbers) is NOT stored in `.omc/partners/` by this skill — partner-ids only. Contact data belongs in the team's CRM/contact system, kept out of the repo.
- For launched-product equivalent (not yet built): `user-research-manager` — interviews and session recordings instead of design partners.
</Integration_Notes>
