# OMC Analytics CLI

Command-line interface for Oh-My-ClaudeCode analytics, token tracking, cost reports, and session management.

## Installation

After installing oh-my-claudecode:

```bash
npm install -g oh-my-claudecode
```

The `omc-analytics` command will be available globally.

## Commands

### Stats

Show current session statistics including token usage, costs, and top agents.

```bash
omc-analytics stats
omc-analytics stats --json
```

### Cost Reports

Generate cost reports for different time periods.

```bash
omc-analytics cost daily
omc-analytics cost weekly
omc-analytics cost monthly
omc-analytics cost monthly --json
```

### Session History

View historical session data.

```bash
omc-analytics sessions
omc-analytics sessions --limit 20
omc-analytics sessions --json
```

### Agent Usage

Show agent usage breakdown by tokens and cost.

```bash
omc-analytics agents
omc-analytics agents --limit 20
omc-analytics agents --json
```

### Export Data

Export analytics data to JSON or CSV format.

```bash
# Export cost report
omc-analytics export cost json ./cost-report.json
omc-analytics export cost csv ./cost-report.csv --period weekly

# Export session history
omc-analytics export sessions json ./sessions.json
omc-analytics export sessions csv ./sessions.csv

# Export usage patterns
omc-analytics export patterns json ./patterns.json
```

### Cleanup

Remove old logs and orphaned background tasks.

```bash
omc-analytics cleanup
omc-analytics cleanup --retention 60  # Keep 60 days instead of default 30
```

## Data Storage

Analytics data is stored in:
- `~/.omc/analytics/tokens/` - Token usage logs
- `~/.omc/analytics/sessions/` - Session history
- `~/.omc/analytics/metrics/` - Performance metrics

## JSON Output

All commands support `--json` flag for machine-readable output, useful for integration with other tools or scripts.

```bash
# Example: Parse JSON output with jq
omc-analytics stats --json | jq '.stats.totalCost'
omc-analytics agents --json | jq '.topAgents[0].agent'
```

## Examples

### Daily Cost Tracking

```bash
# Check today's cost
omc-analytics cost daily

# Export weekly report
omc-analytics export cost csv weekly-report.csv --period weekly
```

### Session Analysis

```bash
# View recent sessions
omc-analytics sessions --limit 5

# Export all sessions for analysis
omc-analytics export sessions json all-sessions.json
```

### Agent Performance

```bash
# See which agents are most expensive
omc-analytics agents --limit 10

# Export for spreadsheet analysis
omc-analytics export patterns csv agent-patterns.csv
```

### Maintenance

```bash
# Monthly cleanup (keep 90 days of data)
omc-analytics cleanup --retention 90
```
