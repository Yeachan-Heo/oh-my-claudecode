---
name: drydock
description: Lay the keel of the shipyard harness in any repo — the 4-pillar shared environment (Context, Rules, Tools, Standards) across 5 surfaces (CLAUDE.md, skills, design-system, mcp/cli, shared context) so that every human and agent inherits the same design language and anyone can ship. Run once per repo; re-run with --check to audit drift.
argument-hint: "[--check]"
level: 3
---

# Drydock

Lay the keel of the **shipyard**: one repo, one shared harness, every contributor inherits it. This skill scaffolds the environment that turns "everyone ships" into "everyone ships on the same design language" — it creates the 5 surfaces, seeds them minimally, wires them to the flows that fill them (launch writes CONTEXT/ADR; the launch C5 sediment pass and reviews sediment standards), and reports what exists, what was created, and what stays empty on purpose.

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
- `CONTEXT.md`, `docs/adr/`, `docs/standards/`, `docs/business/`, `design-system/`, `.omc/skills/`, `.mcp.json`, `scripts/`, `.gitattributes` — which exist, which are missing?
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
- does this repo have a UI? (no UI → design-system/ is created as a stub with a note, or skipped on request)
- issue tracker location (GitHub / GitLab / local `.scratch/`) — consumed by tracker-backed flows (the navigator's map home and the harbor's intake queue)

### 3. Scaffold (create missing surfaces — seeds render in the document language)

```
CLAUDE.md                      # thin entry — see seed A
CONTEXT.md                     # glossary — see seed B
.gitattributes                 # * text=auto eol=lf  (kills CRLF warning noise on Windows)
docs/adr/0001-adopt-shipyard-harness.md
docs/standards/architecture.md # seed C
docs/standards/data.md
docs/standards/process.md
docs/business/README.md        # seed D
design-system/README.md        # seed E (UI repos only; stub otherwise)
design-system/tokens/README.md
.omc/skills/README.md          # seed F
.mcp.json                      # {"mcpServers": {}}
scripts/README.md
```

Seed exemplars are reference companions, never a combined payload. Select exactly one companion after resolving `documentLanguage`; do not emit duplicate headings or labels from another companion. Use the longest matching language/script prefix: `en-*` uses English, `zh-Hans-*` uses Simplified Chinese, and `zh-Hant-*` uses Traditional Chinese, while Seed B writes the full resolved tag into `documentLanguage`. For any other valid tag, translate the English canonical companion once while preserving every stable token above.

Seed A — CLAUDE.md, en (thin entry; extend in place if the file exists):

<!-- shipyard-seed-a:en:start -->
```markdown
# <Project> — Agent & Human Shipyard

## Project conventions
- <language/framework/package manager/naming — list what matters, skip the rest>

## Architecture principles
- <the 3-5 principles most often violated in this project>

## Standards index (full text in docs/standards/)
- Architecture: docs/standards/architecture.md
- Data: docs/standards/data.md
- Process: docs/standards/process.md

## Decision records (full text in docs/adr/; load-bearing ones listed here)
- ADR-0001: adopt shipyard harness

## Shared background
- Glossary: CONTEXT.md ｜ Business knowledge: docs/business/ ｜ Decision context: docs/adr/

## Agent guide
- Delivery follows the canonical workflow plan → execute → review → verify; `/oh-my-claudecode:launch` is an optional governed delivery pipeline (opt-in, invoke explicitly)
- On term conflicts CONTEXT.md wins; new terms are recorded the moment they settle
- Reusable capability goes to .omc/skills/; UI patterns go to design-system/
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

## 规范索引（全文在 docs/standards/）
- 架构规范: docs/standards/architecture.md
- 数据规范: docs/standards/data.md
- 流程规范: docs/standards/process.md

## 决策记录（全文在 docs/adr/，此处只列 load-bearing 的）
- ADR-0001: adopt shipyard harness

## 共享背景
- 术语: CONTEXT.md ｜ 业务知识: docs/business/ ｜ 决策背景: docs/adr/

## Agent 指南
- 交付遵循 canonical 工作流 plan → execute → review → verify；`/oh-my-claudecode:launch` 是可选的受治理交付管道（opt-in，需要时显式调用）
- 术语冲突以 CONTEXT.md 为准；新术语当场补录
- 可复用能力沉淀到 .omc/skills/；UI 模式沉淀到 design-system/
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

## 規範索引（全文在 docs/standards/）
- 架構規範: docs/standards/architecture.md
- 資料規範: docs/standards/data.md
- 流程規範: docs/standards/process.md

## 決策記錄（全文在 docs/adr/，此處只列 load-bearing 項目）
- ADR-0001: adopt shipyard harness

## 共享背景
- 詞彙: CONTEXT.md ｜ 業務知識: docs/business/ ｜ 決策背景: docs/adr/

## Agent 指南
- 交付遵循 canonical 工作流 plan → execute → review → verify；`/oh-my-claudecode:launch` 是可選的治理交付管道（opt-in，必須明確呼叫）
- 術語衝突以 CONTEXT.md 為準；新術語確定時立即補錄
- 可重用能力沉澱到 .omc/skills/；UI 模式沉澱到 design-system/
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

One entry per term: definition, boundaries, one resolved ambiguity. Agents write here the moment a term is settled. Vocabulary here is law for all specs, tickets, and code naming.

## <term>
- Definition:
- Boundary: (is X, not Y)
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

一条术语一个条目：定义、边界、一个已解决的歧义。术语敲定的当下写入。词汇对所有 spec、ticket、代码命名具有法律效力。

## <term>
- 定义:
- 边界: （是 X，不是 Y）
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

每個術語一個條目：定義、邊界、一個已解決的歧義。術語確定時立即寫入。這裡的詞彙是所有 spec、ticket 與程式碼命名的準則。

## <term>
- 定義:
- 邊界: （是 X，不是 Y）
- 已解決的歧義:
```
<!-- shipyard-seed-b:zh-Hant:end -->

Seed C — docs/standards/architecture.md (data.md / process.md same shape; prose renders in the document language):

```markdown
# Architecture Standards

Rule-shaped, checkable writing; every rule carries a "why". Empty sections are legal — sediment is gradual.

## Module boundaries
## Error handling
## Dependency direction
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

`.mcp.json` seed: `{"mcpServers": {}}` — servers get added when a tool integration is actually needed, not speculatively.

### 4. Wire the governance loop (this is what makes it a shipyard, not a folder)

Tell the user, and rely on these flows to fill the skeleton:

- **launch** writes CONTEXT.md vocabulary, ADRs, and docs/business/ as decisions settle (paper trail)
- **launch C5 sediment / code-review** sediment recurring corrections into docs/standards/ and CLAUDE.md principles
- **anyone** can add a project skill to .omc/skills/ — the barrier is the skillify quality gate, not permission
- **wiki** (OMC) compounds session knowledge; promote anything referenced twice into docs/business/

The rule that keeps 先动手 aligned: **starting needs no permission; landing goes into a shipyard slot.** A change that cannot say which slot it lands in (or explicitly none) is the smell.

### 5. Report

- created / extended / deliberately skipped (each with why)
- resolved document language as `CONTEXT.md` frontmatter `documentLanguage: <tag>`, including whether it came from explicit choice, the persisted marker, or unanimous inference
- the 3 surfaces that most need human content next (usually CLAUDE.md conventions, architecture.md, CONTEXT.md first terms)
- reminder: re-run with `--check` any time to see drift between filesystem and harness

## `--check` mode

Diff actual repo state against the shipyard map; report: missing surfaces, a missing or invalid `CONTEXT.md` frontmatter `documentLanguage` tag, CLAUDE.md sections that point at dead paths, CONTEXT.md terms unused in code, and standards never referenced. For each finding, state the confidence (`high` when mechanically checkable, `low` when heuristic) and whether it is actionable after excluding throwaway/scratch repositories explicitly declared by the user. Launch's yard gate treats high-confidence actionable findings as blocking; low-confidence or explicitly-classified false-positive findings, and findings in a user-declared scratch/throwaway scope, may be overridden only with deliberate per-invocation intent (see `/oh-my-claudecode:launch`). `/oh-my-claudecode:ask-navigator` may also run this audit in report-only mode while charting a foggy effort: findings are recorded verbatim in the map's Notes (never swallowed) and remain live findings for the launch yard gate. Today `--check` has no executable or machine-readable exit contract — the report's wording is the classification source until a structured finding/severity contract ships (planned follow-up). Read-only.
