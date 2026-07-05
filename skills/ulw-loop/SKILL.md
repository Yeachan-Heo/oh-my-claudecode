---
name: ulw-loop
description: "LazyCC Claude adaptation of LazyCodex ulw-loop for evidence-bound goal execution."
aliases: [ulw]
---

# LazyCC ULW Loop

Invoke with `/lazycc:ulw-loop` or `/lazycc:ulw`.

Workflow concept: `ulw-loop`

## Purpose

Run a durable, evidence-bound execution loop using LazyCC and Claude Code surfaces while preserving LazyCodex evidence expectations. Every success criterion needs a named scenario, an invocation, a binary observable, an artifact path, and a cleanup receipt.

## Progressive Disclosure

1. Read the active brief, `.lazycodex` ledger/state, and the relevant LazyCodex `ulw-loop` reference sections before acting.
2. Classify the work tier and record success criteria.
3. Decompose into independent and dependent steps.
4. Execute with OMC/Claude agents only where they are available in the current host.
5. Verify through automated checks plus one real surface or auxiliary data surface for each delivered behavior.

## Claude adaptation

- Use `/lazycc:team` for coordinated fan-out and `/lazycc:ultrawork` for parallel execution when the host supports those skills.
- Use OMC `.omc` state only for OMC-owned runtime state. Preserve `.lazycodex` evidence and plan files for LazyCodex compatibility.
- If no Claude team or Task tool is available, continue directly and record the missing agent surface as a staged runtime limitation.

## Adapter Notes

- Codex-only concept: `multi_agent_v1` mailbox polling, `fork_context`, and `.codex` state are not Claude runtime instructions.
- Claude alternative: Claude Code Task agents, OMC team runtime, OMC state hooks, and explicit command artifacts.
- User examples are input context, not permission to mutate host settings.
- Do not mutate Claude configuration, enable telemetry, or install runtime components unless the user explicitly asks.

## Completion

Stop only after tests, manual QA artifacts, adversarial probes, cleanup receipts, and evidence ledger entries are present for the current criteria.
