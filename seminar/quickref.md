# oh-my-claudecode Quick Reference Card
**v3.6.3 | github.com/Yeachan-Heo/oh-my-claudecode**

## Install
```bash
/plugin marketplace add https://github.com/Yeachan-Heo/oh-my-claudecode
/plugin install oh-my-claudecode
/oh-my-claudecode:omc-setup
```

## Execution Modes

| Mode | Keyword | Use Case | Example |
|------|---------|----------|---------|
| Autopilot | `autopilot` | Full autonomous build | `autopilot: build a REST API` |
| Ultrapilot | `ultrapilot` | Parallel autopilot (3-5x) | `ultrapilot: build dashboard` |
| Ultrawork | `ulw` | Parallel task fixing | `ulw fix all errors` |
| Ecomode | `eco` | Budget-friendly parallel | `eco: implement feature` |
| Swarm | `swarm` | N coordinated agents | `/swarm 5:executor "fix errors"` |
| Pipeline | `pipeline` | Sequential chaining | `/pipeline review` |
| Ralph | `ralph` | Persistence until done | `ralph: refactor auth` |
| Plan | `plan` | Planning interview | `plan the API design` |

## Combine Modes
`ralph ulw: migrate database` = persistence + parallelism

## Agent Tiers (28 Total)

| Domain | Haiku (fast) | Sonnet (balanced) | Opus (complex) |
|--------|-------------|-------------------|-----------------|
| Analysis | architect-low | architect-medium | architect |
| Execution | executor-low | executor | executor-high |
| Search | explore | - | explore-high |
| Frontend | designer-low | designer | designer-high |
| Testing | - | qa-tester | - |
| Security | security-rev-low | - | security-reviewer |
| Data Sci | - | scientist | scientist-high |
| Research | - | researcher | - |
| Build | - | build-fixer | - |
| TDD | tdd-guide-low | tdd-guide | - |
| Code Review | - | - | code-reviewer |
| Docs | writer | - | - |
| Visual | - | vision | - |
| Planning | - | - | planner |
| Critique | - | - | critic |

## Pipeline Presets
| Preset | Flow |
|--------|------|
| `review` | explore → architect → critic → executor |
| `implement` | planner → executor → tdd-guide |
| `debug` | explore → architect → build-fixer |
| `research` | parallel(researcher, explore) → architect → writer |
| `refactor` | explore → architect-medium → executor-high → qa-tester |
| `security` | explore → security-reviewer → executor → security-reviewer-low |

**Custom:** `/pipeline explore:haiku -> architect:opus -> executor:sonnet`

## Key Commands
| Command | Purpose |
|---------|---------|
| `/oh-my-claudecode:omc-setup` | Initial setup wizard |
| `/oh-my-claudecode:hud setup` | Enable HUD statusline |
| `/oh-my-claudecode:omc-doctor` | Diagnose issues |
| `/oh-my-claudecode:omc-help` | Show usage guide |
| `/oh-my-claudecode:cancel` | Stop current operation |
| `/oh-my-claudecode:note` | Save compaction-resilient note |
| `/oh-my-claudecode:learner` | Extract reusable skill |
| `/oh-my-claudecode:analyze` | Deep analysis/debugging |
| `/oh-my-claudecode:deepsearch` | Thorough codebase search |
| `/oh-my-claudecode:ultraqa` | QA cycling (test/fix/repeat) |
| `/oh-my-claudecode:tdd` | Test-driven development mode |

## Natural Language (No Commands Needed)
- "build me a todo app" → Autopilot activates
- "fix all errors fast" → Ultrawork activates (or config default)
- "don't stop until done" → Ralph activates
- "plan the authentication" → Planning interview starts
- "stop" / "cancel" → Intelligently cancels active operation

## Delegation Categories (Auto-Detection)
| Category | Model | Temp | Thinking | Use For |
|----------|-------|------|----------|---------|
| `visual-engineering` | Opus | 0.7 | high | UI/UX, frontend, design |
| `ultrabrain` | Opus | 0.3 | max | Complex reasoning, architecture |
| `artistry` | Sonnet | 0.9 | medium | Creative solutions |
| `quick` | Haiku | 0.1 | low | Simple lookups |
| `writing` | Sonnet | 0.5 | medium | Documentation |

## Plan Notepads (Wisdom Capture)
**Location:** `.omc/notepads/{plan-name}/`
- `learnings.md` - Technical discoveries and patterns
- `decisions.md` - Architectural and design decisions
- `issues.md` - Known issues and workarounds
- `problems.md` - Blockers and challenges

## State Files
- `.omc/state/ultrapilot-state.json` - Ultrapilot session
- `.omc/state/ultrapilot-ownership.json` - File ownership
- `.omc/state/swarm-{id}.json` - Swarm coordination
- `.omc/state/pipeline-{id}.json` - Pipeline progress

## Configuration
**File:** `~/.claude/.omc-config.json`
```json
{
  "defaultExecutionMode": "ultrawork",  // or ""
  "maxParallelAgents": 5,
  "verificationEnabled": true
}
```

## Verification Protocol (Built-in)
Before claiming completion:
1. **IDENTIFY** - What command proves this?
2. **RUN** - Execute verification
3. **READ** - Check output for pass/fail
4. **CLAIM** - Only then say "done" with evidence

**Standard Checks:** BUILD, TEST, LINT, FUNCTIONALITY, ARCHITECT, TODO, ERROR_FREE

## Tips
- **Combine modes:** `ralph ulw`, `ralph eco`, `ralplan` (ralph + plan)
- **Explicit keywords override defaults:** `eco` beats config, `ulw` beats config
- **Conflict resolution:** Both `ulw` and `eco` → `eco` wins (more restrictive)
- **Generic "fast"/"parallel"** → Uses config `defaultExecutionMode` (default: `ultrawork`)
- **State cleanup:** `/cancel --all` clears all states
- **Resume background:** Use `resume-session` tool for interrupted agents
- **LSP diagnostics:** Full project type checking with `lsp_diagnostics_directory`

## Resources
- **GitHub:** github.com/Yeachan-Heo/oh-my-claudecode
- **Docs:** /docs/REFERENCE.md
- **Website:** yeachan-heo.github.io/oh-my-claudecode-website
- **NPM:** `npm i -g oh-my-claudecode`
- **Discord:** (community support - link in GitHub)

---
**Pro Tips:**
- Start with **autopilot** for new projects - it handles everything
- Use **ultrapilot** when you need speed (3-5x faster, parallel workers)
- Use **ralph** when you absolutely need completion guarantee
- Use **eco** when managing token budgets on large tasks
- Use **swarm** for distributed work across many files
- Use **pipeline** for multi-stage workflows with quality gates
