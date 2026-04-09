# MCP Tools

> OMC provides MCP tools for state management, code intelligence, and data analysis.

Unlike skills that users invoke directly, tools are used internally by agents during task execution.

## Tool Categories

- [State](#state) — Manage execution mode state
- [Notepad](#notepad) — Persistent notes that survive context compaction
- [Project Memory](#project-memory) — Long-term per-project memory across sessions
- [LSP](#lsp) — Language Server Protocol code intelligence (12 tools)
- [AST Grep](#ast-grep) — Structural AST-based code search and replacement
- [Python REPL](#python-repl) — Persistent Python execution environment
- [Session Search](#session-search) — Search previous session history
- [Trace](#trace) — Agent flow trace analysis
- [Shared Memory](#shared-memory) — Cross-agent shared memory for team coordination
- [Skills](#skills) — Internal skill management tools
- [Deepinit Manifest](#deepinit-manifest) — Incremental AGENTS.md regeneration manifest

---

## State

State tools manage the state of OMC execution modes (autopilot, ralph, ultrawork, etc.). Each mode records its current progress, active status, and configuration in state files.

### Storage Path

```
.omc/state/
├── sessions/{sessionId}/     # Session-scoped state
│   ├── autopilot-state.json
│   ├── ralph-state.json
│   └── ultrawork-state.json
├── autopilot-state.json      # Legacy fallback
├── ralph-state.json
└── ultrawork-state.json
```

When a session ID is provided, the session-scoped path is used; otherwise the legacy path is used as a fallback.

### Tools

#### `state_read`

Reads the state for a given mode.

```
state_read(mode="ralph")
state_read(mode="ralph", session_id="abc123")
```

Returns an empty response if no state file exists.

#### `state_write`

Saves the state for a given mode.

```
state_write(mode="ralph", state={
  active: true,
  current_phase: "execution",
  iteration: 3,
  max_iterations: 10
})
```

#### `state_clear`

Deletes the state file for a given mode.

```
state_clear(mode="ralph")
state_clear(mode="ralph", session_id="abc123")
```

When called without a session ID, clears the legacy file.

#### `state_list_active`

Lists all currently active sessions.

```
state_list_active()
```

Returns all session IDs and their corresponding modes under `.omc/state/sessions/`.

#### `state_get_status`

Returns a status summary for a specific session.

```
state_get_status(session_id="abc123")
```

Includes the active mode name and whether dependent modes exist.

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `OMC_STATE_DIR` | (unset) | Centralized state directory. When set, state persists even if the worktree is deleted. |

When `OMC_STATE_DIR` is set, state is stored at `$OMC_STATE_DIR/{project-id}/`.

```bash
export OMC_STATE_DIR="$HOME/.claude/omc"
```

### Usage Patterns

**Activate a mode:**

```
state_write(mode="autopilot", state={
  active: true,
  current_phase: "expansion",
  started_at: "2024-01-15T09:00:00Z"
})
```

**Deactivate a mode:**

```
state_clear(mode="autopilot")
```

**Check active modes:**

```
state_list_active()
→ [{session_id: "abc123", mode: "ralph", active: true}]
```

---

## Notepad

Notepad is a persistent note system that survives context window compaction. In long sessions, when important information from early in the conversation is pushed out of context, notes saved to Notepad are restored after compaction.

### Storage Path

```
.omc/notepad.md
```

### Tools

#### `notepad_read`

Reads the full contents of the notepad.

```
notepad_read()
```

#### `notepad_write_priority`

Saves a note at the highest priority. Restored first during compaction.

```
notepad_write_priority(content="This project uses TypeScript strict mode")
```

Use for architecture decisions, critical constraints, and information that must never be forgotten.

#### `notepad_write_working`

Saves the current working context. General-purpose notes.

```
notepad_write_working(content="Currently refactoring auth module, 3/5 files done")
```

Use for progress tracking, next steps, and information discovered during work.

#### `notepad_write_manual`

Manually saves a note at a specific location.

```
notepad_write_manual(content="Bug: sessionId undefined at session.ts:45")
```

#### `notepad_prune`

Cleans up old or unnecessary notes.

```
notepad_prune()
```

#### `notepad_stats`

Returns statistics about the notepad (entry count, size, etc.).

```
notepad_stats()
```

### Usage Patterns

**Record an important decision:**

```
notepad_write_priority(content="DB migration: PostgreSQL → MySQL is forbidden. Existing query compatibility issue.")
```

**Track work progress:**

```
notepad_write_working(content="TODO: 1. Fix auth module ✓  2. Add tests  3. Update docs")
```

**Restore context when resuming a session:**

```
notepad_read()
→ "Currently refactoring auth. src/auth/login.ts done. Next: src/auth/session.ts"
```

### Compaction Behavior

When Claude Code compacts context:

1. Notepad contents are included in the compaction result
2. Priority notes are restored first
3. Working notes are restored next
4. Pruned notes are excluded

Core context is preserved even in very long sessions.

---

## Project Memory

Project Memory manages long-term per-project memory. It persists project structure, rules, learned knowledge, and directives across sessions, enabling agents to quickly understand project context.

### Storage Path

```
.omc/project-memory.json
```

### Tools

#### `project_memory_read`

Reads the full contents of project memory.

```
project_memory_read()
```

Returns all stored notes and directives for the project.

#### `project_memory_write`

Overwrites project memory entirely.

```
project_memory_write(content={
  notes: ["Uses TypeScript strict mode", "Tests use vitest"],
  directives: ["JSDoc required on all functions"]
})
```

> **Warning:** This completely replaces existing content. For partial updates, use `project_memory_add_note` or `project_memory_add_directive` instead.

#### `project_memory_add_note`

Adds a note about the project.

```
project_memory_add_note(note="src/utils/ should contain pure functions only")
```

Use for project structure, patterns, and learned knowledge.

#### `project_memory_add_directive`

Adds a directive that agents must follow.

```
project_memory_add_directive(directive="Use structured logging instead of console.log")
```

Use for coding rules, prohibitions, and requirements.

### Notes vs Directives

| | Notes | Directives |
|---|---|---|
| Nature | Information, observations, learned knowledge | Rules, constraints, requirements |
| Example | "This project uses a monorepo structure" | "No PRs without tests" |
| Agent behavior | Used as reference for decisions | Must be strictly followed |

### Notepad vs Project Memory

| | Notepad | Project Memory |
|---|---|---|
| Scope | Current session | Entire project (persists across sessions) |
| Purpose | In-progress notes | Project rules, structure, learned knowledge |
| File | `.omc/notepad.md` | `.omc/project-memory.json` |
| Compaction | Restored during compaction | Always available |

### Usage Patterns

**Register project rules:**

```
project_memory_add_directive("This repo uses conventional commits")
project_memory_add_directive("Files under src/generated/ must not be edited manually")
```

**Record codebase structure:**

```
project_memory_add_note("API layer: src/api/ → src/services/ → src/repositories/")
project_memory_add_note("Auth: JWT + passport.js, implemented in src/auth/")
```

**Record learned knowledge:**

```
project_memory_add_note("tsconfig paths settings need to be kept in sync with jest.config")
```

---

## LSP

LSP tools provide Language Server Protocol-based code intelligence: type information, go-to-definition, find references, error diagnostics, symbol search, and renaming.

A language server must be installed (e.g., `typescript-language-server`, `ty`, `rust-analyzer`, `gopls`). Use `lsp_servers()` to check installation status.

### Tools

#### `lsp_hover`

Returns type information and documentation at the specified position.

```
lsp_hover(file="src/auth.ts", line=42, character=10)
```

#### `lsp_goto_definition`

Navigates to the definition of a symbol.

```
lsp_goto_definition(file="src/auth.ts", line=42, character=10)
```

#### `lsp_find_references`

Finds all usage locations of a symbol.

```
lsp_find_references(file="src/auth.ts", line=42, character=10)
```

#### `lsp_document_symbols`

Returns the structural outline of a file (functions, classes, interfaces, etc.).

```
lsp_document_symbols(file="src/auth.ts")
```

#### `lsp_workspace_symbols`

Searches for symbols across the entire workspace.

```
lsp_workspace_symbols(query="UserConfig")
```

#### `lsp_diagnostics`

Returns errors, warnings, and hints for a file.

```
lsp_diagnostics(file="src/auth.ts")
```

Useful for immediately checking type errors after a code change.

#### `lsp_diagnostics_directory`

Returns diagnostics for an entire directory or project.

```
lsp_diagnostics_directory(path="src/")
```

Use after complex multi-file changes to check project-wide type errors.

#### `lsp_prepare_rename`

Checks whether a rename operation at the given position is valid.

```
lsp_prepare_rename(file="src/auth.ts", line=42, character=10)
```

#### `lsp_rename`

Renames a symbol across the entire project.

```
lsp_rename(file="src/auth.ts", line=42, character=10, newName="AuthService")
```

#### `lsp_code_actions`

Returns available refactoring actions for a range.

```
lsp_code_actions(file="src/auth.ts", startLine=40, endLine=50)
```

#### `lsp_code_action_resolve`

Returns detailed information for a specific code action.

```
lsp_code_action_resolve(action=<action_object>)
```

#### `lsp_servers`

Returns the list of available language servers and their installation status.

```
lsp_servers()
```

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `OMC_LSP_TIMEOUT_MS` | `15000` | LSP request timeout in ms. Increase for large repos or slow servers. |

### Troubleshooting

| Problem | Solution |
|---------|----------|
| LSP tools not working | Install the language server: `npm install -g typescript-language-server` |
| Timeout errors | Increase `OMC_LSP_TIMEOUT_MS` |
| Check server status | Run `lsp_servers()` to verify installation |

---

## AST Grep

AST Grep tools use [@ast-grep/napi](https://ast-grep.github.io/) to search and replace structural code patterns. Because it operates on AST (Abstract Syntax Tree) rather than regex, it matches code structure precisely.

### Tools

#### `ast_grep_search`

Searches code using AST patterns.

```
ast_grep_search(
  pattern="console.log($$$ARGS)",
  lang="typescript"
)
```

**Meta variables:**

| Meta Variable | Description | Example |
|---|---|---|
| `$VAR` | Matches a single AST node | `$VAR.map($FUNC)` |
| `$$$` | Matches multiple AST nodes | `console.log($$$ARGS)` |

**Examples:**

```
# Find all console.log calls
ast_grep_search(pattern="console.log($$$)", lang="typescript")

# Find specific fetch call patterns
ast_grep_search(pattern="fetch($URL, { method: 'POST', $$$REST })", lang="typescript")

# Find React useState usage
ast_grep_search(pattern="const [$STATE, $SETTER] = useState($INIT)", lang="tsx")

# Find try-catch blocks
ast_grep_search(pattern="try { $$$ } catch($ERR) { $$$ }", lang="typescript")
```

#### `ast_grep_replace`

Replaces code using structural AST patterns.

```
ast_grep_replace(
  pattern="console.log($$$ARGS)",
  replacement="logger.info($$$ARGS)",
  lang="typescript",
  dryRun=true
)
```

> **Always run with `dryRun=true` first to review changes before applying.**

**Examples:**

```
# Replace console.log with logger.info
ast_grep_replace(
  pattern="console.log($$$ARGS)",
  replacement="logger.info($$$ARGS)",
  lang="typescript",
  dryRun=true
)

# Convert synchronous functions to async
ast_grep_replace(
  pattern="function $NAME($$$PARAMS) { $$$BODY }",
  replacement="async function $NAME($$$PARAMS) { $$$BODY }",
  lang="typescript",
  dryRun=true
)
```

### AST Grep vs Regex

| | Regex (Grep) | AST Grep |
|---|---|---|
| Matches against | Text patterns | Code structure |
| Whitespace/newlines | Sensitive | Irrelevant |
| Comments | Matched | Skipped |
| Refactoring safety | Risky | Structure-preserving |
| Use case | Text search | Code transformation |

### Supported Languages

TypeScript, JavaScript, TSX, JSX, Python, Go, Rust, Java, C, C++, C#, Ruby, Swift, Kotlin, and most major programming languages.

---

## Python REPL

Python REPL is a Python execution environment where state persists across calls within a session. Used for data analysis, statistical computation, visualization, and prototyping.

### Tool

#### `python_repl`

Executes Python code and returns the result.

```
python_repl(code="import json; data = json.loads('{\"key\": \"value\"}'); print(data)")
```

### Features

**Persistent state:** Variables, functions, and imports defined in one call remain available in subsequent calls.

```python
# First call
python_repl(code="import pandas as pd; df = pd.read_csv('data.csv')")

# Second call (df is still available)
python_repl(code="print(df.describe())")
```

**Data analysis:**

```python
python_repl(code="""
import json
with open('.omc/research/session-1/state.json') as f:
    state = json.load(f)
print(f"Stages: {len(state['stages'])}")
print(f"Status: {state['status']}")
""")
```

**Computation and transformation:**

```python
python_repl(code="""
# Token cost estimation
input_tokens = 150000
output_tokens = 50000
cost = (input_tokens * 0.003 + output_tokens * 0.015) / 1000
print(f"Estimated cost: ${cost:.4f}")
""")
```

**File processing:**

```python
python_repl(code="""
import os

# Project file statistics
extensions = {}
for root, dirs, files in os.walk('src'):
    for f in files:
        ext = os.path.splitext(f)[1]
        extensions[ext] = extensions.get(ext, 0) + 1

for ext, count in sorted(extensions.items(), key=lambda x: -x[1]):
    print(f"{ext}: {count} files")
""")
```

### Use Cases

| Use Case | Description |
|----------|-------------|
| Data analysis | Analyze CSV/JSON files, compute statistics |
| Prototyping | Validate algorithms, test logic |
| File processing | File transformation, batch processing |
| Visualization | Generate charts with matplotlib or plotly |
| Computation | Math calculations, cost estimation |

### Integration with scientist Agent

The `scientist` agent uses `python_repl` for data analysis tasks.

---

## Session Search

Search previous local session history and transcript artifacts.

### Tool

#### `session_search`

Searches session history and returns matching excerpts.

```
session_search(query="authentication refactor")
```

Returns session IDs, timestamps, source paths, and matching excerpts as structured JSON.

---

## Trace

Analyze agent flow trace data for debugging and performance analysis.

### Tools

#### `trace_timeline`

Displays hooks, keywords, skills, agents, and tools in chronological order.

```
trace_timeline()
```

#### `trace_summary`

Aggregates hook statistics, keyword frequency, skill activations, mode transitions, and tool bottlenecks.

```
trace_summary()
```

---

## Shared Memory

Cross-agent shared memory for team coordination. Enables agents to share data across team boundaries during coordinated workflows.

### Tools

#### `shared_memory_write`

Writes a value to shared memory.

```
shared_memory_write(key="auth-spec", value="JWT with refresh tokens")
```

#### `shared_memory_read`

Reads a value from shared memory.

```
shared_memory_read(key="auth-spec")
```

#### `shared_memory_list`

Lists all keys in shared memory.

```
shared_memory_list()
```

#### `shared_memory_delete`

Deletes a key from shared memory.

```
shared_memory_delete(key="auth-spec")
```

#### `shared_memory_cleanup`

Removes all entries from shared memory.

```
shared_memory_cleanup()
```

---

## Skills

Internal skill management tools used by the runtime to load and list available skills.

### Tools

#### `load_omc_skills_local`

Loads skills from the local project directory (`.omc/skills/`).

```
load_omc_skills_local()
```

#### `load_omc_skills_global`

Loads skills from the global user directory (`~/.claude/skills/`).

```
load_omc_skills_global()
```

#### `list_omc_skills`

Lists all available OMC skills (built-in + local + global).

```
list_omc_skills()
```

---

## Deepinit Manifest

Manages the manifest for incremental AGENTS.md regeneration. Compares directory file lists to detect structural changes, enabling the `deepinit` skill to only regenerate documentation for directories that have changed.

### Tool

#### `deepinit_manifest`

Manages the deepinit manifest with three actions.

**diff** — Find directories with structural changes since last generation:

```
deepinit_manifest(action="diff")
```

**save** — Persist the current directory structure as the new baseline:

```
deepinit_manifest(action="save")
```

**check** — Validate the existing manifest:

```
deepinit_manifest(action="check")
```

Used internally by the `deepinit` skill (`/oh-my-claudecode:deepinit`) to enable incremental AGENTS.md regeneration instead of full re-scans.
