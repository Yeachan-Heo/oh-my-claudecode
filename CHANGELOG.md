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
