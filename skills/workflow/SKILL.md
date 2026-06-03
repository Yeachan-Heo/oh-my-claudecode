---
name: workflow
description: Delegate a single heavy, highly-parallel stage to a Claude Code native dynamic workflow while OMC stays the orchestrator
argument-hint: "<heavy parallel task: codebase-wide audit, large migration, cross-checked research>"
aliases: []
level: 4
---

<Purpose>
The workflow skill lets OMC hand ONE heavy, highly-parallel stage down to a Claude Code native dynamic workflow as an execution backend. OMC remains the conductor: it decides when a stage is workflow-shaped, launches the workflow the supported way, then folds the single coordinated result back into its own pipeline. This is an opt-in, capability-detected, always-fallback path — never a hard dependency.
</Purpose>

<Use_When>
- The current stage is too large for one conversation to coordinate: a codebase-wide bug/security/dead-code sweep, a migration touching hundreds of files, a plan worth drafting from several independent angles, or research that must cross-check many sources.
- Dynamic workflows are available (new-enough Claude Code, not disabled) AND `workflows.enabled` is true.
- The work is on the Claude provider lane (not a codex/gemini lane).
</Use_When>

<Do_Not_Use_When>
- `workflows.enabled` is false, workflows are disabled (org/managed settings, `disableWorkflows`, `CLAUDE_CODE_DISABLE_WORKFLOWS`), or Claude Code is older than 2.1.154 — fall back to OMC orchestration (ultrawork/team/ralph) silently.
- An OMC fan-out mode (ultrawork/team/autopilot/ralph) is already active — do not nest a workflow inside it unless `workflows.allowNesting` is true. Nesting produces two competing orchestrators and runaway token use.
- The task is small or sequential — keep it in OMC; a workflow's extra token cost is not justified.
- The stage needs mid-run human sign-off — a workflow takes no mid-run input. Split into stage-per-workflow instead.
- Running headless (`claude -p` / Agent SDK / bypass) unless `workflows.allowInHeadless` is true — workflow subagents auto-approve edits with no prompt in those contexts.
- The lane is codex or gemini — dynamic workflows are Claude-only.
</Do_Not_Use_When>

<Why_This_Exists>
OMC orchestrates turn-by-turn with results landing in the context window. A dynamic workflow moves the plan into a script the runtime executes in the background, keeping intermediate results out of context and applying repeatable adversarial-review patterns at a scale (dozens to hundreds of agents) a single pass cannot reach. For the right stage, delegating down to a workflow is stronger than OMC fanning out itself — but only for that stage, and only when it is safe and enabled.
</Why_This_Exists>

<Execution_Policy>
- Decide first: confirm the stage is workflow-shaped and that workflows are enabled + available. If not, use OMC orchestration and do not mention workflows.
- Launch the supported way: ask for a workflow in natural language (e.g. "Use a dynamic workflow to ..."), which Claude Code treats as the opt-in on every version. Do NOT hand-author a workflow `.js` script — let Claude Code's runtime write it. Optionally include the `ultracode` keyword on Claude Code 2.1.160+.
- One stage per workflow. For multi-stage work needing sign-off between stages, run each stage as its own workflow and let OMC sequence them.
- Pre-clear the tool allowlist for long unattended runs: shell/web/MCP calls not in the allowlist still prompt mid-run and will stall the run.
- Mind the caps: the runtime allows up to 16 concurrent agents and 1,000 agents per run; do not assume unbounded parallelism.
- Be explicit about cost: a workflow uses meaningfully more tokens than the same work in conversation. For a large target, suggest running on a small slice first.
- Observability: OMC's HUD and subagent-tracker cannot see inside a running workflow. Track progress via the native `/workflows` view; treat the workflow's returned report as the stage result and verify it in a separate OMC pass.
- Persistence + cancellation are the workflow's, not OMC's: a workflow resumes only within the same Claude Code session and is stopped from `/workflows` (not `/cancel` or OMC kill switches). Never assume an OMC ralph/persistent loop can resume a workflow across sessions.
- Always-fallback: if anything blocks the workflow (disabled, wrong version, wrong lane, nested), continue with OMC orchestration without failing the task.
</Execution_Policy>

<Routing_Contract>
OMC computes the decision in `src/features/workflows` (shouldRouteToWorkflow). The gates, in order: feature opted in → capability available → Claude lane → not nested in a fan-out mode → not headless (unless opted in) → task meets the scope-signal threshold. The fallback is always OMC orchestration. When the user's prompt already contains a native trigger (`ultracode` / `workflow`), OMC suppresses its own ultrawork/team auto-activation so the two systems do not both seize the task.
</Routing_Contract>
