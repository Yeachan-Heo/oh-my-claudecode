# Agent Architecture: OpenCode vs Claude Code

This document explains the architectural differences between OpenCode's swappable master agent system and Claude Code's skill-based routing, and how oh-my-claudecode bridges this gap elegantly.

---

## Overview

| Aspect | OpenCode | Claude Code |
|--------|----------|-------------|
| Master Agent | **Swappable** | **Fixed** |
| Sub Agents | Via Task tool | Via Task tool |
| Routing | Agent switching | Skill activation |
| Flexibility | High (any agent as master) | High (via skill composition) |

---

## OpenCode: Swappable Master Agent

### How It Works

In OpenCode (oh-my-opencode), the master agent can be dynamically swapped based on task requirements:

```
┌─────────────────────────────────────────────────────────────┐
│                    OPENCODE RUNTIME                          │
└─────────────────────────────────────────────────────────────┘
                              │
              ┌───────────────┼───────────────┐
              │               │               │
              ▼               ▼               ▼
       ┌─────────────┐ ┌─────────────┐ ┌─────────────┐
       │   DEFAULT   │ │  ARCHITECT  │ │   PLANNER   │
       │  (Default)  │ │  (Debug)    │ │  (Planning) │
       │             │ │             │ │             │
       │ Can become  │ │ Can become  │ │ Can become  │
       │   MASTER    │ │   MASTER    │ │   MASTER    │
       └─────────────┘ └─────────────┘ └─────────────┘
              │               │               │
              └───────────────┼───────────────┘
                              │
                              ▼
                    ┌─────────────────┐
                    │   SUB-AGENTS    │
                    │  (Delegated)    │
                    └─────────────────┘
```

### Agent Switching Flow

```typescript
// OpenCode pseudo-code
class AgentOrchestrator {
  private masterAgent: Agent;

  // Can swap master at runtime
  switchMaster(agentType: 'default' | 'architect' | 'planner') {
    this.masterAgent = AgentFactory.create(agentType);
  }

  // Master delegates to sub-agents
  async execute(task: string) {
    return this.masterAgent.run(task, {
      subAgents: this.availableSubAgents
    });
  }
}

// Usage
orchestrator.switchMaster('planner');  // Planning mode
await orchestrator.execute('Design auth system');

orchestrator.switchMaster('default');    // Implementation mode
await orchestrator.execute('Implement the plan');
```

### Pros
- Direct control over which agent leads
- Clean separation between master behaviors
- Easy to add new master agent types

### Cons
- Requires runtime agent management
- Context can be lost during switches
- More complex state management

---

## Claude Code: Fixed Master with Skills

### The Constraint

Claude Code has a **fixed master agent** - you cannot swap which agent is the "main" one. The conversation always runs through the same Claude instance.

```
┌─────────────────────────────────────────────────────────────┐
│                    CLAUDE CODE RUNTIME                       │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
                    ┌─────────────────┐
                    │  CLAUDE MASTER  │  ← FIXED, cannot swap
                    │   (Always On)   │
                    └────────┬────────┘
                             │
              ┌──────────────┼──────────────┐
              │              │              │
              ▼              ▼              ▼
       ┌───────────┐  ┌───────────┐  ┌───────────┐
       │ architect │  │ researcher│  │  explore  │
       │ (Opus)    │  │ (Sonnet)  │  │ (Haiku)   │
       └───────────┘  └───────────┘  └───────────┘
              ↑              ↑              ↑
              └──────────────┼──────────────┘
                             │
                    Only as SUB-agents
                    (via Task tool)
```

### The Solution: Skill-Based Routing

Instead of swapping the master agent, we **inject behaviors** into the fixed master through Skills:

```
┌─────────────────────────────────────────────────────────────┐
│                    CLAUDE CODE + SKILLS                      │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
                    ┌─────────────────┐
                    │  CLAUDE MASTER  │
                    │                 │
                    │  ┌───────────┐  │
                    │  │  SKILL    │  │  ← Injected behavior
                    │  │  LAYER    │  │
                    │  └───────────┘  │
                    └────────┬────────┘
                             │
              ┌──────────────┼──────────────┐
              ▼              ▼              ▼
         Sub-agents    Sub-agents    Sub-agents
```

### How Skills Work

Skills are **behavior injections** that modify how the master agent operates:

```markdown
# When user says "plan the auth system"

1. CLAUDE.md contains routing rules
2. Claude detects "plan" → planning task
3. Claude invokes Skill(skill: "planner")
4. Planner skill template is injected
5. Claude now BEHAVES like Planner
6. But it's still the same master agent
```

---

## The Elegant Solution: Intelligent Skill Activation

### Skill Layers

We solved the "can't swap master" limitation by creating **composable skill layers**:

```
┌─────────────────────────────────────────────────────────────┐
│                    SKILL COMPOSITION                         │
└─────────────────────────────────────────────────────────────┘

  ┌─────────────────────────────────────────────────────────┐
  │  GUARANTEE LAYER (optional)                              │
  │  ┌─────────────┐                                        │
  │  │ ralph  │  "Cannot stop until verified done"     │
  │  └─────────────┘                                        │
  └─────────────────────────────────────────────────────────┘
                              │
                              ▼
  ┌─────────────────────────────────────────────────────────┐
  │  ENHANCEMENT LAYER (0-N skills)                          │
  │  ┌───────────┐ ┌───────────┐ ┌─────────────────┐        │
  │  │ ultrawork │ │git-master │ │ frontend-ui-ux  │        │
  │  │ (parallel)│ │ (commits) │ │   (design)      │        │
  │  └───────────┘ └───────────┘ └─────────────────┘        │
  └─────────────────────────────────────────────────────────┘
                              │
                              ▼
  ┌─────────────────────────────────────────────────────────┐
  │  EXECUTION LAYER (pick one primary)                      │
  │  ┌───────────┐ ┌─────────────┐ ┌────────────┐           │
  │  │  default  │ │ orchestrator│ │  planner   │           │
  │  │ (build)   │ │ (coordinate)│ │  (plan)    │           │
  │  └───────────┘ └─────────────┘ └────────────┘           │
  └─────────────────────────────────────────────────────────┘
```

### Composition Formula

```
[Execution Skill] + [0-N Enhancement Skills] + [Optional Guarantee]
```

### Examples

```
Task: "Add dark mode with proper commits"
Skills: default + frontend-ui-ux + git-master

Task: "ultrawork: refactor entire API"
Skills: ultrawork + default + git-master

Task: "Plan auth, then implement completely"
Skills: planner → default + ralph (transition)

Task: "Fix bug, don't stop until done"
Skills: default + ralph
```

---

## Comparison: Agent Swap vs Skill Activation

### Scenario: Complex Project with Planning → Implementation

**OpenCode Approach (Agent Swap):**
```
1. User: "Plan the authentication system"
2. System: Switch master to Planner
3. Planner: Creates comprehensive plan
4. User: "Now implement it"
5. System: Switch master to Default  ← Context may be lost
6. Default: Implements (needs to re-read plan)
```

**Claude Code Approach (Skill Activation):**
```
1. User: "Plan the authentication system"
2. Claude: Activates planner skill
3. Claude (as Planner): Creates comprehensive plan
4. User: "Now implement it"
5. Claude: Transitions to default skill  ← Same context!
6. Claude (as Default): Implements (already has plan in context)
```

### Why Skills Are More Elegant

| Aspect | Agent Swap | Skill Activation |
|--------|------------|------------------|
| Context | Lost on swap | Preserved |
| Transitions | Explicit, disruptive | Seamless, fluid |
| Composition | One master at a time | Multiple skills stack |
| State | Needs external tracking | In-conversation |
| User Experience | "Switch to X mode" | Natural language |

---

## Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         OH-MY-CLAUDECODE                                 │
│                     Intelligent Skill Activation                         │
└─────────────────────────────────────────────────────────────────────────┘

  User Input                      Skill Detection                 Execution
  ──────────                      ───────────────                 ─────────
       │                                │                              │
       ▼                                ▼                              ▼
┌─────────────┐              ┌──────────────────┐           ┌─────────────────┐
│  "ultrawork │              │   CLAUDE.md      │           │ SKILL ACTIVATED │
│   refactor  │─────────────▶│   Auto-Routing   │──────────▶│                 │
│   the API"  │              │                  │           │ ultrawork +     │
└─────────────┘              │ Task Type:       │           │ default +       │
                             │  - Implementation│           │ git-master      │
                             │  - Multi-file    │           │                 │
                             │  - Parallel OK   │           │ ┌─────────────┐ │
                             │                  │           │ │ Parallel    │ │
                             │ Skills:          │           │ │ agents      │ │
                             │  - ultrawork ✓   │           │ │ launched    │ │
                             │  - default ✓     │           │ └─────────────┘ │
                             │  - git-master ✓  │           │                 │
                             └──────────────────┘           │ ┌─────────────┐ │
                                                            │ │ Atomic      │ │
                                                            │ │ commits     │ │
                                                            │ └─────────────┘ │
                                                            └─────────────────┘
```

---

## Implementation Details

### CLAUDE.md Auto-Routing Section

```markdown
## INTELLIGENT SKILL ACTIVATION

Skills ENHANCE your capabilities. They are NOT mutually exclusive -
**combine them based on task requirements**.

### Task Type → Skill Selection

Use your judgment to detect task type and activate appropriate skills:

| Task Type | Skill Combination | When |
|-----------|-------------------|------|
| Multi-step implementation | `default` | Building features |
| + parallel subtasks | `+ ultrawork` | 3+ independent tasks |
| + multi-file changes | `+ git-master` | 3+ files |
| UI/frontend work | `+ frontend-ui-ux` | Components, styling |
| Strategic planning | `planner` | Need plan first |
| Must complete | `+ ralph` | Completion critical |

### Activation Guidance

- **DO NOT** wait for explicit skill invocation
- **DO** use your judgment
- **DO** combine skills when multiple apply
- **EXPLICIT** slash commands always take precedence
```

### Skill Invocation Flow

```typescript
// Conceptual flow (happens in Claude's reasoning)

function handleUserRequest(request: string) {
  // 1. Detect task type
  const taskType = analyzeTaskType(request);

  // 2. Select skill combination
  const skills = selectSkills(taskType);
  // e.g., ['default', 'ultrawork', 'git-master']

  // 3. Invoke skills (stacked)
  for (const skill of skills) {
    invoke(Skill, { skill });  // Skill tool
  }

  // 4. Execute with combined behaviors
  executeTask(request);
}
```

---

## Migration from OpenCode

If you're coming from oh-my-opencode with agent switching:

| OpenCode Pattern | Claude Code Equivalent |
|------------------|------------------------|
| `switchMaster('planner')` | Invoke `planner` skill |
| `switchMaster('default')` | Invoke `default` skill |
| `switchMaster('architect')` | Use `architect` sub-agent via Task |
| Multiple masters | Skill composition |
| Master + sub-agents | Execution skill + sub-agents |

### Key Differences

1. **No explicit "switch"** - Skills activate based on task type
2. **Context preserved** - Same conversation, different behaviors
3. **Composition** - Multiple skills can be active simultaneously
4. **Fluid transitions** - `planner` → `default` happens naturally

---

## Conclusion

While Claude Code's fixed master agent might seem like a limitation compared to OpenCode's swappable masters, the **skill-based routing system is actually more elegant**:

1. **Preserves context** across mode changes
2. **Enables composition** (ultrawork + git-master + sisyphus)
3. **Natural language** activation (no explicit mode switching)
4. **Judgment-based** routing (Claude decides based on task)

The skill layer architecture transforms a constraint into a feature, providing a more fluid and powerful orchestration experience.

---

## References

- [Oh-My-OpenCode](https://github.com/code-yeongyu/oh-my-opencode) - Original multi-agent system
- [Claude Code Skills](https://docs.anthropic.com/claude-code/skills) - Skill documentation
- [Intelligent Skill Activation](./README.md#intelligent-skill-activation-beta) - Beta feature docs
