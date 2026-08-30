# Shipyard — Governed Delivery & Shared Harness

Shipyard is the delivery methodology behind three opt-in skills: `drydock`, `launch`, and `minimal-code-discipline`. Its premise in one line:

> **Everyone ships, and nobody ships randomly** — agents continuously run everything repeatable and acceptable-by-evidence; humans decide what cannot be judged by the system or what fails expensively.

This page is the map of the methodology: the boundary principle, the four pillars, the surface layout, the working metaphor, and how the three skills compose. The skills themselves (`/oh-my-claudecode:drydock`, `/oh-my-claudecode:launch`, `/oh-my-claudecode:minimal-code-discipline`) are the executable form.

## The verifiability boundary

Every step in a launch run answers one test question: *if this is done wrong, can the system detect it? Can it redo or roll back automatically?*

- **Both yes → agents run it continuously** (the repeatable ~80%): fact-finding, spec/ticket drafting, tdd implementation, builds, tests, code-review, verify, scheduling.
- **Either no → the human decides it** (the critical ~20%): acceptance criteria, seam selection, ticket granularity, irreversible architecture decisions, final acceptance.

It is not "let agents do as much as possible" — it is "delegate exactly what can be accepted, nothing more."

## The four pillars → five surfaces

A repo that humans and agents both build on carries four pillars across five surfaces. `/oh-my-claudecode:drydock` lays them; every later session inherits them by reading.

| Surface | Carries | Filled by |
| --- | --- | --- |
| `CLAUDE.md` | 薄入口：项目约定 / 架构原则 / 规范索引 / load-bearing 决策指针 | drydock seed; retro & reviews sediment |
| `CONTEXT.md` | 术语词典（agent 当场落盘的格子；词汇即法律） | launch Phase 1; domain-modeling |
| `docs/adr/` | 决策记录全文（航海日志） | launch C4; domain-modeling |
| `docs/standards/` | architecture.md / data.md / process.md | retro & code-review sediment |
| `docs/business/` | 业务知识（一篇回答一个业务问题） | launch Phase 1 |
| `design-system/` | tokens/ + components/ + patterns/ | frontend review sediment |
| `.omc/skills/` | 项目技能：可复用能力 / 专用工具 / 提示词模板 / 专用实践 | anyone (skillify quality gate) |
| `.mcp.json` + `scripts/` | MCP servers + CLI 工具链 / 自动化脚本 | PR |

## The metaphor family (for teaching the system)

| 隐喻 | 对应物 | 一句话 |
| --- | --- | --- |
| 船坞 shipyard | 整套 harness | 共享设施，人人来造船 |
| 龙骨 keel | `CLAUDE.md` + `CONTEXT.md` | 先铺骨架，船体往上长 |
| 船级社 classification society | `docs/standards/` + `design-system/` | 船要入级才能出海 = 变更要过标准才能合并 |
| 海图 charts | specs + tickets | launch 的产物，照图施工 |
| 航海日志 logbook | `docs/adr/` | 决策记录，事后可查 |
| 下水 launch | `/oh-my-claudecode:launch` | 人人可以下水，船级社的检查一项不能少 |

## The three skills compose

- **`drydock`** lays the keel once per repo (surfaces + seeds + `--check` drift audit).
- **`launch`** runs delivery per feature (C1 brief → C2 spec+seams → C3 tickets → C4 frontier execution → C5 closeout), with the human at exactly the checkpoints that fail expensively.
- **`minimal-code-discipline`** governs how the code inside every ticket gets written (YAGNI ladder, smallest correct diff).

They share one rule of thumb: **starting needs no permission; landing goes into a shipyard slot.** A change that cannot say which slot it lands in (or explicitly none) is the smell.

## The feedback loop

Shipyard corrects itself through evidence: friction observed during any run is recorded as a finding (phase-tagged), reviewed at closeout, and either fixed in the skill files or explicitly wontfixed with a reason. A fix is `shipped` only when a later run verifies it took effect. The ledger lives in each project's findings store; the audit is mechanical (`sy check`/`context-lint` style tools, or by hand).

## When to reach for what

- one-point fix → `execute` directly (no shipyard ceremony)
- multi-step feature → `launch`
- new repo, or a repo where knowledge lives in heads → `drydock` first
- writing-time code discipline inside any of the above → `minimal-code-discipline`

Shipyard adds no daemon, no mode, no always-on behavior: the surfaces are plain markdown, the skills are plain instructions, and the canonical `plan → execute → review → verify` spine remains the default path. Shipyard is opt-in at every door.
