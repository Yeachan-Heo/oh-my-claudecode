---
name: context-doctor
description: Audit context window usage, recommend compaction timing, and optimize token consumption across MCP servers, skills, and CLAUDE.md
level: 2
aliases: [ctx, context-audit, context-check]
argument-hint: [audit|optimize|watch] - default is audit
---

# Context Doctor Skill

Diagnose and optimize your Claude Code context window usage. Prevents context overflow, identifies token-heavy components, and recommends actionable optimizations.

## Usage

```
/oh-my-claudecode:context-doctor
/oh-my-claudecode:context-doctor audit
/oh-my-claudecode:context-doctor optimize
/oh-my-claudecode:ctx
```

Or say: "context audit", "check my context", "why is context full", "token usage"

## Workflow

### 1. Gather Context Metrics

Collect current context state:

```bash
# Check active MCP servers and their tool counts
claude mcp list 2>/dev/null || echo "No MCP config found"
```

Read the following to measure token sources:
- Project CLAUDE.md (and any parent CLAUDE.md files)
- `~/.claude/CLAUDE.md` (global instructions)
- `.mcp.json` or `~/.claude/.mcp.json` (MCP server count)
- Active skills (check `state_list_active()`)
- Any AGENTS.md files in the project

### 2. Analyze Token Budget

Estimate token consumption by source:

| Source | Typical Tokens | Risk Level |
|--------|---------------|------------|
| Global CLAUDE.md | 500-2000 | Low |
| Project CLAUDE.md | 500-5000 | Medium |
| Each MCP server | 2000-4000 | High if 6+ |
| Each active skill | 1000-3000 | Medium |
| AGENTS.md (each) | 500-2000 | Low |
| Hook injections | 200-500 each | Low |
| Conversation history | Variable | Grows over time |

**Critical threshold**: When estimated overhead exceeds 30K tokens, recommend immediate optimization.

**Warning threshold**: When estimated overhead exceeds 20K tokens, flag for review.

Calculate:
- `mcp_overhead = num_mcp_servers * 3000` (average tool definitions per server)
- `static_overhead = claude_md_tokens + agents_md_tokens + hook_tokens`
- `total_overhead = mcp_overhead + static_overhead`
- `available_for_work = context_window - total_overhead`

### 3. Generate Audit Report

Output a structured report:

```
[CONTEXT DOCTOR] Audit Report
═══════════════════════════════════════════

Context Window: ~200K tokens (model dependent)
Estimated Static Overhead: {total_overhead} tokens ({percentage}%)

┌─────────────────────────────────────────┐
│ SOURCE BREAKDOWN                         │
├──────────────────┬──────────┬───────────┤
│ Source           │ Est. Tokens │ Status  │
├──────────────────┼──────────┼───────────┤
│ Global CLAUDE.md │ {n}      │ {ok/warn} │
│ Project CLAUDE.md│ {n}      │ {ok/warn} │
│ MCP Servers ({n})│ {n}      │ {ok/warn} │
│ Active Skills    │ {n}      │ {ok/warn} │
│ AGENTS.md files  │ {n}      │ {ok/warn} │
│ Hook overhead    │ {n}      │ {ok/warn} │
└──────────────────┴──────────┴───────────┘

Available for conversation: ~{available}K tokens
```

### 4. Provide Recommendations

Based on findings, recommend specific actions:

**If MCP servers > 5:**
- "You have {n} MCP servers adding ~{tokens}K overhead. Consider disabling unused servers."
- List each server with its tool count
- Recommend which to disable based on usage patterns

**If CLAUDE.md > 3000 tokens:**
- "Your CLAUDE.md is {n} tokens. Consider moving detailed sections to AGENTS.md subdirectory files."
- Identify sections that could be extracted

**If multiple AGENTS.md files:**
- "Found {n} AGENTS.md files adding ~{tokens}K. These are loaded per-directory — consider consolidating."

**If context is healthy:**
- "Context overhead is {n}K ({pct}%) — healthy. You have ~{available}K tokens available."

**Session-specific advice:**
- "You've been in this session for a while. Run `/compact` to reclaim ~{estimate}K tokens."
- "Consider `/clear` if switching to an unrelated task."

### 5. Optimize Mode (if --optimize)

When invoked with `optimize`, take automated action:

1. **Audit first** (steps 1-4 above)
2. **Identify removable MCP servers** — check which servers haven't been used in this session
3. **Suggest CLAUDE.md trimming** — identify sections over 500 tokens that could be more concise
4. **Check for duplicate instructions** — compare global vs project CLAUDE.md for overlapping directives
5. **Recommend model-appropriate context** — if on Haiku, stricter budget; if on Opus, more headroom

Output a prioritized action list:

```
[CONTEXT DOCTOR] Optimization Plan
═══════════════════════════════════════════

Priority 1 (saves ~{n}K tokens):
  → Disable unused MCP server: {name}

Priority 2 (saves ~{n}K tokens):
  → Consolidate AGENTS.md files in {dirs}

Priority 3 (saves ~{n}K tokens):
  → Trim CLAUDE.md section: {section_name}

Estimated savings: ~{total}K tokens ({pct}% of overhead)
```

## Exit Conditions

| Condition | Action |
|-----------|--------|
| **Audit complete** | Display report and recommendations |
| **Optimize complete** | Display report + action list with savings estimate |
| **No issues found** | Display clean bill of health |

## Notes

- **Non-destructive**: Audit mode never modifies files. Optimize mode only suggests changes.
- **Model-aware**: Adjusts thresholds based on the current model's context window (Haiku: 200K, Sonnet: 200K, Opus: 200K)
- **MCP overhead is the #1 cause** of context problems — 6+ servers can consume 20K+ tokens before any conversation starts
- **Quick check**: For a fast health indicator without full audit, just count MCP servers × 3K + CLAUDE.md length

---

Begin context audit now. Parse arguments and start with step 1.
