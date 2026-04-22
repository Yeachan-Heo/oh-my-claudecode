<!-- OMC:VERSION:4.16.0 -->
# Handoff Envelope Standard

**Introduced:** v4.16.0
**Scope:** Convention for agent outputs; enables machine-readable handoffs and downstream token savings.

## Problem

Downstream agents currently must re-read the full output of upstream agents (often 5–10K tokens of prose) to extract the few fields they need to make a decision: which agent to call next, which artifact is the current one, what status signals matter.

This is both token-expensive and opaque: the downstream agent's "understanding" of the upstream's handoff is inferred from prose, which is lossy and error-prone.

## Solution

Every agent appends a single `<handoff>` YAML block at the end of its primary artifact. Downstream agents read ONLY this envelope (200–400 tokens) to decide next action and fetch specific signals. The full prose remains available for cases that need it (e.g., critic running red-team needs the full plan).

## Envelope Schema

```yaml
<handoff>
  # Schema version — bump when breaking changes
  schema_version: 1

  # Authoring agent
  produced_by: <agent-name>
  produced_at: YYYY-MM-DD

  # Primary artifact this output relates to
  primary_artifact:
    path: ".omc/<path-to-artifact>.md"
    status: "draft | partial | complete | approved | rejected | halted"

  # Handoff recommendations — machine-readable, ordered
  next_recommended:
    # Ordered list; first is the strongest recommendation
    - agent: <agent-name or skill-name>
      purpose: "<1-line reason for hand-off>"
      required: true | false  # true = pipeline blocks until this step runs
    - agent: ...

  # Key signals for downstream — quantitative or enum values only
  # Downstream agents can read these without parsing prose
  key_signals:
    <signal_name>: <value>
    # e.g.:
    # shortlist_count: 7
    # convergent_cluster_count: 3
    # requires_validation_count: 4
    # anti_goal_violations: 0
    # critical_findings: 2
    # confidence_summary: "high=5 medium=8 low=3"

  # Gate readiness — boolean flags for next-stage prerequisites
  gate_readiness:
    # Flags that downstream pipelines check before proceeding
    <gate_name>: true | false
    # e.g.:
    # critic_needed: true
    # strategist_needed: true
    # expert_proxy_needed: false
    # partners_count_met: true

  # Artifacts produced this invocation
  artifacts_produced:
    - path: ".omc/<path>.md"
      type: primary | supporting | draft
      supersedes: ".omc/<prior-path>.md"  # optional

  # Context consumed — for audit trail
  context_consumed:
    - ".omc/<file-or-glob>"
    # Populated from agent's frontmatter `reads:` declarations

  # Open questions requiring user input (null if none)
  requires_user_input:
    - question: "<specific question>"
      blocking: true | false

  # Halt reason if status=halted
  halt:
    reason: "<HARD STOP trigger>"
    remediation: "<what user must do to resume>"
    resume_from: "<phase or stage to re-enter>"
</handoff>
```

## Handoff Envelope v2 (Schema-First Strategy/Provisioning)

For stack-strategy and provisioning orchestration, prefer the v2 machine envelope below. This payload is intentionally flat and deterministic so orchestrators can reject malformed handoffs early. Put the v2 payload inside the same `<handoff>...</handoff>` markers so `handoff-orchestrator` can locate it; version detection is based on the v2 required fields, not `schema_version`.

```yaml
<handoff>
run_id: <string>
agent_role: <technology-strategist|document-specialist|critic|stack-provision|orchestrator>
inputs_digest: <stable digest>
assumptions:
  - <assumption>
scorecard:
  weights:
    product_fit: 0.30
    operability: 0.20
    ecosystem_maturity: 0.20
    performance: 0.15
    security_compliance: 0.10
    cost_efficiency: 0.05
  top2_gap: <number>
compatibility_report:
  overall_status: compatible|risky|blocked|unknown
  blocked_pairs: <integer>
  unknown_pairs: <integer>
risk_register:
  - id: <risk-id>
    severity: low|medium|high|critical
    mitigation: <text>
decision:
  verdict: approve|revise|rewind
  rationale: <text>
requested_next_agent: <agent name>
permissions:
  read_scope: <globs>
  write_scope: <globs>
response_template:
  status: <ok|needs-research|blocked>
  evidence: <brief pointers>
  confidence: <0..1>
  blocking_issues:
    - <issue>
  next_action: <single step>
</handoff>
```

If any required field is missing or has incompatible type, the orchestrator must reject the handoff and request a corrected envelope before moving to the next stage.

## Rules

### MUST

1. Every agent's **primary artifact** must end with a `<handoff>` block (wrapped in `<handoff>...</handoff>` XML-style markers for machine parsing).
2. Fields `schema_version`, `produced_by`, `produced_at`, `primary_artifact`, `next_recommended` are REQUIRED.
3. `key_signals` must contain only scalar values (numbers, strings, booleans) — NO nested prose.
4. `next_recommended` is an ORDERED list; first entry is the strongest recommendation.
5. If the invocation halted at a HARD STOP, `primary_artifact.status = halted` AND `halt` block is present.

### MUST NOT

1. Do NOT duplicate prose content inside `key_signals`. Signals are quantitative; prose stays in artifact body.
2. Do NOT omit the envelope because the invocation failed — a halted invocation still emits `status: halted` + `halt` block.
3. Do NOT invent agents for `next_recommended` that don't exist. Only reference agents/skills registered in OMC.
4. Do NOT write `key_signals` that change across invocations with the same input (they must be deterministic functions of the artifact).

## Consumers

### `handoff-orchestrator` skill

Reads the latest artifact's envelope, extracts `next_recommended[0]`, invokes that agent/skill with references to artifacts. Loops until:
- Current envelope has `next_recommended: []` (end of chain).
- `requires_user_input` has blocking items.
- Any `status: halted`.

Default mode is interactive (ask user confirmation between steps); `--auto` mode runs unsupervised until halt.

### Downstream agents

Agents that follow in a pipeline read only the envelope by default:
- `critic` reads envelope + artifact body (needs prose for red-team).
- `priority-engine` reads envelopes of many artifacts (only signals needed).
- `verifier` reads envelope + targeted sections of artifact.

### Human consumers

The envelope is the "TL;DR" of an agent's output. A terminal summary can surface:
- Which artifact was produced
- Next recommended step
- Any blocking gates
- Key numbers (e.g., "7 shortlist candidates, 3 convergent")

## Examples

### Example 1: `ideate` finishes Phase 7

```yaml
<handoff>
  schema_version: 1
  produced_by: ideate
  produced_at: 2026-04-20
  primary_artifact:
    path: ".omc/ideas/2026-04-20-onboarding-mechanics.md"
    status: complete
  next_recommended:
    - agent: critic
      purpose: "Red-team shortlist per ideate Phase 6 handoff"
      required: true
    - agent: product-strategist
      purpose: "Gate shortlist against anti-goals after red-team"
      required: true
    - skill: priority-engine
      purpose: "Rank shortlist against backlog"
      required: false
  key_signals:
    shortlist_count: 7
    convergent_cluster_count: 3
    outliers_kept: 2
    requires_validation_count: 4
    anti_goal_watchlist_count: 1
    methods_run: 4
  gate_readiness:
    critic_needed: true
    strategist_needed: true
    priority_engine_needed: false
  artifacts_produced:
    - path: ".omc/ideas/2026-04-20-onboarding-mechanics.md"
      type: primary
    - path: ".omc/ideas/clusters/2026-04-20-onboarding-mechanics.md"
      type: supporting
    - path: ".omc/ideas/raw/2026-04-20-jtbd-onboarding-mechanics.md"
      type: supporting
  context_consumed:
    - ".omc/constitution.md"
    - ".omc/competitors/**/*.md"
    - ".omc/research/**/*.md"
  requires_user_input: []
</handoff>
```

### Example 2: `backend-pipeline` halts at Stage 7 security CRITICAL

```yaml
<handoff>
  schema_version: 1
  produced_by: backend-pipeline
  produced_at: 2026-04-20
  primary_artifact:
    path: ".omc/handoffs/backend-pipeline-stage7.md"
    status: halted
  next_recommended:
    - agent: executor
      purpose: "Remediate CRITICAL security finding before Stage 8"
      required: true
    - agent: security-reviewer
      purpose: "Re-audit after remediation"
      required: true
  key_signals:
    security_critical_findings: 1
    security_major_findings: 3
    performance_budget_breach: false
    verifier_run: false
  gate_readiness:
    code_reviewer_needed: true
    verifier_needed: false
  artifacts_produced:
    - path: ".omc/audits/2026-04-20-security-auth-webhook.md"
      type: primary
    - path: ".omc/audits/2026-04-20-perf-auth-webhook.md"
      type: supporting
  halt:
    reason: "security-reviewer reported CRITICAL finding: missing authn check on /webhook endpoint"
    remediation: "Add authn middleware; re-run Stage 7 only"
    resume_from: "Stage 7 (security + performance parallel)"
  requires_user_input: []
</handoff>
```

### Example 3: `brand-architect` discovery partial, needs user

```yaml
<handoff>
  schema_version: 1
  produced_by: brand-architect
  produced_at: 2026-04-20
  primary_artifact:
    path: ".omc/brand/core.md"
    status: partial
  next_recommended:
    - agent: brand-architect
      purpose: "Resume after user provides inspiration sources"
      required: true
  key_signals:
    archetype_selected: true
    core_metaphor_articulated: true
    grammar_invariant_count: 5
    grammar_variable_count: 3
    inspiration_source_count: 0
  gate_readiness:
    campaign_composer_ready: false
    inspiration_library_seeded: false
  artifacts_produced:
    - path: ".omc/brand/core.md"
      type: primary
    - path: ".omc/brand/grammar.md"
      type: primary
  requires_user_input:
    - question: "What 5-10 inspiration sources ground this brand? (are.na boards, books, films, cultural references)"
      blocking: true
</handoff>
```

## Adoption Guidance

Agents introduced in v4.13 through v4.15 are retrofitted in v4.16.0:
- ideate
- competitor-scout
- domain-expert-reviewer
- brand-architect
- brand-steward
- campaign-composer
- creative-director

Existing OMC-native agents (executor, analyst, planner, critic, architect, etc.) are NOT retrofitted in v4.16 to avoid cosmetic churn; they adopt the envelope opportunistically when otherwise modified.

Skills that produce primary artifacts (product-pipeline, backend-pipeline, pre-launch-sprint, ideate-skill, etc.) append envelopes to their final consolidated reports.

## Versioning

`schema_version: 1` is the initial version. Breaking additions (renamed fields, removed fields) bump to `schema_version: 2` with a migration note in CHANGELOG. Additive new fields do NOT bump the version — consumers ignore unknown fields.

## Parser Implementation Hints

Consumers locate the envelope by scanning for `<handoff>` and `</handoff>` markers at end of file; YAML-parse the content between them. If multiple envelopes appear (e.g., after retry loops), the LAST envelope is authoritative.

Simple bash extraction:
```bash
sed -n '/<handoff>/,/<\/handoff>/p' .omc/<artifact> | sed '1d;$d'
```

Future `omc` CLI may add `omc handoff <artifact>` for structured extraction.
