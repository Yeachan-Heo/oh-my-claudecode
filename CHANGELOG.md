# oh-my-claudecode v4.16.0: Handoff Envelope + Digest System + Inspiration Fetch

## Release Notes

Minor release focused on framework-level efficiency and agent-interaction standardization. Adds three new skills, one standards document, and retrofits a handoff envelope into the seven agents introduced since v4.13.

### New this release

- **feat(docs): HANDOFF-ENVELOPE standard** (`docs/HANDOFF-ENVELOPE.md`) — schema for machine-readable `<handoff>` YAML blocks appended to every agent output. Downstream agents read ~200 tokens of envelope instead of ~5-10K tokens of prose to decide next step. Fields: `schema_version`, `produced_by`, `primary_artifact`, `next_recommended` (ordered), `key_signals` (quantitative only), `gate_readiness`, `artifacts_produced`, `context_consumed`, `requires_user_input`, `halt`.

- **feat(skills): handoff-orchestrator** — follows envelope chains across agents/skills automatically. Reads latest artifact's envelope, invokes `next_recommended[0]`, loops until end-of-chain, halt, or blocking user input. Interactive by default (confirm between steps); `--auto` for unsupervised, `--max-steps=N` safety cap (default 10), `--stop-at=<agent>` checkpoint, `--dry-run` preview.

- **feat(skills): digest-maintain** — framework efficiency utility. Generates and maintains `.omc/digests/` — short-form summaries of constitution (~300 tokens vs ~3K full), competitors landscape, research highlights, brand core, ideas shortlist, classification. Agents read digests by default; fall back to full artifact only when specifics needed. ~90% token reduction on repeat reads across agents in a session. Documents PostToolUse hook pattern for auto-refresh; hook config is opt-in (not force-installed).

- **feat(skills): inspiration-fetch** — MCP-independent fetcher that parses public URLs (are.na boards, Figma public files, Unsplash collections, Pinterest public boards, GitHub repos, generic web pages) via WebFetch into draft inspiration entries for `.omc/brand/inspiration/drafts/`. User reviews and refines drafts, then `/brand-architect --inspiration` merges approved ones into the main library. Preferred path over community-MCP dependency to remain resilient to ecosystem churn. Supports optional `--prefer-mcp` mode for users who install Figma's official MCP.

### Retrofitted

Seven agents introduced in v4.13-4.15.1 now emit `<handoff>` envelopes at end of primary artifact:
- `ideate` — envelope includes shortlist_count, convergent_cluster_count, anti_goal_watchlist_count, gate readiness (critic_needed, strategist_needed)
- `competitor-scout` — envelope includes new_candidates_surfaced, alerts_critical, top_threat_score, gate readiness (ideate_counter_move_warranted)
- `domain-expert-reviewer` — envelope includes personas_engaged, critical_findings_cited, launch_recommendation, gate readiness (real_expert_validation_required)
- `brand-architect` — envelope includes archetype_primary, grammar_invariant_count, inspiration_source_count, gate readiness (campaign_composer_ready)
- `brand-steward` — envelope includes session_number, anti_goals_competitor_cited count, gate readiness (brand_architect_ready)
- `campaign-composer` — envelope includes variations_count, forbidden_pattern_matches_prescreen, inspiration_sources_distinct, gate readiness (director_review_needed)
- `creative-director` — envelope includes variations_pass/revise/reject counts, commodification-drift signals, gate readiness (designer_ready, brand_architect_review_needed)

- **feat(agents): brand-architect** also gains Phase 2.5 reference to the `inspiration-fetch` skill workflow: user provides URLs → `inspiration-fetch` produces drafts → user refines → `brand-architect --inspiration` merges.

### Known limitations (honestly scoped out)

- **Prompt caching with `cache_control`** was considered but deferred: OMC registers agent prompts as `prompt: string`, and the runtime that sends them to the Anthropic API is Claude Code's native agent-invocation layer — outside the plugin's control. Achieving prompt caching would require Claude Code SDK changes, not OMC changes.
- **Runtime Context-Manifest enforcement** (filtering context based on agent `reads:` declarations) deferred to v4.17+ — requires middleware in the agent-invocation layer.
- **Multi-model phase routing** (haiku for context-loading, opus for reasoning within same invocation) deferred indefinitely — infrastructure-heavy for modest relief.
- **Auto-install of PostToolUse hook for digest-maintain** not forced in v4.16 — the skill documents the hook pattern; users opt in manually by editing `hooks/hooks.json`. This avoids surprising users with new automated behavior on upgrade.

### Registry updates

- No new agents in this release (envelope retrofit is content, not structural).
- Three new skills: `handoff-orchestrator`, `digest-maintain`, `inspiration-fetch`.
- `src/__tests__/skills.test.ts`: bumped counts 45→48 (createBuiltinSkills), 44→47 (canonical names), 45→48 (with aliases); extended expectedSkills.
- No changes to `src/agents/definitions.ts` (no new agents registered).
- `.claude-plugin/marketplace.json`: description updated to reflect current counts (32 agents, 47 skills).

All 49 tests in `agent-registry.test.ts` + `skills.test.ts` pass.

### Migration notes

- Pre-v4.16 artifacts don't have handoff envelopes; `handoff-orchestrator` gracefully terminates chains at agents that don't emit envelopes (reports "chain terminated — <agent> did not emit envelope").
- To get the digest efficiency benefit today, run `/digest-maintain --regenerate-all` once; thereafter, either run periodically (`/loop 24h /digest-maintain`) or enable the PostToolUse hook per `skills/digest-maintain/SKILL.md` Hook_Configuration section.
- The `inspiration-fetch` skill does NOT require any MCP to be installed — works out of the box via WebFetch. Figma MCP is optional and used only with `--prefer-mcp` flag.
- Existing brand-architect runs from v4.15 continue to work; run `/brand-architect --refine` to add the new inspiration library Phase 2.5 to your existing brand artifacts.

---

# oh-my-claudecode v4.15.1: Conversational brand-steward + Anti-commodity brand system

## Release Notes

Patch release fixing the brand-steward interaction UX and encoding the anti-commodity writing/design philosophy into brand-architect, campaign-composer, and creative-director. No new agents or skills; existing ones materially improved.

### brand-steward — conversational mode

**Problem fixed:** Previous brand-steward produced long multi-section discovery messages ("Блок 1 — Миссия / Вопрос 1. / Вопрос 2. ..."), language-selection pre-menus, and meta-instructions to the user. Questions got buried in preamble; user experience felt like filling a form, not a discovery interview.

**Changes:**
- `agents/brand-steward.md` Investigation_Protocol fully rewritten as a **conversation protocol**: ≤80 words first message, ONE question per turn, no numbered blocks, no pre-menus, no context narration, synthesis only at end.
- Discrete choices (language preference, bilingual, etc.) now asked in dialogue at the moment they become relevant — never as selection screens.
- Competitor-specific references in anti-goal questions ("Ravelry is community-first social — deliberately not-that?") replace abstract questioning.
- Per-turn reply ≤120 words; reflect user's answer in ≤2 sentences, then ONE next question.
- Terminal synthesis message ≤500 words of actual content, asking for corrections on specific lines — not more open-ended questions.
- `skills/brand-steward/SKILL.md` simplified: removed Phase 1 context narration, removed pre-menus, enforced direct Task invocation (not teammate/SendMessage relay that produced the "I'll relay your reply" proxy-UX).
- New Failure_Modes_To_Avoid explicitly flag batching questions, numbered blocks, long preamble, pre-menu language selection, narrating context reads, and meta-instructions as anti-patterns.

### Anti-commodity brand system (brand-architect + campaign-composer + creative-director)

**Problem addressed:** Brand expressions in v4.15.0 were grammar-coherent but could still drift into generic SaaS phrasing and shallow single-meaning pieces — the "soulless polish" problem. User's philosophical stance encoded explicitly: new is inspired by old, indirect > direct, complexity > template, every piece carries a specific soul marker.

**Changes:**

- `agents/brand-architect.md`:
  - **New Phase 2.5 — Inspiration Sources Library**. Discovery phase collects 5–10 concrete sources (are.na boards, books, films, artworks, cultural moments, architectural movements) with fields: name, citation URL, axis (visual/verbal/structural/atmospheric/narrative), `why_it_inspires`, `what_to_extract`, `what_NOT_to_copy`. Writes `.omc/brand/inspiration.md` with status `seed | growing | curated`.
  - **New grammar invariants** (anti-commodity foundation):
    - `anti_template.forbidden_patterns`: list of 15–25 generic SaaS phrasings (e.g., "empower your X", "the smart way to Y", "reimagine Z"). Test: "if a sentence could appear unchanged on 10+ competitor landing pages, it violates." Enforcement: HARD STOP at both composer (pre-screen) and director (post-review).
    - `indirectness_minimum`: scale 1–5, primary 4, per-context drift ranges. Directness only allowed for user-safety messages.
    - `semantic_layering`: minimum 2 layers per significant piece — every headline/tagline carries surface + deeper meaning.
    - `soul_marker`: required true; every piece must have an un-template-able element (specific cultural reference, named cadence, idiosyncratic image).
    - `inspiration_traceability`: every campaign variation must cite ≥1 source from `.omc/brand/inspiration.md` with specific `extracted_quality`.
  - **New variables**: `inspiration_source` (enum from library, ≥3 distinct across N variations, no same-source in consecutive), `semantic_layer_count` (2/3/4, distributed across set).

- `skills/brand-architect/SKILL.md`:
  - New `--inspiration` flag runs only Phase 2.5 of the agent (appends sources to library without full rediscovery).
  - Integrates with `--discovery` and `--refine` flows.

- `agents/campaign-composer.md`:
  - **Mandatory pre-screen** against forbidden_patterns BEFORE emitting any variation (not emit-and-wait-for-director).
  - Every variation spec includes new **Anti-Commodity Self-Check** section: forbidden-pattern scan result, cited inspiration source with specific extracted quality and anti-plagiarism boundary, indirectness value with surface + deeper meanings, soul_marker named concretely.
  - Phase 4 Variance Gate expanded to Variance + Anti-Commodity Gate: checks inspiration diversity (≥3 sources), semantic layer distribution (not all layer_count=2), soul_marker presence and specificity.
  - REQUIRES `.omc/brand/inspiration.md` with ≥3 sources — HARD STOP if missing.

- `agents/creative-director.md`:
  - **New Phase 4.5 — Commodification Drift Detection (MANDATORY)** with six sub-checks:
    - 4.5a: Anti-template forbidden_patterns scan — any match → CRITICAL REJECT.
    - 4.5b: Inspiration source citation verification (specific extracted_quality, ≥8 words, concrete descriptors).
    - 4.5c: Semantic layer verification (surface + layer-2 both substantively different).
    - 4.5d: Soul marker specificity (no "has personality" vagueness).
    - 4.5e: Cross-variation inspiration diversity (≥3 sources, no consecutive-same).
    - 4.5f: Indirectness distribution (within per-context drift range).
  - Every verdict cites the grammar file:line for the violated invariant.
  - New Failure_Modes explicitly flag downgrading forbidden-pattern matches as unacceptable.

### Marketplace description

Updated in v4.15.0; unchanged in v4.15.1 — still 32 agents, 44 skills (no new agents/skills in this patch).

### Migration notes for existing users

- Existing `.omc/constitution.md` files continue to work. The conversational brand-steward will respect `status: complete` and confirm before modifying.
- Existing `.omc/brand/core.md` + `grammar.md` files continue to work. To gain the anti-commodity invariants, re-run `/brand-architect --refine` and the agent will add the new invariants to grammar.md (with archive of prior version per the standard supersession protocol).
- `/brand-architect --inspiration` is a lightweight way to seed `.omc/brand/inspiration.md` without regenerating the core or grammar.
- campaign-composer will HARD STOP on missing `.omc/brand/inspiration.md`; run `/brand-architect --inspiration` first on upgrade.

### Registry updates

No agent or skill count changes; no test count changes.

All 49 tests in `agent-registry.test.ts` + `skills.test.ts` pass.

### Known limitations

- Forbidden_patterns list is a starting point of 15 common SaaS phrasings; brand-specific additions should happen during discovery.
- Inspiration library quality depends on the user's actual cultural inputs; agent cannot invent sources — it collects them via conversation.
- Semantic layer detection relies on composer's self-declaration; director verifies plausibility but can be fooled by a well-structured-looking-but-actually-flat piece. A future LLM-judge pass may be added.

---

# oh-my-claudecode v4.15.0: Brand System + Framework Sustainability

## Release Notes

Minor release adding the brand-system layer (three agents + one orchestrator skill), three slash-command wrappers for commonly-invoked agents, an artifact-lifecycle utility for ongoing `.omc/` hygiene, and the Context-Manifest standard for NEW agents. No forced retrofit of existing agents.

### Highlights

- **feat(agents): add brand-architect (opus)** — designs the brand SYSTEM (Jungian archetype + core metaphor + variation grammar with invariants and variables). Self-sufficient discovery even without prior constitution, with built-in competitor-whitespace analysis for archetype selection. Produces `.omc/brand/core.md` + `grammar.md`.
- **feat(agents): add campaign-composer (sonnet)** — generates N grammar-coherent marketing/design/copy variations from a brief. Every variation tagged with invariants manifested and variables exercised. Enforces variance gate (≥2 variables must exhibit ≥2 distinct values).
- **feat(agents): add creative-director (opus, read-only)** — brand-variation guardrail. Reviews campaign variations against brand core + grammar; detects drift (out-of-grammar) and sameness (insufficient variation). Per-variation PASS/REVISE/REJECT verdict with file:line evidence from grammar.md.
- **feat(skills): add brand-variations-generate** — orchestrator composer→director pipeline for generating brand-coherent campaign variations.
- **feat(skills): add brand-architect / brand-steward / product-strategist** — thin slash-command wrappers for commonly-invoked agents; handles prerequisite checks and session detection.
- **feat(skills): add artifact-lifecycle** — framework-sustainability utility. Scans `.omc/**` for stale / superseded / abandoned / duplicate artifacts and produces a lifecycle report. Optional `--archive` mode moves flagged files to per-directory archive subdirectories with user confirmation. Never deletes.
- **docs: add CONTEXT-MANIFEST standard** (`docs/CONTEXT-MANIFEST.md`) — convention for declaring `reads:` / `writes:` / `supersession:` in new agent frontmatter. Optional for existing agents; no forced retrofit.

### Why this release matters

The framework was accumulating three structural issues: (1) no brand system capable of scaled variation (marketing and design outputs drift without explicit grammar), (2) agents like brand-steward and product-strategist lacked slash-command wrappers (users had to invoke via natural language), (3) no lifecycle management for accumulated `.omc/` artifacts. v4.15.0 addresses all three without forcing cosmetic rework on existing agents.

The brand-system design is inspired by archetypal branding (Jung), Blue Ocean differentiation (Kim & Mauborgne), and grammar-based generative systems. Core stays fixed (archetype, metaphor, narrative invariants); grammar defines axes of permitted variation with combination rules. Campaign-composer generates within the grammar; creative-director enforces. The result: infinite campaign variations that remain brand-coherent.

### Registry updates

- `src/agents/definitions.ts`: registered `brandArchitectAgent`, `campaignComposerAgent`, `creativeDirectorAgent`.
- `src/agents/index.ts`: re-exports added.
- `src/__tests__/agent-registry.test.ts`: bumped expected agent count 29 → 32.
- `src/__tests__/skills.test.ts`: bumped skill counts 40→45 / 39→44 / 40→45; extended `expectedSkills` with `artifact-lifecycle`, `brand-architect`, `brand-steward`, `brand-variations-generate`, `product-strategist`.
- `.claude-plugin/marketplace.json`: descriptions updated to reflect current counts (32 agents, 44 skills).

All 49 tests in `agent-registry.test.ts` + `skills.test.ts` pass locally.

### Context-Manifest standard (optional)

New agents introduced in v4.15.0 follow a manifest convention in frontmatter:

```yaml
reads:
  - path: ".omc/brand/core.md"
    required: true
    use: "Archetype, metaphor, voice ladder"
writes:
  - path: ".omc/brand/expressions/YYYY-MM-DD-{slug}/variation-{N}.md"
    status_field: "draft | proposed | approved | rejected"
    supersession: "new files per round; prior rounds retained for diffing"
```

See `docs/CONTEXT-MANIFEST.md` for the full specification. Existing agents continue to work unchanged; retrofit is opportunistic (when agents are modified for other reasons).

### Known limitations

- Context-Manifest is currently documentary — no runtime yet uses `reads:` / `writes:` declarations to filter context. Declaring honestly now prepares agents for future runtime optimization.
- `artifact-lifecycle` uses best-effort metadata (filename date, frontmatter `updated:`, mtime fallback); agents following the standard produce richer signal but compliance is not a prerequisite.
- `brand-architect` archetype selection has LOW confidence when `.omc/competitors/` is empty; skill wrapper prompts to run competitor-scout first.
- `campaign-composer` produces specifications, not final assets — downstream designers/copywriters/executors turn specs into production.

---

# oh-my-claudecode v4.14.0: Product Development Framework

## Release Notes

Minor release adding the pre-launch validation layer: one new agent, two new skills, plus test-registry synchronization. Builds on v4.13.0 (which added divergent ideation, competitive intelligence, and the backend execution pipeline).

### Highlights

- **feat(agents): add domain-expert-reviewer (opus, read-only)** — explicit proxy for regulated-domain expert review. Multi-persona protocol (1–4 personas per domain), required citations with retrieval URL+date, mandatory "Questions for Real Expert" list, PROXY REVIEW banner on every artifact. Pre-defined persona sets for healthcare, financial, legal-tech, accessibility, and safety-critical domains.
- **feat(skills): add pre-launch-sprint** — 4-week sprint orchestrator per core feature (Mechanic → Build with property-based tests → External validation via design-partners + expert-proxy + prototype/WoZ → Hardening → Launch-readiness gate with GO/HOLD/ONE-MORE-CYCLE verdict). Class-based depth auto-scaling (core/enabling/context). Resolves the pre-launch ideate-on-feature paradox: ideate is sanctioned within a feature scope pre-launch (no migration cost) but not post-launch.
- **feat(skills): add design-partner-manager** — long-running skill with 7 entry points (`--init`, `--recruit`, `--onboard`, `--session`, `--synthesize`, `--graduate`, `--status`) managing pre-launch partner program lifecycle. Synthesis feeds directly into `.omc/research/` via ux-researcher. Does NOT fabricate session content (templates only). Does NOT store contact data (partner-ids only; CRM owns contacts). Graduation is a first-class operation.

### What's new vs v4.13.0

v4.14.0 is the "pre-launch validation" layer. v4.13.0 already shipped the "divergent generation" (ideate), "competitive intelligence" (competitor-scout), and "backend execution" (backend-pipeline) pieces. Together they form the full product-development framework:

```
FOUNDATION       brand-steward, ux-researcher, competitor-scout (v4.13.0)
DIVERGENT        ideate (v4.13.0)
VALIDATION       design-partner-manager (v4.14.0), domain-expert-reviewer (v4.14.0)
GATES            product-strategist, critic, priority-engine
PRE-LAUNCH       pre-launch-sprint (v4.14.0)
EXECUTION        product-pipeline, backend-pipeline (v4.13.0)
```

### Registry updates

- `src/agents/definitions.ts`: registered `domainExpertReviewerAgent` (AgentConfig + export + getAgentDefinitions map).
- `src/agents/index.ts`: re-export added.
- `src/__tests__/agent-registry.test.ts`: bumped expected agent count 28 → 29.
- `src/__tests__/skills.test.ts`: bumped skill counts 38→40 / 37→39 / 38→40; extended `expectedSkills` with `design-partner-manager` and `pre-launch-sprint`.
- `.claude-plugin/marketplace.json`: description updated to reflect current counts (29 agents, 39 skills).

All 49 tests in `agent-registry.test.ts` + `skills.test.ts` pass.

### Known limitations

- `pre-launch-sprint` Week-2 property-based tests assume Hypothesis / fast-check / PropTest availability; framework-specific directives are not yet baked in.
- `domain-expert-reviewer` retrieval fallback chain (linkup → ref-context → WebSearch → WebFetch) has not been validated end-to-end against live regulated-domain queries.
- `design-partner-manager` synthesis pipeline via `ux-researcher` has not been exercised against real session notes yet.

---

# oh-my-claudecode v4.12.1: Bug Fixes

## Release Notes

Release with **8 bug fixes** across **24 merged PRs**.

### Highlights

- **fix(hooks): align tier-alias routing proof with CC-native model resolution** (#2683)
- **fix(models): align built-in Opus HIGH default with Claude Opus 4.7** (#2685)
- **fix(agents): replace scanner-bait commit placeholders** (#2682)

### Bug Fixes

- **fix(hooks): align tier-alias routing proof with CC-native model resolution** (#2683)
- **fix(models): align built-in Opus HIGH default with Claude Opus 4.7** (#2685)
- **fix(agents): replace scanner-bait commit placeholders** (#2682)
- **fix(installer): preserve remote MCP transport type during registry sync** (#2680)
- **fix(team): preserve Gemini team lanes when preflight path probing false-negatives** (#2676)
- **fix(team): close #2659 with the clean prompt tag sanitizer diff** (#2673)
- **fix(notifications): close #2660 with the clean tmux-tail diff** (#2674)
- **fix(hooks): ignore workflow keywords inside delegated ask prompts** (#2672)

### Refactoring

- **refactor(skill-state): harden stateful-skills keyword detection and state init**

### Documentation

- **docs: add Discord link to navigation in all README translations**

### Stats

- **24 PRs merged** | **0 new features** | **8 bug fixes** | **0 security/hardening improvements** | **0 other changes**
