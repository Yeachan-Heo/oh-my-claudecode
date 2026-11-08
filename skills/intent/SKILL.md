---
name: intent
description: Shipyard's internal requirements intake for non-engineer contributors (support/ops) — turn a pasted chat log or verbal problem report into a five-section intent.md through numbered batch questioning with a completion gate, walk it through tracker review with harbor's four records, and hand the accepted intent to /launch as its mission brief. Produces decisions, not code.
argument-hint: "<pasted feedback / chat log | path to existing intent.md | nothing to continue open review>"
level: 3
disable-model-invocation: true
---

# Intent

Intent is the shipyard's **internal intake**: support/ops staff see product problems first but cannot write engineering specs. The intent skill converts their conversation into a goal-level YAML+markdown artifact that an owner reviews and signs, so engineering receives a fog-free mission. It stands on the verifiability boundary — the agent asks, records, and drafts; humans submit, verify, and sign.

Design provenance: every decision here was pinned by a wayfinder map (7 tickets) and walked end-to-end in a demo repository before implementation.

## Role contract

- The contributor (e.g. support staff) pastes raw feedback or a chat log. The agent never invents facts; unknowns become explicit `待确认` items.
- Decisions are the humans': the contributor confirms wording, the supervisor submits, the product owner verifies facts and signs accept/reject. The agent never signs, never rejects on anyone's behalf, and never stands in for a reviewer.
- The stop gate is a **completion gate, not an ambiguity score** — no math is borrowed from deep-interview; only its Goal and Constraint clarity judgments are reused as quality bars.

## The conversation (numbered batch questioning)

1. **Opening inventory**: restate the problem in one sentence, then show the five-section inventory (known / missing per section).
2. **Numbered batch questioning**: list every gap as numbered questions in one batch. The contributor answers by number (`1 是; 2 不确定`). Unknown answers are recorded as `待确认` and pushed into open questions — never pressed until guessed.
3. **Re-inventory**: apply the answers; if gaps remain, emit the next numbered batch. One round = one batch.
4. **Stop gate** (all five sections must pass):
   - 问题: observable phenomena, no solution embedded
   - 目标: one sentence, no qualifiers, names entities and relations (deep-interview Goal Clarity bar)
   - 用户和系统: real names for users and systems; unknowns written as `待确认` and counted as open questions
   - 约束: boundaries, limits, and non-goals explicit (deep-interview Constraint Clarity bar)
   - 未决问题: list non-empty, or an explicit `无`
5. **Soft limits**: soft prompt at round 6 ("draft with current clarity?"), hard cap at round 12. An early exit is never blocked — thin sections surface as longer open questions, and review is the gate that rejects them.
6. **Draft**: the agent drafts `docs/intents/<slug>/intent.md` (template below) at `status: draft`; the contributor confirms wording before any submission.

## The intent.md template

```markdown
---
intent: <slug>
title: <one-line title>
author: <name (role)>
date: <YYYY-MM-DD>
status: draft | in-review | accepted | rejected
round: <tracker review round>
---

## 问题
<observable phenomena, no solution>

## 目标
one sentence, no qualifiers

## 用户和系统
<who the users are, which systems, real names; unknowns as 待确认>

## 约束
<boundaries, non-goals; cite Rules pillar files when a constraint comes from them>

## 未决问题
- [阻塞|非阻塞] <question>   ← agent suggests, product owner finalizes
```

## Grading open questions

The test for `阻塞`: **"can the spec still be approved without answering it?"** No → blocking; yes → non-blocking (tracked, may ride into development). The drafting agent suggests grades; the product owner finalizes at spec approval.

## Review handoff (harbor four records)

Review runs on the repo's tracker — **the tracker is the only record source; intent.md frontmatter mirrors status only**. One record file per Intent, rounds accumulate inside it. Required fields per record: signer, date, verdict, link to intent.md, round, rejection reason (mandatory on reject).

- **proposal** = supervisor submits the Intent (intent.md → `status: in-review`)
- **verification** = product owner checks facts against repo evidence before deciding; the agent may draft the fact-check table, but the signature belongs to the reviewer — no repo evidence to check? Then verification records why none was needed
- **decision** = accept or reject; reject requires a reason, which is the key input to resubmission
- **execution result** = spec generation completed for this Intent

Rejected → revise → resubmit in the same file under the next round number. History stays traceable.

## Handoff to launch

An accepted intent (`status: accepted`) is a valid mission brief. Launch's spec synthesis then follows the **four-step contract**:

1. read `docs/intents/<slug>/intent.md` (must be accepted, latest round)
2. combine with the existing codebase
3. follow the Rules pillar (`CLAUDE.md` + `docs/standards/` + `docs/business/`)
4. list every doubt and rule conflict — graded into the spec's pending-confirmation section

Intent open questions carry into the spec verbatim, keeping their pending status.

## Amendment

New information after acceptance (typically surfaced by the first spec) is an **amendment**: anyone may initiate, the submitter signs, and it always re-enters full review as a new round — no minor-change exemption. An intent change marks the generated spec stale; the spec is regenerated from the new intent and re-approved. No separate amendment record type: rounds carry it.

## Conflict sedimentation

Conflict conclusions in the spec's pending section follow precedent-based routing: case-local answers stay in the spec; conclusions that will bind later Intents sediment into the Rules pillar (`docs/business/` for business rules, `docs/standards/` for behavior rules); hard-to-reverse technical tradeoffs become ADRs. Never double-write; never defer archiving. The product owner decides whether a conclusion is precedent-setting; the tech lead advises the destination.
