---
name: harbor
description: Harbor intake for external work — sweep incoming issues and PRs, verify every claim before disposition, and hand the maintainer a short docket where the only remaining work is signing. Agent-autonomous for facts (inspection, info requests, duplicate linking, security escalation); maintainer-signed for decisions (accept, reject, merge). Use when issues or PRs have piled up, or to check what is ready to pick up.
argument-hint: "[sweep | look at #N | move #N to <state> | what's ready?]"
level: 3
---

# Harbor

Harbor is the shipyard's intake. External requests — issues, bug reports, feature requests, and (when enabled) external PRs — arrive as raw noise: unclear, unverified, sometimes duplicated, sometimes already built. Harbor turns that noise into a short docket where every ship has been inspected, every fact has been checked, and the maintainer's only remaining job is to decide.

**The two questions.** Everything harbor does exists so the maintainer only ever answers:

1. **This issue — do it, or not?**
2. **This PR — take it, or not?** (and if taken: does it merge?)

**The authority rule.** Facts are harbor's job — gathering, checking, reproducing, drafting — done autonomously, fully logged. Decisions belong to the maintainer — accepting, rejecting, merging — signed at the desk. Harbor never signs, never merges, never decides. When it drafts, the maintainer's signature is the only thing missing.

**Self-built cargo rule.** Harbor only handles work that arrived from outside. Tickets created by launch C3, navigator maps, or to-tickets flows are agent-ready by construction — harbor must not re-process them.

## The labels

Create these labels if the tracker does not have them (and create them before first use):

`harbor:accepted` · `harbor:need-decision` · `harbor:need-info` · `harbor:rejected` · `harbor:for-maintainer` · `harbor:needs-exploration` · `harbor:merge-ready` · `harbor:changes-requested`

The tracker IS the state — no state files, no ledgers. The tracker and label vocabulary should have been recorded by `/oh-my-claudecode:drydock`; if not, ask once and record the answer in `CLAUDE.md` under the shipyard conventions. Prose on every label, comment, and sheet follows the document-language contract (`documentLanguage` in `CONTEXT.md`); structural tokens (`harbor:` label names, state names) stay byte-stable.

## Sweep — the default command

A sweep processes the whole harbor in one pass:

1. **The queue.** Three buckets, oldest first: everything at `harbor:accepted`-pending (uninspected arrivals), everything `harbor:need-info` with reporter activity since the last intake note, and anything the maintainer parked for themselves. Draft PRs are not a request surface — skip them. External PRs only when the PR flag was enabled at setup; explicitly named PRs are always handled.
2. **Inspect each arrival** (see The three checks). Facts first, autonomously.
3. **Act where harbor acts alone**: send itemized info requests, link exact duplicates to their parent, escalate security reports to a private channel, post PR change-lists, close exact-duplicate reports citing the parent.
4. **Draft the sheets** for everything that needs a signature and present them as one docket (see The sheets). Batch them — one comment per ship, never a comment per finding.
5. **The reconciliation.** End with the docket summary: how many inspected, accepted, rejected, awaiting info, awaiting signature — and the signature queue as checkable boxes.

## The three checks — run in order, on every arrival

1. **Redundancy.** Search the codebase **by domain concept, not by wording** (use the `CONTEXT.md` glossary) for an existing implementation; then search the open queue for the same underlying report or change. Exact match already in the code → reject as already-built, pointing at where it lives. Exact match already in the queue → link to the parent and reject as duplicate. Fuzzy match → present both to the maintainer at the desk, do not close autonomously.
2. **Prior refusals.** Read the rejection log (`.out-of-scope/` in the repo root). A request resembling a recorded refusal is rejected citing that entry — the argument was made once; it does not get re-made.
3. **Confirmation.** Verify the claim itself. Bug → reproduce from the reporter's steps on the current head. PR → check out the branch, run the relevant tests or commands. Report one of three outcomes: **confirmed** (with the code path), **failed** (with what happened), or **insufficient** (a strong info-request signal). Never disposition on an unverified claim.

Security-sensitive arrivals (leaks, IDOR, auth bypass): stop expanding details publicly on the first sign. Move the conversation to the platform's private vulnerability reporting channel immediately, leave a one-line public acknowledgment, label `harbor:for-maintainer`, and escalate — the maintainer owns everything after that.

## The desk — where decisions are signed

Inspection produces facts; the desk produces decisions. Harbor presents each ship's sheet with a recommendation and waits. The maintainer rules:

- **Accepted** → the implementation list (objective / scope / non-goals / acceptance criteria — the same shape as a navigator mission brief) is attached, and the ship is ready for `execute` (single point) or `launch` (multi-step effort).
- **Rejected** → the reason is recorded; refusals of new capabilities are written to `.out-of-scope/` (why refused, the escape hatch, prior requests) and linked. Already-built rejections point at the code and write nothing to the log.
- **Info requested** → the specific missing facts, itemized, sent to the reporter.
- **For the maintainer** → work only a human can execute (authority, confidentiality, physical presence): attach a mini-list of what to do and what evidence closes it.

The maintainer may also override anything directly ("move #42 to rejected") — trust them, confirm what is about to happen, skip the interview. Quick rulings with attached recommendations can be accepted in one word ("按推荐" / "per recommendation").

A maintainer ruling that answers scope questions returns the ship to the desk for re-disposition; answers land in the sheet. **Once a ship is accepted and claimed by `execute`/`launch`, delivery state lives in that pipeline — harbor stops tracking it.**

## PR loop

A PR is a vessel that already arrived built, so its loop differs from an issue's: after intake says "wanted", the quality survey runs — claim (does it do what it says), standards (repo conventions; hand the deep survey to the review surface rather than stamping it yourself), intent (implements what the linked issue wanted), hygiene (no smuggled changes, sane commits). Findings are consolidated into **one actionable checklist** on the PR; the author iterates; harbor re-runs the dimensions on every new push. All dimensions green → `merge-ready`, presented to the maintainer — **harbor never merges**; merge is outward-facing and irreversible, always the maintainer's signature. Author abandons the loop → surface it in the queue and close on the maintainer's sign-off.

## The sheets — output contract

Every tracker comment harbor posts uses plain language and this exact shape. Methodology vocabulary from the shipyard's internal metaphors never appears on the tracker — the maintainer and reporters have not learned the metaphors, and they should not need to.

**Disclosure header, on every comment, verbatim:**

> *🤖 AI 协助整理的检查结果 — 处置由维护者决定。*
> (or its English twin: *> 🤖 Generated by AI during harbor intake — a human decided the disposition.*)

**Structure:**

```markdown
## <verdict emoji> 结论:<一句话答案>
**为什么**:<one to two lines of evidence-backed reasoning>

<details><summary>🔍 核实过程(点开)</summary>
| 检查 | 结果 |
|---|---|
| 代码里是否已有 | ... |
| 以前是否拒绝过 | ... |
| 主张是否真实 | ... |
</details>

**需要维护者做的**:<the one action, or "无">
```

Verdict emojis: 🟢 accepted · 🟡 need-decision · 🔵 need-info · ⚪ rejected · 🔴 for-maintainer · 🌫️ needs-exploration · 🟣 merge-ready · 🟠 changes-requested. A checkable task list (- [ ]) for every maintainer action; recommendations carry a ➡️ and alternatives so one word accepts them.

**The docket** (one issue per sweep, refreshed each time): count line by verdict, then ✍️ signature queue as checkable boxes, then one small table per state with links. This issue is the maintainer's single reading surface.

## Scope and non-goals

- No daemon, no auto-classification on issue creation, no label sync, no cross-repo aggregation, no SLA timers. Harbor runs when invoked.
- It does not merge, does not track delivery after hand-off, does not chart fog (→ `/oh-my-claudecode:ask-navigator`), does not debug (→ the debugger), does not stamp its own quality review (→ the review surface).
- Tracker backends: GitHub Issues and the local `.scratch/` convention. Other backends are deliberately out of scope — each one is a permanent maintenance surface.
- It never re-argues a recorded refusal; it never closes on a fuzzy match without the maintainer.

## Completion definition

The sweep ends with the docket posted: every arrival inspected with the three checks, every autonomous action taken and logged, one consolidated signature queue with checkable boxes — and the maintainer's total effort for the whole harbor is a handful of one-word signatures.
