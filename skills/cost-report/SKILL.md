---
name: cost-report
description: Track token usage, estimate costs, recommend model routing optimizations, and set budget awareness
level: 2
aliases: [cost, tokens, budget]
argument-hint: [report|routing|tips] - default is report
---

# Cost Report Skill

Analyze token consumption patterns, estimate session costs, and recommend model routing optimizations to reduce spend without sacrificing quality.

## Usage

```
/oh-my-claudecode:cost-report
/oh-my-claudecode:cost-report routing
/oh-my-claudecode:cost-report tips
/oh-my-claudecode:cost
```

Or say: "how much did this cost", "token budget", "optimize cost", "model routing advice"

## Pricing Reference (as of 2025)

| Model | Input (per 1M) | Output (per 1M) | Best For |
|-------|----------------|------------------|----------|
| Haiku 4.5 | $0.80 | $4.00 | Quick lookups, exploration, formatting |
| Sonnet 4.6 | $3.00 | $15.00 | Standard coding, debugging, reviews |
| Opus 4.6 | $15.00 | $75.00 | Architecture, complex reasoning, security |

**Note**: Prices may change. Check `/cost` in-session for actuals.

## Workflow

### 1. Gather Session Data

Collect current session cost information:

- Run `/cost` mentally or ask the user for their `/cost` output
- Check which models have been used in this session
- Review what agents were spawned and their likely model tiers
- Check `state_read` for active modes (ralph, autopilot, ultrawork) that spawn subagents

### 2. Analyze Model Usage Patterns

Review how models are being used in the session:

**Opus Usage Review:**
- Was Opus used for tasks that Sonnet could handle? (simple code generation, formatting, basic refactoring)
- Was Opus appropriately used? (architecture decisions, security review, complex debugging)

**Sonnet Usage Review:**
- Were there simple tasks sent to Sonnet that Haiku could handle? (file exploration, simple searches, quick lookups)
- Was Sonnet appropriately used? (standard coding, testing, debugging)

**Agent Model Routing:**
- Check which agents use which models from the OMC agent catalog:
  - **Opus agents**: architect, analyst, planner, critic, code-reviewer, code-simplifier (justified for complex reasoning)
  - **Sonnet agents**: executor, debugger, designer, test-engineer, verifier, tracer, qa-tester, security-reviewer, git-master, document-specialist, scientist (balanced quality/cost)
  - **Haiku agents**: explore, writer (speed-optimized, low cost)

### 3. Generate Cost Report

```
[COST REPORT] Session Analysis
═══════════════════════════════════════════

Session Duration: {duration}
Models Used: {list}

┌──────────────────────────────────────────┐
│ ESTIMATED TOKEN USAGE                     │
├─────────────┬───────────┬────────────────┤
│ Category    │ Tokens    │ Est. Cost      │
├─────────────┼───────────┼────────────────┤
│ Direct chat │ {n}       │ ${cost}        │
│ Subagents   │ {n}       │ ${cost}        │
│ Tool calls  │ {n}       │ ${cost}        │
│ Context     │ {n}       │ ${cost}        │
├─────────────┼───────────┼────────────────┤
│ TOTAL       │ {n}       │ ${total}       │
└─────────────┴───────────┴────────────────┘

Cost Efficiency Score: {score}/10
```

### 4. Model Routing Recommendations

Provide specific actionable advice:

**Downgrade opportunities** (save money, same quality):
```
[ROUTING] These tasks could use a cheaper model:
  → File exploration/search → Use Haiku (explore agent) instead of Sonnet
  → Simple formatting/docs → Use Haiku (writer agent) instead of Sonnet
  → Quick yes/no checks → Use Haiku instead of Sonnet
  Estimated savings: {pct}% on these tasks
```

**Upgrade opportunities** (spend more, better results):
```
[ROUTING] These tasks benefit from a stronger model:
  → Security-sensitive code → Use Opus (security-reviewer) for thorough analysis
  → Architecture decisions → Use Opus (architect) for deeper reasoning
  → Complex debugging → Use Opus for root cause analysis
```

**OMC-specific routing tips:**
```
[ROUTING] OMC Mode Optimization:
  → /ultrawork: Already routes by tier — verify tasks are tagged correctly
  → /ralph: Reviewer verification tier matches task complexity
  → /team: Worker model matches task difficulty
  → /autopilot: Phase 4 validation uses opus — appropriate for final gate
```

### 5. Cost Reduction Tips

When invoked with `tips`:

```
[COST TIPS] Reduce Token Spend
═══════════════════════════════════════════

1. CONTEXT MANAGEMENT (saves 10-30%)
   → Run /compact regularly to shrink conversation history
   → Use /clear between unrelated tasks
   → Minimize MCP server count (each adds ~3K tokens overhead)
   → Keep CLAUDE.md concise (under 2K tokens)

2. MODEL ROUTING (saves 20-50%)
   → Use /model to switch models mid-session for simple tasks
   → Haiku for: exploration, search, formatting, simple questions
   → Sonnet for: coding, testing, standard debugging
   → Opus for: architecture, security, complex reasoning only

3. PROMPT EFFICIENCY (saves 5-15%)
   → Be specific — vague prompts cause exploration loops
   → Include file paths when possible — saves search tokens
   → Use one-shot mode (claude -p) for simple queries
   → Batch related questions in one prompt

4. AGENT EFFICIENCY (saves 10-30%)
   → /ultrawork auto-routes by tier — use it for multi-task work
   → Avoid spawning opus agents for simple tasks
   → Use explore (haiku) instead of general agents for codebase search

5. SESSION MANAGEMENT (saves 5-20%)
   → Start fresh sessions for unrelated work
   → Use /compact before context fills up
   → Pipe mode for scripted batch operations
```

## Exit Conditions

| Condition | Action |
|-----------|--------|
| **Report complete** | Display cost analysis and routing advice |
| **Tips requested** | Display optimization tips |
| **No data available** | Suggest running `/cost` first and re-invoking |

## Notes

- **Estimates only**: Token counts are approximations based on typical usage patterns. Use `/cost` for actual session data.
- **No tracking across sessions**: This skill analyzes the current session only. Cross-session cost tracking requires external tooling.
- **Model prices change**: The pricing table is a reference. Always verify current pricing at anthropic.com/pricing.
- **Context overhead matters**: A session with 6 MCP servers wastes ~20K input tokens on every message — that's $0.06/message on Opus just for tool definitions.

---

Begin cost analysis now. Check for `/cost` data and generate the report.
