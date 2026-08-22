# Epic #3698: Lightweight workflow, skill consolidation, prompt and hook SSOT

**Status:** planning-only architecture contract; no runtime behavior changes in this PR
**Owner:** Yeachan-Heo / 허예찬
**Base measured:** `origin/dev` / `05c800f40d1ad53b42a78609d2667ef4f726808b` (2026-08-12)
**Planning head verified:** updated on each pushed fix-forward commit (PR #3701); the seed census and durable graph ownership remain distinct.
**Epic:** [#3698](https://github.com/Yeachan-Heo/oh-my-claudecode/issues/3698)

## 1. Scope and non-goals

This document is the implementation contract for the epic. It maps the shipped workflow surface, chooses a lightweight target architecture, and orders reversible child changes. It intentionally does **not** delete skills, change hook behavior, weaken security/release boundaries, publish packages, or mutate protected branches.

The owner’s objective is authoritative: one obvious routine path; hard gates only for irreversible risk; one canonical source with deterministic projections; bounded compatibility; measurable deletion; and no big-bang rewrite.

## 2. Evidence and reproducibility

The baseline issue body is the authoritative product brief. Local executable evidence was collected at the exact base above:

| Surface | Public/entrypoint baseline | Internal/file baseline | Measurement |
|---|---:|---:|---|
| Skills | 41 `skills/*/SKILL.md` | 41 directories | `find skills -mindepth 2 -maxdepth 2 -name SKILL.md` |
| Commands | 28 `commands/*.md` | 28 files | `find commands -maxdepth 1 -name '*.md'` |
| Hooks | not equal to modules | 294 files under `src/hooks/` (292 matched source files) | `find src/hooks -type f` |
| Workflows | 8 `.github/workflows/*` | 8 files | `find .github/workflows -type f` |
| Agents | 18 TypeScript definitions | 18 files | `find src/agents -maxdepth 1 -name '*.ts'` |
| Prompt-like sources | not a public count | 244 markdown files in repository | inventory script; classify sources vs projections |

Run the reproducible inventory (it excludes `.git`, `node_modules`, `dist`, and coverage):

```sh
node scripts/inventory-issue-3698.mjs > /tmp/issue-3698-inventory.json
```

The JSON contains sorted seed paths, public names, counts, base SHA, planning head, and an inventory SHA-256. This script is reproducible baseline/seed census evidence, not the final exhaustive dependency graph. #3702 owns the durable generated graph/manifest and ongoing drift enforcement. Every future measurement MUST report public surfaces separately from implementation modules and generated projections; a reduction in files alone is not a product reduction.

### External comparison evidence

Current Gajae-Code guidance describes a deliberately small default workflow and role-agent set, with optional tools kept outside the default path. Its README states plan-before-mutation, evidence-backed execution, structural summaries, durable `.gjc` state, and token-conscious context handling. This plan reuses those principles, not Rust/Bun implementation details.

Sources: [Gajae README](https://raw.githubusercontent.com/Yeachan-Heo/gajae-code/main/README.md), [Gajae AGENTS.md](https://raw.githubusercontent.com/Yeachan-Heo/gajae-code/main/AGENTS.md).

### Census corrections and prompt evidence

The current runtime census is more precise than the issue’s initial public counts: the plugin manifest exposes 41 skill directories, runtime tests distinguish 37 canonical skills plus four aliases, and `src/agents/definitions.ts` contains 19 keys. Marketplace/documentation counts are stale projections and must not drive deletion. Prompt SSOT is partial today: `docs/CLAUDE.md` is the coordinator source projected to root and `.github/CLAUDE.md`, while `src/agents/utils.ts` loads `agents/*.md` with a generated fallback; inline `omcSystemPrompt`, `prompt-sections/index.ts`, and role markdown repeat policy. Autopilot stage prompts also have generated copies under `scripts/lib` and `templates/hooks`. Current CLAUDE projections carry divergent version markers (root 4.15.10, docs 4.8.2, `.github` 4.9.1), proving projection drift. Coordinator setup already has a SHA-256/engine-version handshake and transactional backup/rollback in `src/cli/claude-md-coordinator.ts`, `scripts/build-claude-md-coordinator.mjs`, `scripts/setup-claude-md.sh`, and `src/installer/claude-md-transaction.ts`; the target should extend this provenance model rather than invent a second one.

## 3. Current architecture map

### 3.1 Public surface and routing

`skills/*/SKILL.md` is the public workflow catalog. `commands/*.md` is the command catalog. Runtime loading is additionally authoritative in `src/features/builtin-skills/skills.ts` and `src/commands/index.ts`; the plugin manifest currently exposes 41 skill directories while runtime tests distinguish 37 canonical entries plus 4 aliases. `src/agents/definitions.ts` currently defines 19 keys (including `document-specialist` compatibility), while role routing preserves additional deprecated aliases in `src/agents/types.ts`. Installation and generated projections are driven by `package.json` build scripts and `scripts/build-*.mjs`; repository copies include `CLAUDE.md`, `.github/CLAUDE.md`, `docs/CLAUDE.md`, agent/command/skill text, and generated coordinator/stage artifacts.

The current surface has overlapping execution modes (`autopilot`, `ralph`, `ultrawork`, `ultrapilot`, `swarm`, `pipeline`, `team`, `ultraqa`), planning modes (`plan`, `ralplan`, `deep-interview`), review/verification modes (`merge-readiness`, `verify`, `visual-verdict`, `ai-slop-cleaner`), setup/utility skills, and multiple aliases/wrappers. Keyword detection and installed command metadata route into these surfaces; hook state maintains mode continuity across turns.

### 3.2 Hook and state topology

`src/hooks/bridge.ts` is the TypeScript routing bridge. Hook registration currently spans 12 lifecycle surfaces in `hooks/hooks.json`, with fanout across UserPromptSubmit, SessionStart, PostToolUse, Stop, and PreCompact among others. Hook families include mode activation/persistence, validation, recovery, enhancement, keyword detection, permission handling, project memory, merge-readiness, and session cleanup. `templates/hooks/*.mjs` are installed hook entrypoints; `scripts/hooks.json`/plugin setup registers them. State and lock helpers are spread across hook families and shared scripts, with bounded subprocess timeouts and cleanup/orphan paths. The relevant design risk is not raw file count: multiple entrypoints can perform overlapping pre/post/session work and each may read/write state or add a gate. `context-safety.mjs` is intentionally permissive, while `context-guard-stop.mjs` is fail-open and capped; these semantics require parity tests before consolidation.

### 3.3 CI and gate topology

Eight workflows currently cover CI, PR checks, release, upgrade tests, stale/labels/cleanup, and generated-artifact authorization. Gate-like code includes persistent-mode/continuation checks, merge-readiness, prompt prerequisites, task-size routing, skill state, generated-artifact authorization, release-boundary checks, exact-head evidence, and duplicated build/shipping closure. Release and secret/privacy/corruption checks are distinct from ceremony gates and must not be removed by this epic without owner approval.

### 3.4 Dependency/call graph (planning-level)

```text
user text / slash command
  -> installed hook registration
  -> keyword detector / command resolver
  -> canonical workflow descriptor (target state)
  -> prompt composer + role-agent registry
  -> executor / optional team workers
  -> state + ledger + evidence
  -> advisory review or irreversible-risk gate
  -> generated projections / package install

current paths:
  templates/hooks/* -> scripts/plugin-setup.mjs -> hooks/hooks.json
  src/hooks/bridge.ts -> src/hooks/* handlers -> state/lock/cleanup helpers
  skills/* + commands/* -> prompt/keyword routing -> mode hooks
  src/agents/definitions.ts + prompt-sections/* -> generated coordinator/stage artifacts
  scripts/build-*.mjs + compose-docs.mjs -> dist/bridge/docs/CLAUDE projections
  .github/workflows/* -> scripts/release-boundary.mjs / generated-artifact authorization / tests
```

The first implementation child must replace this prose graph with generated edges from registries/imports and a registration-drift check.

## 4. Classification contract

### 4.1 Classification meanings

* **Keep:** canonical public surface with a unique contract and direct tests.
* **Merge into X:** behavior moves to canonical X; old name remains only as a bounded alias during migration.
* **Alias-deprecate:** compatibility wrapper with warning, owner, telemetry, and removal milestone; no second implementation.
* **Delete:** no public contract or duplicate ceremony, removed only after proof and migration window.

Compatibility owner for all public workflow aliases is the workflow registry owner (initially the maintainers of `src/hooks/bridge.ts`, `skills/`, and `commands/`); each child issue must name a code owner and release target. Warning mechanism is a single structured deprecation event emitted by the resolver, rendered once per session, and counted without blocking execution.

### 4.2 Every public skill (41)

| Surface | Decision | Target / proof |
|---|---|---|
| `plan` (absorbs `deep-interview` + `ralplan`) | Keep as Tier-0 canonical | requirements/plan contract; approval boundary tests |
| `execute` (absorbs `ultragoal`, `autopilot`, `ralph`, `ultrawork`, `ultrapilot`, `swarm`, `pipeline`, optional `team`) | Keep as Tier-0 canonical | execution/state/evidence contract |
| `review` (absorbs review routing) | Keep as Tier-0 canonical | review contract and risk classification tests |
| `verify` (absorbs `ultraqa`/verification routing) | Keep as Tier-0 canonical | verification/evidence tests |
| `planner` role | Keep Tier-0 role | sequencing/handoff |
| `executor` role | Keep Tier-0 role | implementation lane contract |
| `reviewer` role (maps current reviewer/code-reviewer/architect/critic specialists) | Keep Tier-0 role | read-only review |
| `verifier` role (maps current verifier/qa specialists) | Keep Tier-0 role | completion evidence |
| `autopilot` | Merge into Tier-0 `execute` | alias through migration window; activation parity |
| `ralph` | Merge into `ultragoal` continuation/evidence | alias + warning; persistence tests |
| `ultrawork` | Merge into optional `team` | alias + warning; parallelism parity |
| `ultrapilot` | Merge into optional `team` + `ultragoal` | alias; ownership/rollback tests |
| `swarm` | Merge into optional `team` | alias; worker lifecycle tests |
| `pipeline` | Merge into `ultragoal` stages | alias; state transition tests |
| `ultraqa` | Merge into verification lane of `ultragoal` | alias; QA-cycle tests |
| `plan` | Alias-deprecate to `ralplan` | warning and two-release removal |
| `verify` | Merge into advisory/terminal verification lane | parity and failure mapping |
| `merge-readiness` | Merge into advisory review; retain release hard checks separately | no duplicate merge gate |
| `ai-slop-cleaner` | Keep as opt-in review tool; not default gate | changed-file report tests |
| `visual-verdict` | Keep opt-in for visual surfaces | screenshot/verdict tests |
| `deep-dive` | Merge into `deep-interview` or research lane | alias; transcript parity |
| `sciomc` | Merge into optional research lane | alias; artifact tests |
| `autoresearch` | Merge into optional research lane | alias; artifact tests |
| `external-context` | Keep opt-in tool | external evidence contract |
| `ccg` | Alias-deprecate to `team`/`executor` based on task shape | resolver mapping |
| `project-session-manager` | Keep utility, remove workflow-gate behavior | state path tests |
| `local-build-reminder` | Delete as ceremony-only hook/skill | telemetry shows no irreversible risk; replacement docs |
| `cancel` | Keep lifecycle utility | cancellation/state cleanup tests |
| `ask` | Keep interaction utility | question protocol tests |
| `skill` | Keep discovery utility | resolution tests |
| `skillify` | Keep authoring utility, not runtime workflow | package/install tests |
| `setup` | Merge into `omc-setup` | one setup contract |
| `omc-setup` | Keep canonical setup | install smoke tests |
| `mcp-setup` | Merge into `omc-setup` subcommand | compatibility mapping |
| `omc-doctor` | Keep diagnostics utility | read-only diagnostics tests |
| `omc-reference` | Merge into `wiki`/docs reference | link and output tests |
| `wiki` | Keep docs/reference utility | link tests |
| `omc-teams` | Merge into `team` | alias and help parity |
| `remember` | Keep memory utility | state scope tests |
| `learner` | Merge into memory utility | alias and migration docs |
| `writer-memory` | Merge into memory utility | alias and migration docs |
| `configure-notifications` | Keep opt-in integration utility | secrets/privacy tests |
| `release` | Alias-deprecate to maintainer-only `omc release` authority | no release/tag/publish mutation in this epic; hard release boundary tests |

The table is intentionally explicit even where the final implementation owner may refine a mapping. No removal is authorized by this planning PR. The implementation issue must attach invocation counts and compatibility proof before changing a row.

### 4.3 Every public command (28)

| Command | Decision | Target |
|---|---|---|
| `ask` | Keep | interaction utility |
| `autoresearch` | Alias-deprecate | research lane |
| `ccg` | Alias-deprecate | team/executor resolver |
| `compact` | Keep | host/session utility |
| `configure-notifications` | Keep | notification utility |
| `debug` | Keep | diagnostics utility |
| `deep-dive` | Alias-deprecate | deep-interview/research |
| `deepinit` | Keep | repository guidance utility |
| `external-context` | Keep | evidence utility |
| `hud` | Keep | display utility |
| `learner` | Alias-deprecate | memory |
| `mcp-setup` | Alias-deprecate | omc-setup |
| `omc-doctor` | Keep | diagnostics |
| `omc-setup` | Keep | canonical setup |
| `omc-teams` | Alias-deprecate | team |
| `project-session-manager` | Keep | session utility |
| `psm` | Alias-deprecate | project-session-manager |
| `release` | Alias-deprecate | maintainer-only `omc release` authority; no mutation in this epic |
| `remember` | Keep | memory |
| `sciomc` | Alias-deprecate | research |
| `self-improve` | Keep opt-in | learning utility |
| `skill` | Keep | discovery |
| `skillify` | Keep | authoring |
| `trace` | Keep | evidence/diagnostics |
| `verify` | Alias-deprecate | verification lane |
| `visual-verdict` | Keep opt-in | visual QA |
| `wiki` | Keep | docs/reference |
| `writer-memory` | Alias-deprecate | memory |

Command aliases must resolve to one implementation and emit one concise, actionable warning per session by default; diagnostics retain full mapping and telemetry, with a temporary automation-noise opt-out. Removal requires at least two minor releases and 90 days (whichever is longer), ≥95% canonical-use share over two consecutive releases, and zero known critical integrations; otherwise extend. Tier-0 names are exactly `plan`, `execute`, `review`, and `verify`. `release` is not a general public workflow and remains only as a compatibility alias to maintainer-only `omc release`.

## 5. Workflow gate taxonomy

| Gate family | Target | Risk evidence / simplification |
|---|---|---|
| Security, secrets, privacy, permission boundary | Retain-hard | irreversible disclosure or unauthorized mutation |
| Destructive mutation/corruption protection | Retain-hard | data loss or unrecoverable state |
| Release/tag/npm/protected-main authority and exact-head provenance | Retain-hard | public artifact and supply-chain impact |
| Generated-artifact authorization | Retain-hard but unify | provenance is real; one deterministic verifier replaces duplicated closure |
| Lock ownership, timeout, orphan cleanup | Retain-hard in dispatcher | concurrent state corruption; bounded and auditable |
| Plan-before-mutation for ambiguous/high-risk work | Advisory by default; hard only for configured risk | routine work should not be trapped in approval ceremony |
| Persistent-mode continuation / stop blocking | Merge into ultragoal state; advisory | duplicate continuation decisions and context traps |
| Merge-readiness plus duplicate PR/CI evidence | Merge into one advisory review | same acceptance repeated; branch protection remains hard |
| Prompt prerequisites/task-size routing | Advisory | heuristic routing cannot prove irreversible risk |
| Skill-state and mode stacking prerequisites | Delete/merge | ceremony and duplicated state checks |
| Candidate/base double-gates | Merge | deterministic exact-head/provenance check is sufficient |
| Build/shipping closure duplicates | Merge into canonical build/package verifier | same artifact closure checked several times |
| Generic local build reminders | Delete | no irreversible-risk evidence; docs/CI cover it |

Target outcome is one explicit state machine: `idle -> planning (when needed) -> executing -> verifying -> complete|blocked`, with `riskClass` selecting hard checks. Advisory checks report evidence and never prevent routine progress. Hard checks fail closed and identify the specific irreversible risk.

## 6. Target architecture

### 6.1 Canonical workflow registry

Add a versioned structured registry (proposed `src/workflow/registry.ts`, generated public metadata under `dist/` and installed `skills/`/`commands/`) containing canonical workflows, aliases, risk class, owner, warning/removal milestone, required evidence, and projection version. Resolver, keyword detector, help, docs, and tests consume this registry. A registration-drift test compares registry projections with installed files and command metadata.

Default path: `plan -> execute -> review -> verify`; optional team execution is an internal implementation detail. Utility and specialist tools remain opt-in/routable modules and do not become Tier-0 workflows.

### 6.2 Prompt SSOT

Canonical prompt source is structured sections (policy, task contract, safety, role delta, provider/model delta, output/evidence contract) stored once under `src/agents/prompt-sections/` plus a manifest describing order and required sections. Agent definitions reference section IDs rather than repeating prose. A deterministic composer emits role prompts, coordinator/stage prompts, `CLAUDE.md` projections, command/skill guidance, and package files.

Each projection includes `schemaVersion`, `sourceRevision`, and SHA-256 digest of normalized canonical sections. Build fails on stale projections. Provider/model differences are data (`providerDelta`, `modelTierDelta`), not copied policy paragraphs. Install writes only generated projections and records the digest; runtime reports source/projection mismatch without blocking routine work. Rollback selects the prior manifest/digest and regenerates projections.

Measurement: tokenize normalized canonical and projected prompts; report total tokens, unique n-grams, repeated-clause ratio, and source-to-projection drift. Target after phase 2: 35–50% fewer repeated policy tokens, <5% projection drift, and one owner for every normative clause.

### 6.3 Hook SSOT/dispatcher

Create one registry of `{event, priority, riskClass, timeoutMs, stateReads, stateWrites, cleanupOwner, failMode}`. One dispatcher parses the event once, runs only applicable modules, emits structured timing/error records, and owns state/lock/cleanup lifecycle. Modules are pure-ish handlers with explicit contracts; no module registers itself through a second path.

Synchronous hot path budget: p95 <= 50 ms for no-op events, p95 <= 200 ms for ordinary advisory events, and no unbounded child process. Inner git/process calls remain below runner timeout. Advisory errors fail-open with a visible diagnostic; hard boundary errors fail-closed. Cleanup is idempotent and owned by session-end/dispatcher, not duplicated by mode hooks. Registration drift is tested from the registry against `hooks.json` and templates.

Targets: reduce active hook entrypoints by 40–60%, internal hook modules by 25–40% after dedupe, state roots/registries by 50–70%, and duplicated cleanup owners to one per lifecycle.

## 7. Quantitative targets and acceptance metrics

Targets are ranges, not automatic deletion quotas:

| Metric (public vs internal explicitly separated) | Baseline | Target after approved child issues |
|---|---:|---:|
| Primary workflow skills | 41 shipped (37 canonical + 4 aliases in runtime census) | exactly 4 Tier-0 workflows: `plan`, `execute`, `review`, `verify`; all other skills utility, specialist module, or bounded alias |
| Command entrypoints | 28 | 12–18 canonical; aliases tracked separately |
| Hook entrypoints / active modules | 294 files / measure registry | 40–60% fewer entrypoints; 25–40% fewer modules |
| Hard workflow gates | inventory in #3702 | 50–70% fewer ceremony gates; all retained gates risk-labelled |
| Agent prompt definitions | 19 registry keys | exactly 4 Tier-0 role agents: `planner`, `executor`, `reviewer`, `verifier`; specialists remain internal/routable |
| Repeated normative prompt tokens | measure in #3704 | 35–50% reduction; <5% projection drift |
| GitHub workflows | 8 | smallest proven set; target 5, acceptable 5–6 only when permissions, triggers, or security require separation |
| State roots/registries | measure path graph | 50–70% reduction; one workflow + one hook registry |
| Generated closure burden | measure generated files/checks | 40–60% fewer independently maintained projections/checks |
| No-op hook latency | new baseline | p95 <= 50 ms; advisory p95 <= 200 ms |
| Alias migration | new telemetry | minimum two minor releases and 90 days, whichever is longer; removal requires ≥95% canonical-use share for two consecutive releases and zero known critical integrations |

Every target has a script, before/after artifact, owner, and acceptance test. Public-surface reductions are measured from manifests; internal reductions from file/module graphs; token reductions from normalized prompt digests; gate reductions from risk-labelled registry entries.

## 8. Reversible migration sequence and rollback

1. **Inventory and freeze (this PR).** Land the reproducible seed census, exhaustive public-surface classification, exact owner contract, and unresolved implementation details. The seed script is baseline evidence only; #3702 owns the durable generated graph/manifest and ongoing drift enforcement. No behavior change.
2. **Canonical manifests.** Add registry schemas, digest/version fields, and read-only projection/drift checks. Rollback: disable generated projections and retain current files.
3. **Prompt projection parity.** Generate one projection at a time; compare normalized behavior fixtures and token metrics. Rollback: select previous manifest digest.
4. **Alias resolver.** Route old names to `plan`, `execute`, `review`, or `verify` with one concise actionable warning per session by default; diagnostics retain full mapping/telemetry. Provide a temporary automation-noise opt-out. No deletion. Rollback: resolver feature flag to legacy mapping.
5. **Hook dispatcher shadow mode.** Run dispatcher observably beside current hooks, compare event/state/evidence outputs without changing decisions. Rollback: disable dispatcher registration.
6. **Dispatcher cutover.** Move one event family at a time, preserve hard risk checks, and retain old modules behind a timeboxed flag. Rollback per event family.
7. **Advisory gate reduction.** Advisory hooks fail open with bounded warning/telemetry. Hard-risk handlers fail closed only for secrets/privacy, destructive mutation, release/publish authority, proven corruption/integrity risk, and security boundaries. Unknown failures default advisory during migration and must be explicitly classified before legacy removal. Rollback by manifest version.
8. **Alias retirement and generated cleanup.** Retire only after at least two minor releases and 90 days, whichever is longer, plus ≥95% canonical-use share across two consecutive releases and zero known critical integrations; otherwise extend. Remove aliases/projections in separate PRs. Epic terminal condition requires migration receipts and no unresolved users.

## 9. Tests, observability, and release migration

Required parity tests: registry-to-installed projection; keyword/command alias resolution; one-warning-per-session; prompt digest and projection drift; normalized prompt contract fixtures; hook registration drift; event ordering; state/lock ownership; timeout/error fail-open vs fail-closed; idempotent cleanup; shadow-vs-legacy decision equivalence; release/generated-artifact provenance; package install smoke; Windows path behavior.

Telemetry is local-first and privacy-preserving: workflow start/alias use, warning count, gate decision/risk class, hook duration/error, state-root writes, projection digest, and migration fallback. Do not capture prompts, secrets, repository contents, or user text. Provide `omc-doctor`/`trace` summaries and a machine-readable migration receipt.

Existing installations receive generated projections and alias mappings through the normal package/plugin update. No compatibility removal ships in the first release. Release notes list canonical names, warnings, and removal milestone. Plugin installations verify manifest/projection digest and offer a repair command. Protected release authority remains unchanged until a separately reviewed child issue proves parity.

## 10. Ordered child issues / PRs

Create these as one coherent issue each, linked to #3698, only after this plan is reviewed:

1. **Inventory manifest and graph generator** ([#3702](https://github.com/Yeachan-Heo/oh-my-claudecode/issues/3702)) — produce the durable JSON inventories/call graph, baseline artifact, and drift tests. Depends on none; rollback is delete-only script removal.
2. **Workflow registry and compatibility policy** ([#3703](https://github.com/Yeachan-Heo/oh-my-claudecode/issues/3703)) — schema for canonical names, aliases, risk classes, owners, warnings, milestones. Depends on #3702.
3. **Prompt SSOT composer and projection digests** ([#3704](https://github.com/Yeachan-Heo/oh-my-claudecode/issues/3704)) — structured sections, manifest, deterministic projections, drift/token metrics. Depends on #3702 and #3703.
4. **Prompt projection parity and install migration** ([#3705](https://github.com/Yeachan-Heo/oh-my-claudecode/issues/3705)) — generated CLAUDE/agent/command/skill projections, package/plugin smoke and rollback. Depends on #3704.
5. **Alias resolver and telemetry** ([#3706](https://github.com/Yeachan-Heo/oh-my-claudecode/issues/3706)) — route all classified aliases, one warning/session, migration dashboard/receipt. Depends on #3703.
6. **Hook registry and dispatcher shadow mode** ([#3707](https://github.com/Yeachan-Heo/oh-my-claudecode/issues/3707)) — explicit event/state/lock/timeout/cleanup contracts, shadow comparison only. Depends on #3702 and #3703.
7. **Hook dispatcher cutover by event family** ([#3708](https://github.com/Yeachan-Heo/oh-my-claudecode/issues/3708)) — migrate pre/post/session families with latency/error budgets and rollback flags. Depends on #3707.
8. **Gate rationalization** ([#3709](https://github.com/Yeachan-Heo/oh-my-claudecode/issues/3709)) — convert/delete ceremony gates and merge duplicate evidence; retain hard risk taxonomy. Depends on #3703, #3707, and #3708.
9. **Canonical workflow UX and documentation** ([#3710](https://github.com/Yeachan-Heo/oh-my-claudecode/issues/3710)) — simplify help, commands, skills, CLAUDE projections, migration guide. Depends on #3704, #3705, #3706, and #3709.
10. **Alias retirement and generated closure cleanup** ([#3711](https://github.com/Yeachan-Heo/oh-my-claudecode/issues/3711)) — remove only proven aliases/duplicate projections after the two-release/90-day threshold and canonical-use proof. Depends on #3706 and #3710.
11. **Release/installation verification and epic closure** ([#3712](https://github.com/Yeachan-Heo/oh-my-claudecode/issues/3712)) — verify shipped metrics, migration receipts, child terminality, and remaining risk evidence. Depends on #3705, #3708, #3709, #3710, and #3711.

Each child issue must include: exact files/symbols, baseline/target metric, parity tests, owner, rollback boundary, and explicit non-goals. No child may batch unrelated implementation.

## 11. Authoritative owner decisions

The owner has resolved the six planning choices. They are now contract, not blockers:

1. Tier-0 public workflows are exactly `plan`, `execute`, `review`, and `verify`; Tier-0 roles are `planner`, `executor`, `reviewer`, and `verifier`. Specialists remain internal/routable.
2. `release` is maintainer-only `omc release`, with a compatibility alias during migration; this epic performs no release/tag/publish mutation.
3. Alias warnings are concise/actionable, visible once per session by default; diagnostics retain full mapping/telemetry; automation may temporarily opt out.
4. Alias retirement requires at least two minor releases and 90 days (whichever is longer), ≥95% canonical-use share over two consecutive releases, and zero known critical integrations; otherwise extend.
5. Workflow files reduce to the smallest proven set, targeting five and accepting six only for required permissions/triggers/security separation.
6. Advisory hooks fail open with bounded warning/telemetry. Hard-risk handlers fail closed only for secrets/privacy, destructive mutation, release/publish authority, proven corruption/integrity risk, and security boundaries. Unknown failures default advisory during migration and must be classified before legacy removal.

The planning PR is now contract-complete for implementation sequencing. Child implementation remains held until this planning PR merges and exact-head CI/provenance checks are green.
