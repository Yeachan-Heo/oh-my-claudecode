# Scripts

## ralph-fresh.ts

External orchestrator for Ralph Fresh Context mode. Spawns fresh Claude Code instances for each iteration, avoiding context accumulation and token limits.

### Usage

```bash
./scripts/ralph-fresh.ts "Build a todo app" [options]
```

### Options

- `--max-iterations <n>` - Maximum number of iterations before stopping (default: 20)
- `--max-turns <n>` - Maximum turns per Claude instance (default: 100)
- `--verbose` - Enable verbose logging
- `--prd` - PRD mode flag (reserved for future use)

### How It Works

1. Initializes or loads handoff state from `.omc/state/ralph-fresh-handoff.json`
2. For each iteration:
   - Refreshes state from files (PRD, progress.txt, git history)
   - Checks if PRD is complete (all stories done)
   - Detects stuck state (same story for N iterations)
   - Generates iteration prompt with current state
   - Spawns fresh Claude instance via `claude -p` command
   - Checks for completion promise `<promise>TASK_COMPLETE</promise>`
3. Saves final state and reports result

### State Files

- `.omc/state/ralph-fresh-handoff.json` - Orchestration state between iterations
- `.omc/state/iteration-prompt.txt` - Last generated prompt (for debugging)
- `.omc/prd.json` - Product Requirements Document (if using PRD mode)
- `.omc/progress.txt` - Accumulated learnings and patterns

### Signal Handling

- **SIGINT (Ctrl+C)**: Saves state and exits gracefully (exit code 130)
- **SIGTERM**: Saves state and exits gracefully

### Retry Logic

Automatically retries on known transient errors:
- "tool_use ids must be unique" (API bug)
- "tool use concurrency" errors

Default: 3 retry attempts with 5 second delays

### Completion Detection

The agent must output `<promise>TASK_COMPLETE</promise>` to signal completion. Any text after the promise tag is captured as the completion message.

### Examples

```bash
# Basic usage
./scripts/ralph-fresh.ts "Implement user authentication"

# With custom iterations
./scripts/ralph-fresh.ts "Build API server" --max-iterations 30

# Verbose mode
./scripts/ralph-fresh.ts "Refactor database layer" --verbose

# Resume from previous session
./scripts/ralph-fresh.ts "Continue previous task"
```

### Testing

```bash
npm test -- src/scripts/__tests__/ralph-fresh.test.ts
```
