# Claude Operator Guide for LazyCodex Parity

This guide explains how to operate LazyCodex-compatible workflows in Claude/OMC after the T1-T10 port work. It is an operator guide, not a component inventory; use the [contract inventory](./contract-inventory.md) for current surface ownership and the [MCP compatibility matrix](./mcp-compat.md) for server-by-server MCP status.

## Invocation

Use Claude-native OMC commands and prompts. Do not paste stale Codex-only invocations such as `multi_agent_v1.*`, `fork_context`, Codex thread APIs, or raw `.codex` tool names and expect them to work unchanged.

| LazyCodex workflow intent | LazyCC invocation | Legacy alias | Status |
| --- | --- | --- |
| Explore-first `.lazycodex` planning | `/lazycc:ulw-plan` | `/lazycc:lazycodex-ulw-plan` | Adapted |
| Execute the next approved plan task | `/lazycc:start-work` | `/lazycc:lazycodex-start-work` | Adapted |
| Evidence-bound execution loop | `/lazycc:ulw-loop` or `/lazycc:ulw` | `/lazycc:lazycodex-ulw-loop` | Adapted |
| Coordinated team work | `/lazycc:teammode` or `/lazycc:team` | `/lazycc:lazycodex-teammode` | Adapted with staged durable Codex-thread semantics |
| Inspect coding-agent transcripts | `/lazycc:coding-agent-sessions` | `/lazycc:lazycodex-coding-agent-sessions` | Adapted read-only workflow |
| Explain project rule loading | `/lazycc:rules` | `/lazycc:lazycodex-rules` | Adapted |
| LSP diagnostics and symbol work | `/lazycc:lsp` | `/lazycc:lazycodex-lsp` | Adapted to LazyCC LSP surfaces where available |
| Comment-checker feedback handling | `/lazycc:comment-checker` | `/lazycc:lazycodex-comment-checker` | Adapted through Claude `PostToolUse` feedback |
| LazyCodex bug doctor, report, or contribute flows | `/lazycc:lcx-doctor`, `/lazycc:lcx-report-bug`, `/lazycc:lcx-contribute-bug-fix` | `/lazycc:lazycodex-lcx-doctor`, `/lazycc:lazycodex-lcx-report-bug`, `/lazycc:lazycodex-lcx-contribute-bug-fix` | Staged for external Codex/LazyCodex mutation and publishing |

LazyCodex-compatible agents are available through the OMC agent registry. Use the prompt or task surface exposed by the current Claude host for `explorer`, `plan`, `lazycodex-executor`, `lazycodex-code-reviewer`, `metis`, `momus`, `lazycodex-qa-executor`, and `lazycodex-gate-reviewer`.

## Equivalent, Adapted, and Staged Surfaces

Equivalent surfaces preserve the same operator contract under Claude: artifact-backed evidence, `.lazycodex` plan/evidence naming, local rule discovery, hook decision metadata, and verification before completion.

Adapted surfaces preserve LazyCodex intent but use Claude-native mechanics. Hooks run through Claude events such as `UserPromptSubmit`, `PostToolUse`, `PreCompact`, `Stop`, and `SubagentStop`. Skills invoke through LazyCC-native names such as `/lazycc:ulw-plan`; `/lazycc:lazycodex-*` names remain legacy aliases for existing prompts. Agents use LazyCC registry entries and Claude tool boundaries. Model routing uses Claude capability classes instead of copied OpenAI model IDs.

Staged surfaces are intentionally not advertised as complete parity. MCP servers `grep_app`, `context7`, `codegraph`, `git_bash`, and standalone `lsp` remain staged unless promoted in `.mcp.json` and `docs/lazycodex-port/mcp-compat.md`. Durable Codex thread operations, `multi_agent_v1`, `fork_context`, external LazyCodex/Codex repository mutation, issue filing, and global host migration are staged unless the user explicitly approves a workflow and the current host exposes the needed tools.

## State and Evidence

`.lazycodex` remains canonical for LazyCodex-compatible plans, state, ledgers, and evidence. Hook writes to `.lazycodex/ulw-loop/steering.json`, `.lazycodex/hook-cache-resets.json`, and `.lazycodex/evidence/executor-verification.jsonl` refuse symlink leaf paths and symlink parent components instead of following project-controlled links.

- `.lazycodex/plans/**` for work plans.
- `.lazycodex/boulder.json` for active work tracking.
- `.lazycodex/ulw-loop/steering.json` and `.lazycodex/ulw-loop/ledger.jsonl` for ULW loop state.
- `.lazycodex/start-work/ledger.jsonl` for start-work execution records.
- `.lazycodex/evidence/**` for operator evidence and executor receipts.

OMC `.omc` state remains available only for OMC-owned runtime state. A scoped `.omc/state/interop/lazycodex/boulder.json` bridge read may be used when an adapter explicitly allows it, but the bridge does not migrate or replace `.lazycodex`. Evidence gates reject missing, empty, traversal, symlink-escaping, or out-of-root receipt paths, and executor ledger append is skipped with a structured `needs-evidence` decision if the ledger sink is unsafe.

## Model Roles

Claude model-role mapping is semantic by capability class. Do not copy raw OpenAI or GPT model names from LazyCodex into Claude runtime configuration.

| LazyCodex role class | Claude class | Typical OMC roles |
| --- | --- | --- |
| Low-cost exploration | Haiku | `explorer`, quick read-only checks |
| Standard execution and verification | Sonnet | `worker`, `executor`, `verifier`, `lazycodex-executor`, `lazycodex-qa-executor` |
| Planning, review, and high-risk policy work | Opus | `planner`, `reviewer`, `metis`, `momus`, `lazycodex-code-reviewer`, `lazycodex-gate-reviewer` |

The routing contract is tested through `src/interop/lazycodex-model-routing.ts` and the LazyCodex-compatible agent registry. Unknown roles should fail closed instead of falling back to copied model identifiers.

## Hooks

The LazyCodex compatibility hook adapter normalizes Claude host payloads into portable LazyCodex event ids:

| Portable event | Claude event | Operator note |
| --- | --- | --- |
| `prompt-submitted` | `UserPromptSubmit` | Loads project rules, applies host mutation policy, and records ultrawork steering when LazyCodex keywords are present. |
| `tool-use-after` | `PostToolUse` | Runs comment-checker guidance and LSP/codegraph advice where applicable. |
| `compact-before` | `PreCompact` | Claude fallback for LazyCodex post-compact intent; records idempotent cache reset side effects. |
| `session-stopping` | `Stop` | Uses soft continuation messaging from `.lazycodex` Boulder state. |
| `subagent-stopped` | `SubagentStop` | Verifies executor DoneClaim evidence and appends `.lazycodex/evidence/executor-verification.jsonl` when receipts pass. |

Mutation and telemetry policy is disabled by default for auto-update, global Claude mutation, and telemetry. Enabling any of them requires explicit opt-in through the tested LazyCodex policy keys. Normal LazyCodex-compatible session-start workflows do not mutate `~/.claude`; even legacy plugin-cache cleanup is gated behind `lazycodex.globalClaudeMutation` or `OMC_LAZYCODEX_GLOBAL_CLAUDE_MUTATION=true`.

## Skills and Agents

LazyCodex skills are namespaced as `lazycodex-*` under OMC and include adapter notes for host differences. They preserve progressive disclosure but replace Codex-only APIs with Claude alternatives such as OMC commands, Claude Task/agent surfaces, OMC team workflows, and local shell verification.

LazyCodex agents are registered with explicit tool boundaries:

- `explorer`: read-only codebase search, Haiku.
- `plan`: Prometheus-style `.lazycodex` planner, Opus.
- `lazycodex-executor`: implementation with evidence discipline, Sonnet.
- `lazycodex-code-reviewer`: read-only quality review, Opus.
- `metis`: pre-planning analyst, Opus.
- `momus`: plan reviewer, Opus.
- `lazycodex-qa-executor`: manual QA executor, Sonnet.
- `lazycodex-gate-reviewer`: final evidence gate reviewer, Opus.

Claude agents do not inherit Codex `fork_context` semantics. If a workflow needs durable Codex thread identity or mailbox behavior, record that part as staged and continue through OMC team or direct Claude execution.

## MCP

OMC advertises its native `t` MCP bridge through `.mcp.json` with `${CLAUDE_PLUGIN_ROOT}/bridge/mcp-server.cjs`. LazyCodex MCP servers are inventoried but staged until each server has package-safe startup, path portability, tool discovery, and policy-gated smoke evidence.

Current LazyCodex MCP status is maintained in [mcp-compat.md](./mcp-compat.md). Operators should not add staged LazyCodex servers under `mcpServers` just to make a workflow appear available.

## Verification

For plan execution, substitute the task-owned worktree for `<installed-omc-marketplace-root>` when the plan is being executed in a worktree:

```bash
OMC_WORKTREE=<omc-worktree>
cd "$OMC_WORKTREE"
npm run test:run -- --run src/interop/__tests__/lazycodex-host-events.test.ts
npm run test:run -- --run src/interop/__tests__/lazycodex-policy.test.ts
npm run test:run -- --run src/interop/__tests__/lazycodex-model-routing.test.ts
npm run test:run -- --run src/interop/__tests__/lazycodex-state.test.ts
npm run test:run -- --run src/hooks/__tests__/lazycodex-compat-hooks.test.ts src/hooks/__tests__/lazycodex-evidence-gate.test.ts
npm run test:run -- --run src/interop/__tests__/lazycodex-skills.test.ts
npm run test:run -- --run src/agents/__tests__/lazycodex-agents.test.ts
npm run test:run -- --run src/mcp/__tests__/lazycodex-mcp-compat.test.ts
```

Run the docs acceptance check after changing this guide or related docs:

```bash
cd "$OMC_WORKTREE"
rg -n "LazyCodex|\\.lazycodex|Haiku|Sonnet|Opus|hooks|skills|MCP|verification|staged" docs/lazycodex-port
node -e "const fs=require('fs'); const d='docs/lazycodex-port'; const s=fs.readdirSync(d).map(f=>fs.readFileSync(d+'/'+f,'utf8')).join('\\n'); for (const term of ['LazyCodex','.lazycodex','Haiku','Sonnet','Opus','hooks','skills','MCP','verification','staged']) if(!s.includes(term)) throw new Error(term)"
```

Manual QA for documentation should verify headings, local links, required sections, and the staged limitation language rather than relying on a rendered README count. Evidence for this task belongs in `.lazycodex/evidence/task-T11-claude-port-lazycodex.md`.
