# Performance Monitoring Guide

Comprehensive guide to monitoring, debugging, and optimizing Claude Code and oh-my-claudecode performance.

---

## Table of Contents

- [Overview](#overview)
- [Built-in Monitoring](#built-in-monitoring)
  - [Agent Observatory](#agent-observatory)
  - [Token & Cost Analytics](#token--cost-analytics)
  - [Session Replay](#session-replay)
- [HUD Integration](#hud-integration)
- [Debugging Techniques](#debugging-techniques)
- [External Resources](#external-resources)
- [Best Practices](#best-practices)
- [Troubleshooting](#troubleshooting)

---

## Overview

oh-my-claudecode provides comprehensive monitoring capabilities for tracking agent performance, token usage, costs, and identifying bottlenecks in multi-agent workflows. This guide covers both built-in tools and external resources for monitoring Claude's performance.

### What You Can Monitor

| Metric | Tool | Granularity |
|--------|------|-------------|
| Agent lifecycle | Agent Observatory | Per-agent |
| Tool timing | Session Replay | Per-tool call |
| Token usage | Analytics System | Per-session/agent |
| API costs | Analytics System | Per-session/daily/monthly |
| File ownership | Subagent Tracker | Per-file |
| Parallel efficiency | Observatory | Real-time |

---

## Built-in Monitoring

### Agent Observatory

The Agent Observatory provides real-time visibility into all running agents, their performance metrics, and potential issues.

#### Accessing the Observatory

The observatory is automatically displayed in the HUD when agents are running. You can also query it programmatically:

```typescript
import { getAgentObservatory } from 'oh-my-claudecode/hooks/subagent-tracker';

const obs = getAgentObservatory(process.cwd());
console.log(obs.header);  // "Agent Observatory (3 active, 85% efficiency)"
obs.lines.forEach(line => console.log(line));
```

#### Observatory Output

```
Agent Observatory (3 active, 85% efficiency)
🟢 [a1b2c3d] executor 45s tools:12 tokens:8k $0.15 files:3
🟢 [e4f5g6h] researcher 30s tools:5 tokens:3k $0.08
🟡 [i7j8k9l] architect 120s tools:8 tokens:15k $0.42
   └─ bottleneck: Grep (2.3s avg)
⚠ architect: Cost $0.42 exceeds threshold
```

#### Status Indicators

| Icon | Meaning |
|------|---------|
| 🟢 | Healthy - agent running normally |
| 🟡 | Warning - intervention suggested |
| 🔴 | Critical - stale agent (>5 min) |

#### Key Metrics

| Metric | Description |
|--------|-------------|
| `tools:N` | Number of tool calls made |
| `tokens:Nk` | Approximate token usage (thousands) |
| `$X.XX` | Estimated cost in USD |
| `files:N` | Files being modified |
| `bottleneck` | Slowest repeated tool operation |

### Token & Cost Analytics

OMC automatically tracks token usage and costs across all sessions.

#### CLI Commands

```bash
# View current session stats
omc stats

# View daily/weekly/monthly cost reports
omc cost daily
omc cost weekly
omc cost monthly

# View session history
omc sessions

# View agent breakdown
omc agents

# Export data
omc export cost csv ./costs.csv
```

#### Real-time HUD Display

Enable the analytics preset for detailed cost tracking in your status line:

```json
{
  "omcHud": {
    "preset": "analytics"
  }
}
```

This shows:
- Session cost and tokens
- Cost per hour
- Cache efficiency (% of tokens from cache)
- Budget warnings (>$2 warning, >$5 critical)

#### Backfill Historical Data

Analyze historical Claude Code transcripts:

```bash
# Preview available transcripts
omc backfill --dry-run

# Backfill all transcripts
omc backfill

# Backfill specific project
omc backfill --project "*my-project*"

# Backfill recent only
omc backfill --from "2026-01-01"
```

### Session Replay

Session replay records agent lifecycle events as JSONL for post-session analysis and timeline visualization.

#### Event Types

| Event | Description |
|-------|-------------|
| `agent_start` | Agent spawned with task info |
| `agent_stop` | Agent completed/failed with duration |
| `tool_start` | Tool invocation begins |
| `tool_end` | Tool completes with timing |
| `file_touch` | File modified by agent |
| `intervention` | System intervention triggered |

#### Replay Files

Replay data is stored at: `.omc/state/agent-replay-{sessionId}.jsonl`

Each line is a JSON event:
```json
{"t":0.0,"agent":"a1b2c3d","agent_type":"executor","event":"agent_start","task":"Implement feature","parent_mode":"ultrawork"}
{"t":5.2,"agent":"a1b2c3d","event":"tool_start","tool":"Read"}
{"t":5.4,"agent":"a1b2c3d","event":"tool_end","tool":"Read","duration_ms":200,"success":true}
```

#### Analyzing Replay Data

```typescript
import { getReplaySummary } from 'oh-my-claudecode/hooks/subagent-tracker/session-replay';

const summary = getReplaySummary(process.cwd(), sessionId);

console.log(`Duration: ${summary.duration_seconds}s`);
console.log(`Agents: ${summary.agents_spawned} spawned, ${summary.agents_completed} completed`);
console.log(`Bottlenecks:`, summary.bottlenecks);
console.log(`Files touched:`, summary.files_touched);
```

#### Bottleneck Detection

The replay system automatically identifies bottlenecks:
- Tools averaging >1s with 2+ calls
- Per-agent tool timing analysis
- Sorted by impact (highest avg time first)

---

## HUD Integration

### Presets

| Preset | Focus | Elements |
|--------|-------|----------|
| `minimal` | Clean status | Context bar only |
| `focused` | Task progress | Todos, agents, modes |
| `full` | Everything | All elements enabled |
| `analytics` | Cost tracking | Tokens, costs, efficiency |
| `dense` | Compact all | Compressed format |

### Configuration

Edit `~/.claude/settings.json`:

```json
{
  "omcHud": {
    "preset": "focused",
    "elements": {
      "agents": true,
      "todos": true,
      "contextBar": true,
      "analytics": true
    }
  }
}
```

### Custom Elements

| Element | Description |
|---------|-------------|
| `agents` | Active agent count and status |
| `todos` | Todo progress (completed/total) |
| `ralph` | Ralph loop iteration count |
| `autopilot` | Autopilot phase indicator |
| `contextBar` | Context window usage % |
| `analytics` | Token/cost summary |

---

## Debugging Techniques

### Identifying Slow Agents

1. **Check the Observatory** for agents running >2 minutes
2. **Look for bottleneck indicators** (tool averaging >1s)
3. **Review tool_usage** in agent state

```typescript
import { getAgentPerformance } from 'oh-my-claudecode/hooks/subagent-tracker';

const perf = getAgentPerformance(process.cwd(), agentId);
console.log('Tool timings:', perf.tool_timings);
console.log('Bottleneck:', perf.bottleneck);
```

### Detecting File Conflicts

When multiple agents modify the same file:

```typescript
import { detectFileConflicts } from 'oh-my-claudecode/hooks/subagent-tracker';

const conflicts = detectFileConflicts(process.cwd());
conflicts.forEach(c => {
  console.log(`File ${c.file} touched by: ${c.agents.join(', ')}`);
});
```

### Intervention System

OMC automatically detects problematic agents:

| Intervention | Trigger | Action |
|--------------|---------|--------|
| `timeout` | Agent running >5 min | Kill suggested |
| `excessive_cost` | Cost >$1.00 | Warning |
| `file_conflict` | Multiple agents on file | Warning |

```typescript
import { suggestInterventions } from 'oh-my-claudecode/hooks/subagent-tracker';

const interventions = suggestInterventions(process.cwd());
interventions.forEach(i => {
  console.log(`${i.type}: ${i.reason} → ${i.suggested_action}`);
});
```

### Parallel Efficiency Score

Track how well your parallel agents are performing:

```typescript
import { calculateParallelEfficiency } from 'oh-my-claudecode/hooks/subagent-tracker';

const eff = calculateParallelEfficiency(process.cwd());
console.log(`Efficiency: ${eff.score}%`);
console.log(`Active: ${eff.active}, Stale: ${eff.stale}, Total: ${eff.total}`);
```

- **100%**: All agents actively working
- **<80%**: Some agents stale or waiting
- **<50%**: Significant parallelization issues

### Stale Agent Cleanup

Clean up agents that exceed the timeout threshold:

```typescript
import { cleanupStaleAgents } from 'oh-my-claudecode/hooks/subagent-tracker';

const cleaned = cleanupStaleAgents(process.cwd());
console.log(`Cleaned ${cleaned} stale agents`);
```

---

## External Resources

### Claude Performance Tracking Platforms

#### MarginLab.ai

[MarginLab.ai](https://marginlab.ai) provides external performance tracking for Claude models:

- **SWE-Bench-Pro daily tracking**: Monitor Claude's performance on software engineering benchmarks
- **Statistical significance testing**: Detect performance degradation with confidence intervals
- **Historical trends**: Track Claude's capabilities over time
- **Model comparison**: Compare performance across Claude model versions

#### Usage

Visit the platform to:
1. View current Claude model benchmark scores
2. Check historical performance trends
3. Set up alerts for significant performance changes
4. Compare across model versions (Opus, Sonnet, Haiku)

### Community Resources

| Resource | Description | Link |
|----------|-------------|------|
| Claude Code Discord | Community support and tips | [discord.gg/anthropic](https://discord.gg/anthropic) |
| OMC GitHub Issues | Bug reports and feature requests | [GitHub Issues](https://github.com/Yeachan-Heo/oh-my-claudecode/issues) |
| Anthropic Documentation | Official Claude documentation | [docs.anthropic.com](https://docs.anthropic.com) |

### Model Performance Benchmarks

Track Claude's performance across standard benchmarks:

| Benchmark | What It Measures | Where to Track |
|-----------|-----------------|----------------|
| SWE-Bench | Software engineering tasks | MarginLab.ai |
| HumanEval | Code generation accuracy | Public leaderboards |
| MMLU | General knowledge | Anthropic blog |

---

## Best Practices

### 1. Monitor Token Usage Proactively

```bash
# Set up budget warnings in HUD
/oh-my-claudecode:hud
# Select "analytics" preset
```

### 2. Use Appropriate Model Tiers

| Task Type | Recommended Model | Cost Impact |
|-----------|------------------|-------------|
| File lookup | Haiku | Lowest |
| Feature implementation | Sonnet | Medium |
| Architecture decisions | Opus | Highest |

### 3. Enable Session Replay for Complex Tasks

Session replay is automatically enabled. Review replays after complex workflows:

```bash
# Find replay files
ls .omc/state/agent-replay-*.jsonl

# View recent events
tail -20 .omc/state/agent-replay-*.jsonl
```

### 4. Set Cost Limits

The default cost limit per agent is $1.00 USD. Agents exceeding this trigger warnings.

### 5. Review Bottlenecks Regularly

After completing complex tasks, check the replay summary:

```typescript
const summary = getReplaySummary(cwd, sessionId);
if (summary.bottlenecks.length > 0) {
  console.log('Consider optimizing:', summary.bottlenecks[0]);
}
```

### 6. Clean Up Stale State

Periodically clean up old replay files and stale agent state:

```typescript
import { cleanupReplayFiles } from 'oh-my-claudecode/hooks/subagent-tracker/session-replay';

cleanupReplayFiles(process.cwd()); // Keeps last 10 sessions
```

---

## Troubleshooting

### High Token Usage

**Symptoms**: Costs higher than expected, context window filling quickly

**Solutions**:
1. Use `eco` mode for token-efficient execution: `eco fix all errors`
2. Check for unnecessary file reads in agent prompts
3. Review `omc agents` for agent-level breakdown
4. Enable cache - check cache efficiency in analytics

### Slow Agent Execution

**Symptoms**: Agents running >5 minutes, low parallel efficiency

**Solutions**:
1. Check Observatory for bottleneck indicators
2. Review tool_usage for slow operations
3. Consider splitting large tasks into smaller agents
4. Use `architect-low` instead of `architect` for simple verifications

### File Conflicts

**Symptoms**: Merge conflicts, unexpected file changes

**Solutions**:
1. Use `ultrapilot` mode for automatic file ownership
2. Check `detectFileConflicts()` before parallel execution
3. Review file_ownership in agent state
4. Use `swarm` mode with explicit task isolation

### Missing Analytics Data

**Symptoms**: Empty cost reports, no session history

**Solutions**:
1. Run `omc backfill` to import historical transcripts
2. Verify HUD is running: `/oh-my-claudecode:hud setup`
3. Check `.omc/state/` directory exists
4. Review `token-tracking.jsonl` for raw data

### Stale Agent State

**Symptoms**: Observatory showing agents that aren't running

**Solutions**:
1. Run `cleanupStaleAgents(cwd)` programmatically
2. Delete `.omc/state/subagent-tracking.json` to reset
3. Check for orphaned lock files: `.omc/state/subagent-tracker.lock`

---

## State Files Reference

| File | Purpose | Format |
|------|---------|--------|
| `.omc/state/subagent-tracking.json` | Current agent states | JSON |
| `.omc/state/agent-replay-{id}.jsonl` | Session event timeline | JSONL |
| `.omc/state/token-tracking.jsonl` | Token usage log | JSONL |
| `.omc/state/analytics-summary-{id}.json` | Cached session summaries | JSON |
| `.omc/state/subagent-tracker.lock` | Concurrent access lock | Text |

---

## API Reference

### Subagent Tracker

```typescript
// Core tracking
getActiveAgentCount(directory: string): number
getRunningAgents(directory: string): SubagentInfo[]
getTrackingStats(directory: string): { running, completed, failed, total }

// Performance
getAgentPerformance(directory: string, agentId: string): AgentPerformance
getAllAgentPerformance(directory: string): AgentPerformance[]
calculateParallelEfficiency(directory: string): { score, active, stale, total }

// File ownership
recordFileOwnership(directory: string, agentId: string, filePath: string): void
detectFileConflicts(directory: string): Array<{ file, agents }>
getFileOwnershipMap(directory: string): Map<string, string>

// Interventions
suggestInterventions(directory: string): AgentIntervention[]
cleanupStaleAgents(directory: string): number

// Display
getAgentDashboard(directory: string): string
getAgentObservatory(directory: string): { header, lines, summary }
```

### Session Replay

```typescript
// Recording
recordAgentStart(directory, sessionId, agentId, agentType, task?, parentMode?, model?): void
recordAgentStop(directory, sessionId, agentId, agentType, success, durationMs?): void
recordToolEvent(directory, sessionId, agentId, toolName, eventType, durationMs?, success?): void
recordFileTouch(directory, sessionId, agentId, filePath): void

// Analysis
readReplayEvents(directory: string, sessionId: string): ReplayEvent[]
getReplaySummary(directory: string, sessionId: string): ReplaySummary

// Cleanup
cleanupReplayFiles(directory: string): number
```

---

## See Also

- [Analytics System](./ANALYTICS-SYSTEM.md) - Detailed token tracking documentation
- [Reference](./REFERENCE.md) - Complete feature reference
- [Architecture](./ARCHITECTURE.md) - System architecture overview
