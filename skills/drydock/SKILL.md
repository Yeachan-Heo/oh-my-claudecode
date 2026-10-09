---
name: drydock
description: Lay the keel of the shipyard harness in any repo — the 4-pillar shared environment (Context, Rules, Tools, Standards), seeded as two faces on day one (CLAUDE.md + CONTEXT.md) with every other surface appearing on first use, so that every human and agent inherits the same design language and anyone can ship. Run once per repo; re-run with --check to audit drift.
argument-hint: "[--check]"
level: 3
---

# Drydock

Lay the keel of the **shipyard**: one repo, one shared harness, every contributor inherits it. This skill seeds the environment that turns "everyone ships" into "everyone ships on the same design language" — it writes exactly two faces (CLAUDE.md and CONTEXT.md), defines the first-use moment when every other surface appears, wires the flows that fill them (launch writes CONTEXT/ADR; the launch C5 sediment pass and reviews sediment standards), and reports what was seeded, what is deferred and why, and what was skipped on purpose.

The four pillars and where they physically live:

| Pillar | Surfaces |
|---|---|
| Context (shared background) | `CONTEXT.md` (glossary) + `docs/business/` + `docs/adr/` + OMC wiki |
| Rules (boundaries) | `CLAUDE.md` (thin entry: conventions, principles, index) + `docs/standards/` |
| Tools (composable capability) | `.omc/skills/` + `.mcp.json` + `scripts/` |
| Standards (the classification society) | `design-system/` (tokens, components, patterns) + `docs/standards/` |

Metaphor map: the shipyard is the shared facility; the classification society (`docs/standards/` + `design-system/`) sets the rules a ship must pass to be seaworthy; drydock lays the keel; launch ships it.

## When to Use

- starting a repo that humans and agents will both build on
- a repo where knowledge lives in people's heads and chat history instead of files
- onboarding: a new teammate or agent should inherit context by reading, not by asking

## When Not to Use

- throwaway prototypes with no collaborators
- a repo already running this harness (use `--check` instead)

## Workflow

### 1. Detect (never clobber)

Inventory what exists before writing anything:

- `CLAUDE.md` present? `AGENTS.md` present? (rule: if either exists, extend it in place; create the missing one as a one-line pointer to the other; **never create both fresh**)
- `CONTEXT.md`, `docs/adr/`, `docs/standards/`, `docs/business/`, `design-system/`, `.omc/skills/`, `.mcp.json`, `scripts/`, `.gitattributes` — which exist (adopted — their integrity is audited), which are absent (not adopted — each gets its first-use trigger below, never a speculative creation)?
- OMC installed? — only worth checking when running inside an OMC session; outside one, skip this check silently (the harness works with or without OMC)

Report the map first, then act.

### 2. Resolve document language, then ask only what detection cannot answer

The document language for the generated harness files is a file-backed decision, not conversation state. Use this contract exactly:

<!-- shipyard-document-language-contract:start -->
```json
{
  "schemaVersion": 1,
  "authority": { "path": "CONTEXT.md", "frontmatterKey": "documentLanguage" },
  "canonicalSources": ["CLAUDE.md", "README.md"],
  "askOn": ["missing", "mixed", "conflict", "low-confidence", "invalid-explicit", "script-ambiguous"],
  "tagPattern": "^[a-z]{2,3}(?:-[A-Z][a-z]{3})?(?:-(?:[A-Z]{2}|[0-9]{3}))?$",
  "scriptVariants": ["zh-Hans", "zh-Hant"],
  "seedCompanionPrefixes": { "en": "en", "zh-Hans": "zh-Hans", "zh-Hant": "zh-Hant" },
  "stableTokens": [
    "CONTEXT.md", "documentLanguage", "/oh-my-claudecode:launch", "--serial",
    "plan", "execute", "review", "verify", "blockedBy", "blocked_by",
    "pending", "in_progress", "completed", "failed", "ready-for-agent",
    "id", "name", "description", "triggers", "mcpServers", "```",
    "<Project>", "<term>", "<feature-slug>"
  ]
}
```
<!-- shipyard-document-language-contract:end -->

Resolution order:

1. An explicit human choice in the current invocation wins when valid. Normalize it to a stable BCP-47-style tag: lowercase language, Title-Case script, uppercase region. Invalid explicit input must be asked once rather than guessed.
2. Otherwise, read `documentLanguage` from the YAML frontmatter at the top of `CONTEXT.md`. A valid, script-unambiguous tag is authoritative for fresh Drydock and Launch invocations. If the persisted tag is bare or region-only Chinese, ask once at this authority tier; never bypass it with source inference.
3. If the marker is absent or invalid, inspect canonical sources in this order: `CLAUDE.md`, then `README.md`. Infer only when every usable source has one unambiguous dominant language and all usable sources agree on the same normalized tag. One unambiguous source is sufficient when the other is missing or empty.
4. Chinese must resolve to an explicit script-qualified tag: `zh-Hans` or `zh-Hant` (optionally followed by a region). Bare `zh` and region-only Chinese tags are script-ambiguous and must be asked once rather than selecting a companion. Companion selection uses the longest language/script prefix: `zh-Hans-*` selects the `zh-Hans` companion and `zh-Hant-*` selects `zh-Hant`; preserve the full normalized tag (for example `zh-Hans-CN`) in `CONTEXT.md`.
5. Missing usable sources, mixed-language content, conflicting tags, low-confidence inference, invalid explicit input, or script-ambiguous Chinese must trigger one batched language question. Do not guess. If no answer is available, stop before writing localized artifacts.
6. Before scaffolding, write the resolved tag to the exact stable frontmatter key `documentLanguage` in `CONTEXT.md` (creating or extending its frontmatter without translating the key). This visible file is the init report's language authority; no daemon, hidden ledger, or runtime state is created.

Only prose and human-facing labels/localizable values follow the selected language; structural keys stay language-stable. Keep paths, slash commands, flags, code fences, placeholders, frontmatter keys and machine-semantic values, YAML/JSON keys, lifecycle tokens, status enums, IDs, `blockedBy`, public Team `blocked_by`, and parser/control tokens byte-for-byte stable.

Ask the remaining questions only after language is resolved:

- package/tech stack (for standards and design-system seeds)
- does this repo have a UI? (informational only — `design-system/` follows the same deferred-surface rule as everything else: it is created when the first UI token or component contract is worth reusing, never as a stub)
- issue tracker location (GitHub — V1 supports GitHub only, no local fallback) — also record the maintainer's communication authority for intake (issue comments, label changes) — consumed by the navigator's map home and the harbor's intake queue

### 3. Scaffold (seed the two faces — seeds render in the document language)

Drydock writes exactly two faces on day one:

```
CLAUDE.md                      # thin entry — see seed A
CONTEXT.md                     # glossary and language authority — see seed B
```

**Every other surface is deferred: it appears on first use, never speculatively.** A surface exists to hold something; it is created the first time that something actually happens, seeded with the matching exemplar below. A file created with no first use behind it is session content pretending to be a repository surface:

| Surface | Appears when |
|---|---|
| `docs/adr/` | the first load-bearing decision settles — write ADR-0001 at that moment (adopting the harness is the natural first entry) |
| `docs/standards/` | the first checkable rule is sedimented — a launch C5 sediment pass or a review correction that repeats (seeds C / C2) |
| `docs/business/` | the first business rule or background article must outlive the conversation (seed D) |
| `design-system/` | the first UI token or component contract is worth reusing — UI repos only (seed E) |
| `.omc/skills/` | the first reusable capability passes the skillify gate (seed F) |
| `scripts/` | the first automation is needed more than once |
| `.mcp.json` | the first tool integration is actually wired (seed: `{"mcpServers": {}}` — servers get added when a tool integration is actually needed, not speculatively) |
| `.gitattributes` | the repo first hits line-ending churn (seed: `* text=auto eol=lf` — kills CRLF warning noise on Windows) |
| yard audit script (`scripts/shipyard-audit.mjs`) | the governance loop is first exercised — a launch yard gate or `--check` drift audit needs the mechanical half; seed it at that moment |

Seed exemplars are reference companions, never a combined payload. Select exactly one companion after resolving `documentLanguage`; do not emit duplicate headings or labels from another companion. Use the longest matching language/script prefix: `en-*` uses English, `zh-Hans-*` uses Simplified Chinese, and `zh-Hant-*` uses Traditional Chinese, while Seed B writes the full resolved tag into `documentLanguage`. For any other valid tag, translate the English canonical companion once while preserving every stable token above. Seeds A and B are written now; seeds C–F wait for their surface's first-use trigger and render in the document language when that moment comes.

Before generating seed prose, call the Skill tool with `agent-doc-discipline` and apply its rules; seed prose is ready only when every rule is checkable and carries a why, every surface is self-describing without chat history, and sources are named rather than assumed. A teammate or agent should be able to act on the seed's content by reading alone.

Seed A — CLAUDE.md, en (thin entry; extend in place if the file exists):

<!-- shipyard-seed-a:en:start -->
```markdown
# <Project> — Agent & Human Shipyard

## Project conventions
- <language/framework/package manager/naming — list what matters, skip the rest>

## Architecture principles
- <the 3-5 principles most often violated in this project>

## Shared background
- Glossary: CONTEXT.md

## Agent guide
- Delivery follows the canonical workflow plan → execute → review → verify; `/oh-my-claudecode:launch` is an optional governed delivery pipeline (opt-in, invoke explicitly)
- On term conflicts CONTEXT.md wins; new terms are recorded the moment they settle
- When a deferred surface first appears (standards, decision records, business knowledge, project skills, the design system), it gets an index section here at the moment it is created — never before
```
<!-- shipyard-seed-a:en:end -->

Seed A — zh-Hans companion (结构一致，二选一按文档语言渲染):

<!-- shipyard-seed-a:zh-Hans:start -->
```markdown
# <Project> — Agent & Human Shipyard

## 项目约定
- <language/framework/package manager/naming — list what matters, skip the rest>

## 架构原则
- <the 3-5 principles most often violated in this project>

## 共享背景
- 术语: CONTEXT.md

## Agent 指南
- 交付遵循 canonical 工作流 plan → execute → review → verify；`/oh-my-claudecode:launch` 是可选的受治理交付管道（opt-in，需要时显式调用）
- 术语冲突以 CONTEXT.md 为准；新术语当场补录
- 延后面首次出现时（规范、决策记录、业务知识、项目技能、设计系统），在创建的当下于此补一段索引——绝不提前
```
<!-- shipyard-seed-a:zh-Hans:end -->

Seed A — zh-Hant companion（結構一致，只渲染此版本）:

<!-- shipyard-seed-a:zh-Hant:start -->
```markdown
# <Project> — Agent & Human Shipyard

## 專案約定
- <language/framework/package manager/naming — list what matters, skip the rest>

## 架構原則
- <the 3-5 principles most often violated in this project>

## 共享背景
- 詞彙: CONTEXT.md

## Agent 指南
- 交付遵循 canonical 工作流 plan → execute → review → verify；`/oh-my-claudecode:launch` 是可選的治理交付管道（opt-in，必須明確呼叫）
- 術語衝突以 CONTEXT.md 為準；新術語確定時立即補錄
- 延後面首次出現時（規範、決策記錄、業務知識、專案技能、設計系統），在建立時於此補一段索引——絕不提前
```
<!-- shipyard-seed-a:zh-Hant:end -->

Seed B — CONTEXT.md (the stable frontmatter key is the language authority):

en:

<!-- shipyard-seed-b:en:start -->
```markdown
---
documentLanguage: en
---

# Glossary

One entry per term: definition, boundaries, one resolved ambiguity. Agents write here the moment a term is settled. Vocabulary here is law for all specs, tickets, and code naming. Ship-specific terms only: a concept any sea chart carries does not get an entry.

## <term>
- Definition:
- Boundary: (is X, not Y)
- Avoid: (near-synonyms this ship does not use)
- Resolved ambiguity:
```
<!-- shipyard-seed-b:en:end -->

zh-Hans:

<!-- shipyard-seed-b:zh-Hans:start -->
```markdown
---
documentLanguage: zh-Hans
---

# 术语表

一条术语一个条目：定义、边界、一个已解决的歧义。术语敲定的当下写入。词汇对所有 spec、ticket、代码命名具有法律效力。只收本船特有的词；海图上都有的通用词不立条目。

## <term>
- 定义:
- 边界: （是 X，不是 Y）
- 禁用: （本船不用的近义词）
- 已解决的歧义:
```
<!-- shipyard-seed-b:zh-Hans:end -->

zh-Hant:

<!-- shipyard-seed-b:zh-Hant:start -->
```markdown
---
documentLanguage: zh-Hant
---

# 詞彙表

每個術語一個條目：定義、邊界、一個已解決的歧義。術語確定時立即寫入。這裡的詞彙是所有 spec、ticket 與程式碼命名的準則。只收本船特有的詞；海圖上都有的通用詞不立條目。

## <term>
- 定義:
- 邊界: （是 X，不是 Y）
- 禁用: （本船不用的近義詞）
- 已解決的歧義:
```
<!-- shipyard-seed-b:zh-Hant:end -->

Seed C — docs/standards/architecture.md (data.md same shape; process.md additionally seeds a Testing volume — see Seed C2; prose renders in the document language):

```markdown
# Architecture Standards

Rule-shaped, checkable writing; every rule carries a "why". Empty sections are legal — sediment is gradual.

## Module boundaries
## Error handling
## Dependency direction
## Seams and depth

- A seam is a real boundary two modules already cross in both directions. One adapter is a hypothetical seam; two adapters make it real. (Checkable: count the callers. Why: speculative abstraction is a tax paid before the need exists.)
- A deep module puts much behavior behind a small interface; deepen before widening. (Why: the interface is the permanent tax.)
- Logic lives behind the seam that owns its data; stable dependencies point inward. (Why: logic that reaches across a boundary it does not own couples every caller to the wrong neighbor.)
```

Seed C2 — docs/standards/process.md, Testing volume (rendered when the repo tests code; prose renders in the document language):

```markdown
## Testing

- Tests enter through the interface only: assert observable behavior at the seam. Reaching past the seam — querying the store directly, reading internal state — is false confidence. (Why: a test that survives refactors describes behavior, not plumbing.)
- Expected values come from an independent source of truth: a known-good literal or a worked example from the spec. (Why: a test that recomputes its expectation the way the code does can never disagree with the code.)
- One slice at a time: one failing test, one minimal implementation, repeat. Bulk-writing all tests first tests the imagination, not the behavior. (Why: the loop is a feedback engine; batching cuts the feedback.)
- Refactoring happens at the review axis, not inside the red-green loop. (Why: the loop answers "is the behavior right"; mixing redesign in hides regressions.)
- Tests open only at seams the reviewing captain approved. (Why: unapproved seams spend effort where the risk is not.)
```

Seed D — docs/business/README.md:

```markdown
# Business Knowledge

Decision background and business rules. Format suggestion: one article answers one business question, opening paragraph states why it matters.
A new teammate (human or agent) reading this directory should be able to answer "why does this product direction exist".
```

Seed E — design-system/README.md:

```markdown
# Design System

## tokens/    Design tokens (colors/type/spacing, machine-readable JSON preferred)
## components/ Component contracts (purpose, variants, misuse)
## patterns/  Interaction patterns (forms, feedback, loading, empty states — sediment reused patterns)
```

Seed F — .omc/skills/README.md:

````markdown
# Project Skills

Reusable capabilities sedimented by this project: specialized tools, prompt templates, specialized practices.
One skill per file `.omc/skills/<name>.md`, frontmatter must contain a stable ASCII `id` plus name + description +
**non-empty triggers** (loader validation hard requirement: missing or empty means the skill is never loaded):

```markdown
---
id: project-release-check
name: project-release-check
description: Apply this repository's release readiness rules
triggers:
  - "project release check"
---

# Project Release Check

Follow the repository-specific release checklist and report evidence.
```
The literal YAML keys `id`, `name`, `description`, and `triggers` never localize. `id` and other machine-semantic values stay ASCII and stable; the scalar display values for `name`, `description`, and `triggers`, plus Markdown headings and prose, may localize. A non-Latin display name remains loadable because the explicit ASCII `id` is stable.
Bar for admission matches skillify: if it can be Googled in 5 minutes it is not a skill;
write "this project's specific decision discipline", not generic tutorials.
````

**Destructive-operation guardrail preset.** On request, drydock seeds a hook preset that blocks destructive git operations — push, force-push, hard reset, clean, and branch deletion — behind explicit approval. It is installed as ordinary, inspectable repo config (a hooks entry the repo can read and audit — the same place the repo's other hooks live, e.g. the agent harness's settings hooks or a git pre-push hook), never a hidden enforcement layer: the rules are listed in the report, and removing the entry is an explicit human act. The preset protects the laid harness, not the agent — no agent session can end the repo's history by accident. Seed shape:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "command": "<confirm-before-destructive-git>",
        "description": "Block push, force-push, reset --hard, clean, and branch -D behind explicit approval"
      }
    ]
  }
}
```

The matcher and command are the repo's own choice of hook mechanism — drydock seeds the shape and the rule list, and the confirmation command lives in the Tools pillar (`scripts/`) where the repo can read and audit it.

**Commit-time quality gate preset.** On request, drydock also seeds a commit-time hook preset that runs the repo's own checks before a commit lands — lint, typecheck, and the test suite, each wired to whatever entrypoints the repo already has (the Tools pillar's `scripts/`, the package manager's standard commands). Same shape as the guardrail preset: ordinary, inspectable repo config, listed in the report, removable only by an explicit human act. The gates are the repo's existing checks wired to the commit boundary — drydock adds no new checker of its own, and a repo without established check commands gets the scaffold with the commands left for the humans to name.

### 4. Wire the governance loop (this is what makes it a shipyard, not a folder)

Tell the user, and rely on these flows to fill the faces (each flow also carries the first-use trigger for the surface it fills):

- **launch** writes CONTEXT.md vocabulary as terms settle, creates docs/adr/ when the first load-bearing decision lands, and docs/business/ when the first business article must outlive the conversation (paper trail)
- **launch C5 sediment / code-review** sediment recurring corrections into docs/standards/ (created with the first sedimented rule) and CLAUDE.md principles
- **anyone** can add a project skill to .omc/skills/ (created with the first skill) — the barrier is the skillify quality gate, not permission
- **wiki** (OMC) compounds session knowledge; promote anything referenced twice into docs/business/ (created with the first promoted article)

The rule that keeps 先动手 aligned: **starting needs no permission; landing goes into a shipyard slot.** A change that cannot say which slot it lands in (or explicitly none) is the smell.

### 5. Report

- seeded (the two faces) / extended / deferred (each with its first-use trigger) / deliberately skipped (each with why)
- resolved document language as `CONTEXT.md` frontmatter `documentLanguage: <tag>`, including whether it came from explicit choice, the persisted marker, or unanimous inference
- the next human content the two seeded faces need (usually CLAUDE.md conventions and CONTEXT.md first terms)
- reminder: re-run with `--check` any time to see drift between filesystem and harness

## `--check` mode

Diff actual repo state against the shipyard map; report integrity findings on adopted surfaces only (an absent surface is not adopted, not missing), a missing or invalid `CONTEXT.md` frontmatter `documentLanguage` tag, CLAUDE.md sections that point at dead paths, CONTEXT.md terms unused in code, and standards never referenced. For each finding, state the confidence (`high` when mechanically checkable, `low` when heuristic) and whether it is actionable after excluding throwaway/scratch repositories explicitly declared by the user. Launch's yard gate treats high-confidence actionable findings as blocking; low-confidence or explicitly-classified false-positive findings, and findings in a user-declared scratch/throwaway scope, may be overridden only with deliberate per-invocation intent (see `/oh-my-claudecode:launch`). `/oh-my-claudecode:ask-navigator` may also run this audit in report-only mode while charting a foggy effort: findings are recorded verbatim in the map's Notes (never swallowed) and remain live findings for the launch yard gate.

**The structured exit contract.** The mechanical subset of this audit is executable: `node scripts/shipyard-audit.mjs [repoRoot]` checks the high-confidence classes only — a missing/invalid `documentLanguage` tag, dead paths in `CLAUDE.md`, project-skill triggers present, and intent statuses within the documented vocabulary — and emits JSON on stdout (human summary on stderr) in the same finding vocabulary the lookout CLI uses: `severity` (high/medium/low/info), `confidence` (high/low), `actionable`, plus a stable finding id, evidence, and advice. Exit code 0 = clean, 1 = high-confidence actionable findings present, 2 = invocation error. The heuristic classes (terms unused in code, standards never referenced) stay in this prose layer by design — they are `low`-confidence by construction and the script never invents findings it cannot verify mechanically. Read-only.
