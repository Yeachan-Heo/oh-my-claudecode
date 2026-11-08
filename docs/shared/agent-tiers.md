# Agent Selection Guide

This is the single source of truth for agent selection. Use base agent names with explicit model parameter for model selection.

## Agent by Domain

| Domain | Agent | Typical Models | Use Cases |
|--------|-------|---|----------|
| **Analysis** | `architect` | sonnet, opus | Debugging, architecture review, complex analysis |
| **Execution** | `executor` | haiku, sonnet, opus | Implementation, refactoring, code changes |
| **Search** | `explore` | haiku | Fast file/pattern search |
| **Research** | `document-specialist` | sonnet | API documentation, external references |
| **Frontend** | `designer` | haiku, sonnet, opus | UI/UX components, design systems |
| **Docs** | `writer` | haiku | Documentation, comments, writing |
| **Visual** | `vision` | sonnet | Image/screenshot analysis |
| **Planning** | `planner` | opus | Strategic planning, roadmaps |
| **Critique** | `critic` | opus | Plan/design review, validation |
| **Pre-Planning** | `analyst` | opus | Requirements analysis, discovery |
| **Testing** | `qa-tester` | sonnet | Interactive CLI testing |
| **Security** | `security-reviewer` | sonnet, opus | Security audits, vulnerability review |
| **TDD** | `test-engineer` | sonnet | Test-driven development |
| **Code Review** | `code-reviewer` | opus | Code quality review |
| **Data** | `scientist` | sonnet, opus | Data analysis, hypothesis testing |
| **Git** | `git-master` | sonnet | Commit strategy, history |
| **Simplification** | `code-simplifier` | sonnet | Code cleanup, removal of unnecessary complexity |

## Model Selection

Use the `model` parameter to override an agent's default model:

| Model | When to Use | Example Tasks |
|-------|---|---|
| **haiku** | Quick lookups, trivial changes | "What does X return?", "Add simple validation" |
| **sonnet** | Feature work, standard debugging | "Implement feature", "Debug this error" |
| **opus** | Complex analysis, refactoring | "Refactor this system", "Review architecture" |

Examples:
```
executor (model="haiku")              # Simple change with cheap model
architect (model="opus")              # Complex debugging with powerful model
designer (model="sonnet")             # Standard UI component work
```

## Agent Selection by Task

| Task | Best Agent | Recommended Model |
|------|------------|---|
| Quick code lookup | `explore` | haiku |
| Find files/patterns | `explore` | haiku |
| Simple code change | `executor` | haiku |
| Feature implementation | `executor` | sonnet |
| Complex refactoring | `executor` | opus |
| Debug simple issue | `architect` | haiku |
| Debug complex issue | `architect` | opus |
| UI component | `designer` | sonnet |
| Complex UI system | `designer` | opus |
| Write docs | `writer` | haiku |
| Research APIs | `document-specialist` | sonnet |
| Analyze images | `vision` | sonnet |
| Strategic planning | `planner` | opus |
| Review plan/design | `critic` | opus |
| Audit security | `security-reviewer` | opus |
| Data analysis | `scientist` | opus |
| Code review | `code-reviewer` | opus |

## Cost Optimization

For delegated work, match model to task complexity:

- **Haiku (cheapest)**: Quick lookups, file discovery, simple syntax fixes
- **Sonnet (balanced)**: Feature work, debugging, standard analysis
- **Opus (powerful)**: Architecture, complex refactoring, security audits

Use haiku for simple tasks to reduce cost. Use opus for complex analysis where quality matters most.
