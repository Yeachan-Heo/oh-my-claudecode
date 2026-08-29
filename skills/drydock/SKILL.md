---
name: drydock
description: Lay the keel of the shipyard harness in any repo — the 4-pillar shared environment (Context, Rules, Tools, Standards) across 5 surfaces (CLAUDE.md, skills, design-system, mcp/cli, shared context) so that every human and agent inherits the same design language and anyone can ship. Run once per repo; re-run with --check to audit drift.
argument-hint: "[--check]"
level: 3
---

# Drydock

Lay the keel of the **shipyard**: one repo, one shared harness, every contributor inherits it. This skill scaffolds the environment that turns "everyone ships" into "everyone ships on the same design language" — it creates the 5 surfaces, seeds them minimally, wires them to the flows that fill them (launch writes CONTEXT/ADR; retro and reviews sediment standards), and reports what exists, what was created, and what stays empty on purpose.

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

### 2. Ask (only what detection cannot answer)

- package/tech stack (for standards and design-system seeds)
- does this repo have a UI? (no UI → design-system/ is created as a stub with a note, or skipped on request)
- issue tracker location (GitHub / GitLab / local `.scratch/`) — recorded for launch/triage flows

### 3. Scaffold (create missing surfaces with the seeds below)

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

Seed A — CLAUDE.md (thin entry; extend in place if the file exists):

```markdown
# <Project> — Agent & Human Shipyard

## 项目约定
- <语言/框架/包管理器/命名惯例 —— 逐条列，宁缺毋滥>

## 架构原则
- <本项目最高频违反的 3-5 条原则>

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

Seed B — CONTEXT.md:

```markdown
# Glossary

One entry per term: definition, boundaries, one resolved ambiguity. Agents write here the moment a term is settled. Vocabulary here is law for all specs, tickets, and code naming.

## <term>
- 定义:
- 边界: （是 X，不是 Y）
- 已解决的歧义:
```

Seed C — docs/standards/architecture.md (data.md / process.md same shape):

```markdown
# Architecture Standards

规则化、可检查的写；每条带一个"为什么"。空节是合法的——沉淀是渐进的。

## 模块边界
## 错误处理
## 依赖方向
```

Seed D — docs/business/README.md:

```markdown
# Business Knowledge

决策背景与业务规则。格式建议：一篇文章回答一个业务问题，开头一段"为什么这事重要"。
新来的同事（人或 agent）读完这一目录，应该能回答"我们为什么做这个产品方向"。
```

Seed E — design-system/README.md:

```markdown
# Design System

## tokens/    设计令牌（颜色/字号/间距，机器可读 JSON 优先）
## components/ 组件约定（每个组件：用途、变体、禁用场景）
## patterns/  交互模式（表单、反馈、加载、空状态——沉淀复用过的模式）
```

Seed F — .omc/skills/README.md:

````markdown
# Project Skills

本项目沉淀的可复用能力：专用工具、提示词模板、专用实践。
一个技能一个文件 `.omc/skills/<name>.md`，frontmatter 必须含 name + description +
**非空 triggers**（loader 校验硬性要求：缺失或为空则技能不会被加载）：

```markdown
---
name: project-release-check
description: Apply this repository's release readiness rules
triggers:
  - "project release check"
---

# Project Release Check

Follow the repository-specific release checklist and report evidence.
```
判断标准与 Matt 的 skillify 一致：5 分钟能 Google 到的不配做技能；
写"本项目特有的决策纪律"，不写通用教程。
````

`.mcp.json` seed: `{"mcpServers": {}}` — servers get added when a tool integration is actually needed, not speculatively.

### 4. Wire the governance loop (this is what makes it a shipyard, not a folder)

Tell the user, and rely on these flows to fill the skeleton:

- **launch** writes CONTEXT.md vocabulary, ADRs, and docs/business/ as decisions settle (paper trail)
- **retro / code-review** sediment recurring corrections into docs/standards/ and CLAUDE.md principles
- **anyone** can add a project skill to .omc/skills/ — the barrier is the skillify quality gate, not permission
- **wiki** (OMC) compounds session knowledge; promote anything referenced twice into docs/business/

The rule that keeps 先动手 aligned: **starting needs no permission; landing goes into a shipyard slot.** A change that cannot say which slot it lands in (or explicitly none) is the smell.

### 5. Report

- created / extended / deliberately skipped (each with why)
- the 3 surfaces that most need human content next (usually CLAUDE.md conventions, architecture.md, CONTEXT.md first terms)
- reminder: re-run with `--check` any time to see drift between filesystem and harness

## `--check` mode

Diff actual repo state against the shipyard map; report: missing surfaces, CLAUDE.md sections that point at dead paths, CONTEXT.md terms unused in code, standards never referenced. Read-only.
