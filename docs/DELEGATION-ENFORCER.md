# Delegation Enforcer

**Automatic model parameter injection for Task/Agent calls**

## Problem

Claude Code does NOT automatically apply model parameters from agent definitions. When you invoke the `Task` tool (or `Agent` tool), you must manually specify the `model` parameter every time, even though each agent has a default model defined in its configuration.

This leads to:
- Verbose delegation code
- Forgotten model parameters defaulting to parent model
- Inconsistent model usage across codebase

## Solution

The **Delegation Enforcer** is middleware that automatically injects the model parameter based on agent definitions when not explicitly specified.

## How It Works

### 1. Pre-Tool-Use Hook

The enforcer runs as a pre-tool-use hook that intercepts `Task` and `Agent` tool calls:

```typescript
// Before enforcement
Task(
  subagent_type="oh-my-claudecode:executor",
  prompt="Implement feature X"
)

// After enforcement (automatic)
Task(
  subagent_type="oh-my-claudecode:executor",
  model="sonnet",  // ← Automatically injected
  prompt="Implement feature X"
)
```

### 2. Agent Definition Lookup

Each agent has a default model in its definition:

```typescript
export const executorAgent: AgentConfig = {
  name: 'executor',
  description: '...',
  prompt: '...',
  tools: [...],
  model: 'sonnet'  // ← Default model
};
```

The enforcer reads this definition and injects the model when not specified.

### 3. Explicit Models Preserved

If you explicitly specify a model, it's always preserved:

```typescript
// Explicit model is never overridden
Task(
  subagent_type="oh-my-claudecode:executor",
  model="haiku",  // ← Explicitly using haiku instead of default sonnet
  prompt="Quick lookup"
)
```

## API

### Core Functions

#### `enforceModel(agentInput: AgentInput): EnforcementResult`

Enforces model parameter for a single agent delegation call.

```typescript
import { enforceModel } from 'oh-my-claude-sisyphus';

const input = {
  description: 'Implement feature',
  prompt: 'Add validation',
  subagent_type: 'executor'
};

const result = enforceModel(input);
console.log(result.modifiedInput.model); // 'sonnet'
console.log(result.injected); // true
```

#### `getModelForAgent(agentType: string): ModelType`

Get the default model for an agent type.

```typescript
import { getModelForAgent } from 'oh-my-claude-sisyphus';

getModelForAgent('executor'); // 'sonnet'
getModelForAgent('executor-low'); // 'haiku'
getModelForAgent('executor-high'); // 'opus'
```

#### `isAgentCall(toolName: string, toolInput: unknown): boolean`

Check if a tool invocation is an agent delegation call.

```typescript
import { isAgentCall } from 'oh-my-claude-sisyphus';

isAgentCall('Task', { subagent_type: 'executor', ... }); // true
isAgentCall('Bash', { command: 'ls' }); // false
```

### Hook Integration

The enforcer automatically integrates with the pre-tool-use hook:

```typescript
import { processHook } from 'oh-my-claude-sisyphus';

const hookInput = {
  toolName: 'Task',
  toolInput: {
    description: 'Test',
    prompt: 'Test',
    subagent_type: 'executor'
  }
};

const result = await processHook('pre-tool-use', hookInput);
console.log(result.modifiedInput.model); // 'sonnet'
```

## Agent Model Mapping

| Agent Type | Default Model | Use Case |
|------------|---------------|----------|
| `architect` | opus | Complex analysis, debugging |
| `architect-medium` | sonnet | Standard analysis |
| `architect-low` | haiku | Quick questions |
| `executor` | sonnet | Standard implementation |
| `executor-high` | opus | Complex refactoring |
| `executor-low` | haiku | Simple changes |
| `explore` | haiku | Fast code search |
| `designer` | sonnet | UI implementation |
| `designer-high` | opus | Complex UI architecture |
| `designer-low` | haiku | Simple styling |
| `researcher` | sonnet | Documentation lookup |
| `writer` | haiku | Documentation writing |
| `vision` | sonnet | Image analysis |
| `planner` | opus | Strategic planning |
| `critic` | opus | Plan review |
| `analyst` | opus | Pre-planning analysis |
| `qa-tester` | sonnet | CLI testing |
| `scientist` | sonnet | Data analysis |
| `scientist-high` | opus | Complex research |

## Debug Mode

Enable debug logging to see when models are auto-injected:

```bash
export OMC_DEBUG=true
```

When enabled, you'll see warnings like:

```
[OMC] Auto-injecting model: sonnet for executor
```

**Important:** Warnings are ONLY shown when `OMC_DEBUG=true`. Without this flag, enforcement happens silently.

## Usage Examples

### Before (Manual)

```typescript
// Every delegation needs explicit model
Task(
  subagent_type="oh-my-claudecode:executor",
  model="sonnet",
  prompt="Implement X"
)

Task(
  subagent_type="oh-my-claudecode:executor-low",
  model="haiku",
  prompt="Quick lookup"
)
```

### After (Automatic)

```typescript
// Model automatically injected from definition
Task(
  subagent_type="oh-my-claudecode:executor",
  prompt="Implement X"
)

Task(
  subagent_type="oh-my-claudecode:executor-low",
  prompt="Quick lookup"
)
```

### Override When Needed

```typescript
// Use haiku for a simple executor task
Task(
  subagent_type="oh-my-claudecode:executor",
  model="haiku",  // Override default sonnet
  prompt="Find definition of X"
)
```

## Implementation Details

### Hook Integration

The enforcer runs in the `pre-tool-use` hook:

1. Hook receives tool invocation
2. Checks if tool is `Task` or `Agent`
3. Checks if `model` parameter is missing
4. Looks up agent definition
5. Injects default model
6. Returns modified input

### Error Handling

- Unknown agent types throw errors
- Agents without default models throw errors
- Invalid input structures are passed through unchanged
- Non-agent tools are ignored

### Performance

- O(1) lookup: Direct hash map lookup for agent definitions
- No async operations: Synchronous enforcement
- Minimal overhead: Only applies to Task/Agent calls

## Testing

Run tests:

```bash
npm test -- delegation-enforcer
```

Run demo:

```bash
npx tsx examples/delegation-enforcer-demo.ts
```

## Benefits

1. **Cleaner Code**: No need to manually specify model every time
2. **Consistency**: Always uses correct model tier for each agent
3. **Safety**: Explicit models always preserved
4. **Transparency**: Debug mode shows when models are injected
5. **Zero Config**: Works automatically with existing agent definitions

## Migration

No migration needed! The enforcer is backward compatible:

- Existing code with explicit models continues working
- New code can omit model parameter
- No breaking changes

## Related

- [Agent Definitions](./AGENTS.md) - Complete agent reference
- [Features Reference](./FEATURES.md) - Model routing and delegation categories
