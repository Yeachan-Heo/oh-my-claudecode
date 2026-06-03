# Dynamic Workflows Integration

> How OMC integrates with Claude Code **native dynamic workflows** (research preview).
> Reference: https://code.claude.com/docs/en/workflows

## Design

OMC stays the **orchestrator** ("conductor"). When a single stage is too large for one
conversation to coordinate — a codebase-wide audit, a large migration, cross-checked research —
OMC may hand **that one stage** down to a Claude Code dynamic workflow as an execution backend,
then fold the single coordinated result back into its own pipeline.

This is **opt-in, capability-detected, and always-fallback**. It is never a hard dependency:
when workflows are unavailable or disabled, OMC silently continues with its existing orchestration
(ultrawork / team / ralph).

OMC does **not** drive the workflow runtime programmatically and does **not** author workflow
`.js` scripts. It triggers a workflow the supported way — a natural-language "use a dynamic
workflow" request (optionally the `ultracode` keyword) — and lets Claude Code write the script.

## Why not a deeper / hard integration

Workflows and OMC both want to *hold the plan*. A workflow moves orchestration into a script the
runtime runs in the background, with intermediate results kept out of Claude's context. That is
fundamentally different from OMC's turn-by-turn delegation, and the two cannot share state,
persistence, cancellation, or observability. The integration therefore picks one boundary
(OMC-conductor delegates one stage down) instead of fusing the systems.

## Configuration

Add a `workflows` block to `.claude/omc.jsonc`:

```jsonc
{
  "workflows": {
    "enabled": false,        // master opt-in (default false)
    "allowInHeadless": false, // allow under `claude -p` / SDK / bypass (default false)
    "allowNesting": false,    // allow inside an active ultrawork/team run (default false)
    "minScopeSignals": 1,     // heavy-scope signals required before routing
    "triggerKeyword": null    // optional; default uses version-proof natural language
  }
}
```

### Environment overrides

| Env var                          | Effect                                            |
| -------------------------------- | ------------------------------------------------- |
| `OMC_WORKFLOWS_ENABLED=true`     | Opt in to workflow routing                        |
| `OMC_WORKFLOWS_ALLOW_HEADLESS=true` | Allow routing in non-interactive contexts      |

### Claude Code disable surfaces (respected by capability detection)

Any of these makes OMC treat workflows as unavailable and fall back:

- `"disableWorkflows": true` in `~/.claude/settings.json` or managed settings
- `CLAUDE_CODE_DISABLE_WORKFLOWS=1`
- Claude Code older than `2.1.154`

## Module surface (`src/features/workflows`)

- `detectWorkflowCapability({ version, settingsDisabled, env })` → `WorkflowCapability`
- `shouldRouteToWorkflow({ task, config, capability, activeModes, providerLane, headless })` → `WorkflowRouteDecision`
- `resolveWorkflowsConfig(pluginConfig.workflows)` → resolved config (defaults: opt-in OFF)
- `buildWorkflowInvocation(task, config)` → the conversational instruction to launch a workflow
- `hasNativeWorkflowTrigger(prompt)` → true when the prompt already says `ultracode` / `workflow`
- `countScopeSignals(task)` → heuristic heavy-scope score

The decision fallback is **always** `omc-orchestration`.

## Recommended CLAUDE.md block

Add inside the OMC-managed region so the orchestrator knows the routing contract:

```md
<dynamic_workflows>
When a stage is too big for one conversation (codebase-wide audit, large migration,
cross-checked research) AND workflows are enabled+available on the Claude lane, delegate
THAT stage to a Claude Code dynamic workflow via a natural-language "use a dynamic workflow"
request — do not hand-author the script. One stage per workflow. Do not nest inside an active
ultrawork/team run. Workflows use more tokens, take no mid-run input, resume only within the
same session, and are stopped from /workflows (not /cancel). If workflows are disabled, too old,
headless without opt-in, or on a codex/gemini lane, continue with OMC orchestration silently.
</dynamic_workflows>
```

## Wiring status

Done in this change:

1. **Capability detection** — `detectWorkflowCapability` plus a live resolver
   (`resolveLiveWorkflowCapability`) that reads the Claude Code version
   (`CLAUDE_CODE_VERSION` / `claude --version`) and `disableWorkflows` from
   `~/.claude/settings.json`, degrading gracefully to "unavailable".
2. **Routing decision** — `shouldRouteToWorkflow` with the six gates and an
   always-OMC fallback, plus config + `OMC_WORKFLOWS_*` env plumbing.
3. **Keyword coexistence** — `src/hooks/keyword-detector` suppresses OMC's
   auto-detected fan-out keywords (ultrawork/autopilot/ralph) when the prompt
   already contains a native `ultracode` / `workflow` trigger. Explicit slash
   invocations are preserved.
4. **Skill + manifest** — the `workflow` skill is registered in
   `.claude-plugin/plugin.json` (and shipped via the existing `skills` entry in
   the npm `files` array).
5. **Orchestrator guidance** — a `<dynamic_workflows>` block in the shipped
   `docs/CLAUDE.md` tells the orchestrator when to delegate a stage down.

Intentionally deferred (needs validation against a live Claude Code with
workflows enabled):

- **Team exec-stage hook.** Mapping the in-session team's heavy exec/audit stage
  onto a workflow is delivered at the prompt/skill layer (the `workflow` skill +
  `<dynamic_workflows>` block), which is the correct surface for the in-session
  orchestrator. A programmatic hook is *not* added to `src/team/runtime-v2.ts`
  on purpose: that runtime is the tmux CLI-worker path (the wrong surface for an
  in-session feature), and a blind behavioral edit there is high-risk. Wire the
  in-session team exec stage to `shouldRouteToWorkflow` once it can be validated
  end-to-end.
- **Recompose generated CLAUDE.md copies** (root `CLAUDE.md`, `.github/CLAUDE.md`)
  if the project wants the block mirrored outside the installer's shipped source.

## Edge cases (why a run may not use a workflow)

Workflows disabled or Claude Code too old; headless/SDK/bypass without `allowInHeadless`
(subagents auto-approve edits there); session exit mid-run (a workflow restarts fresh, it does not
resume across sessions); OMC `/cancel` cannot stop a running workflow; OMC HUD/trackers cannot see
inside a run; native `ultracode` colliding with OMC's `ultrawork`/`ulw`; codex/gemini lanes
(Claude-only feature); the 16-concurrent / 1,000-total agent caps; and the meaningfully higher
token cost.
