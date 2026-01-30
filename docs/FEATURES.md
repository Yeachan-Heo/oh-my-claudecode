# Developer API Reference

> Internal API documentation for oh-my-claudecode developers and contributors.

## Table of Contents
1. [Notepad Wisdom System](#notepad-wisdom-system)
2. [Delegation Categories](#delegation-categories)
3. [Directory Diagnostics](#directory-diagnostics)
4. [Dynamic Prompt Generation](#dynamic-prompt-generation)
5. [Agent Templates](#agent-templates)
6. [Session Resume](#session-resume)
7. [Autopilot](#autopilot)

---

## Notepad Wisdom System

Plan-scoped knowledge capture for agents executing tasks. Each plan gets its own notepad directory at `.omc/notepads/{plan-name}/` with four markdown files:

- **learnings.md**: Patterns, conventions, successful approaches
- **decisions.md**: Architectural choices and rationales
- **issues.md**: Problems and blockers
- **problems.md**: Technical debt and gotchas

All entries are timestamped automatically.

### Core Functions

```typescript
// Initialize notepad directory
initPlanNotepad(planName: string, directory?: string): boolean

// Add entries
addLearning(planName: string, content: string, directory?: string): boolean
addDecision(planName: string, content: string, directory?: string): boolean
addIssue(planName: string, content: string, directory?: string): boolean
addProblem(planName: string, content: string, directory?: string): boolean

// Read wisdom
readPlanWisdom(planName: string, directory?: string): PlanWisdom
getWisdomSummary(planName: string, directory?: string): string
```

### Types

```typescript
export interface WisdomEntry {
  timestamp: string;  // ISO 8601: "YYYY-MM-DD HH:MM:SS"
  content: string;
}

export type WisdomCategory = 'learnings' | 'decisions' | 'issues' | 'problems';

export interface PlanWisdom {
  planName: string;
  learnings: WisdomEntry[];
  decisions: WisdomEntry[];
  issues: WisdomEntry[];
  problems: WisdomEntry[];
}
```

### Usage Example

```typescript
import { initPlanNotepad, addLearning, readPlanWisdom } from '@/features/notepad-wisdom';

// Initialize and record
initPlanNotepad('api-v2-migration');
addLearning('api-v2-migration', 'API routes use Express Router pattern in src/routes/');

// Read back
const wisdom = readPlanWisdom('api-v2-migration');
console.log(wisdom.learnings[0].content);
```

---

## Delegation Categories

Semantic task classification that automatically determines model tier, temperature, and thinking budget.

### Available Categories

| Category | Tier | Temp | Thinking | Use For |
|----------|------|------|----------|---------|
| `visual-engineering` | HIGH | 0.7 | high | UI/UX, frontend, design systems |
| `ultrabrain` | HIGH | 0.3 | max | Complex reasoning, architecture, debugging |
| `artistry` | MEDIUM | 0.9 | medium | Creative solutions, brainstorming |
| `quick` | LOW | 0.1 | low | Simple lookups, basic operations |
| `writing` | MEDIUM | 0.5 | medium | Documentation, technical writing |
| `unspecified-low` | LOW | 0.1 | low | Default for simple tasks |
| `unspecified-high` | HIGH | 0.5 | high | Default for complex tasks |

### Core Functions

```typescript
// Resolve category configuration
resolveCategory(category: DelegationCategory): ResolvedCategory

// Auto-detect from prompt
detectCategoryFromPrompt(taskPrompt: string): DelegationCategory | null

// Get category with context
getCategoryForTask(context: CategoryContext): ResolvedCategory

// Enhance prompt with category guidance
enhancePromptWithCategory(taskPrompt: string, category: DelegationCategory): string

// Individual accessors
getCategoryTier(category: DelegationCategory): ComplexityTier
getCategoryTemperature(category: DelegationCategory): number
getCategoryThinkingBudget(category: DelegationCategory): ThinkingBudget
getCategoryThinkingBudgetTokens(category: DelegationCategory): number
getCategoryPromptAppend(category: DelegationCategory): string
```

### Types

```typescript
export type DelegationCategory =
  | 'visual-engineering'
  | 'ultrabrain'
  | 'artistry'
  | 'quick'
  | 'writing'
  | 'unspecified-low'
  | 'unspecified-high';

export type ThinkingBudget = 'low' | 'medium' | 'high' | 'max';

export interface ResolvedCategory {
  category: DelegationCategory;
  tier: ComplexityTier;
  temperature: number;
  thinkingBudget: ThinkingBudget;
  description: string;
  promptAppend?: string;
}

export interface CategoryContext {
  taskPrompt: string;
  agentType?: string;
  explicitCategory?: DelegationCategory;
  explicitTier?: ComplexityTier;
}
```

### Usage Example

```typescript
import { getCategoryForTask, enhancePromptWithCategory } from '@/features/delegation-categories';

const userRequest = 'Debug the race condition in payment processor';

const resolved = getCategoryForTask({ taskPrompt: userRequest });
// resolved.category === 'ultrabrain'
// resolved.temperature === 0.3

const enhancedPrompt = enhancePromptWithCategory(userRequest, resolved.category);
// Adds: "Think deeply and systematically. Consider all edge cases..."
```

---

## Directory Diagnostics

Project-level TypeScript/JavaScript QA enforcement using dual-strategy approach.

### Strategies

- **`tsc`**: Fast TypeScript compilation check via `tsc --noEmit`
- **`lsp`**: File-by-file Language Server Protocol diagnostics
- **`auto`**: Auto-selects best strategy (default, prefers tsc when available)

### API

```typescript
runDirectoryDiagnostics(directory: string, strategy?: DiagnosticsStrategy): Promise<DirectoryDiagnosticResult>
```

### Types

```typescript
export type DiagnosticsStrategy = 'tsc' | 'lsp' | 'auto';

export interface DirectoryDiagnosticResult {
  strategy: 'tsc' | 'lsp';
  success: boolean;
  errorCount: number;
  warningCount: number;
  diagnostics: string;
  summary: string;
}
```

### Usage Example

```typescript
import { runDirectoryDiagnostics } from '@/tools/diagnostics';

const result = await runDirectoryDiagnostics(process.cwd());

if (!result.success) {
  console.error(`Found ${result.errorCount} errors:`);
  console.error(result.diagnostics);
  process.exit(1);
}

console.log('Build quality check passed!');
```

---

## Dynamic Prompt Generation

Generate orchestrator prompts dynamically from agent metadata. Adding a new agent to `definitions.ts` automatically includes it in generated prompts.

### Core Functions

```typescript
// Generate full orchestrator prompt
generateOrchestratorPrompt(agents: AgentConfig[], options?: GeneratorOptions): string

// Convert definitions to configs
convertDefinitionsToConfigs(definitions: Record<string, {...}>): AgentConfig[]

// Individual section builders
buildHeader(): string
buildAgentRegistry(agents: AgentConfig[]): string
buildTriggerTable(agents: AgentConfig[]): string
buildToolSelectionSection(agents: AgentConfig[]): string
buildDelegationMatrix(agents: AgentConfig[]): string
buildOrchestrationPrinciples(): string
buildWorkflow(): string
buildCriticalRules(): string
buildCompletionChecklist(): string
```

### Types

```typescript
export interface GeneratorOptions {
  includeAgents?: boolean;
  includeTriggers?: boolean;
  includeTools?: boolean;
  includeDelegationTable?: boolean;
  includePrinciples?: boolean;
  includeWorkflow?: boolean;
  includeRules?: boolean;
  includeChecklist?: boolean;
}
```

### Usage Example

```typescript
import { getAgentDefinitions } from '@/agents/definitions';
import { generateOrchestratorPrompt, convertDefinitionsToConfigs } from '@/agents/prompt-generator';

const definitions = getAgentDefinitions();
const agents = convertDefinitionsToConfigs(definitions);
const prompt = generateOrchestratorPrompt(agents);
```

---

## Agent Templates

Standardized prompt structures for common task types.

### Exploration Template

For exploration, research, or search tasks.

**Sections:**
- **TASK**: What needs to be explored
- **EXPECTED OUTCOME**: What the orchestrator expects back
- **CONTEXT**: Background information
- **MUST DO**: Required actions
- **MUST NOT DO**: Constraints
- **REQUIRED SKILLS**: Skills needed
- **REQUIRED TOOLS**: Tools to use

**Location:** `src/agents/templates/exploration-template.md`

### Implementation Template

For code implementation, refactoring, or modification tasks.

**Sections:**
- **TASK**: Implementation goal
- **EXPECTED OUTCOME**: Deliverable
- **CONTEXT**: Project background
- **MUST DO**: Required actions
- **MUST NOT DO**: Constraints
- **REQUIRED SKILLS**: Skills needed
- **REQUIRED TOOLS**: Tools to use
- **VERIFICATION CHECKLIST**: Pre-completion checks

**Location:** `src/agents/templates/implementation-template.md`

---

## Session Resume

Wrapper for resuming background agent sessions with full context.

### API

```typescript
resumeSession(input: ResumeSessionInput): ResumeSessionOutput
```

### Types

```typescript
export interface ResumeSessionInput {
  sessionId: string;
}

export interface ResumeSessionOutput {
  success: boolean;
  context?: {
    previousPrompt: string;
    toolCallCount: number;
    lastToolUsed?: string;
    lastOutputSummary?: string;
    continuationPrompt: string;
  };
  error?: string;
}
```

### Usage Example

```typescript
import { resumeSession } from '@/tools/resume-session';

const result = resumeSession({ sessionId: 'ses_abc123' });

if (result.success && result.context) {
  console.log(`Resuming session with ${result.context.toolCallCount} prior tool calls`);

  // Continue with Task delegation
  Task({
    subagent_type: "oh-my-claudecode:executor",
    model: "sonnet",
    prompt: result.context.continuationPrompt
  });
}
```

---

## Autopilot

Autonomous execution from idea to validated working code through a 5-phase development lifecycle.

### 5-Phase Workflow

1. **Expansion** - Analyst + Architect expand idea into requirements and technical spec
2. **Planning** - Architect creates execution plan (validated by Critic)
3. **Execution** - Ralph + Ultrawork implement plan with parallel tasks
4. **QA** - UltraQA ensures build/lint/tests pass through fix cycles
5. **Validation** - Specialized architects perform functional, security, and quality reviews

### Core Types

```typescript
export type AutopilotPhase =
  | 'expansion'
  | 'planning'
  | 'execution'
  | 'qa'
  | 'validation'
  | 'complete'
  | 'failed';

export interface AutopilotState {
  active: boolean;
  phase: AutopilotPhase;
  iteration: number;
  max_iterations: number;
  originalIdea: string;

  expansion: AutopilotExpansion;
  planning: AutopilotPlanning;
  execution: AutopilotExecution;
  qa: AutopilotQA;
  validation: AutopilotValidation;

  started_at: string;
  completed_at: string | null;
  phase_durations: Record<string, number>;
  total_agents_spawned: number;
  wisdom_entries: number;
  session_id?: string;
}

export interface AutopilotConfig {
  maxIterations?: number;              // default: 10
  maxExpansionIterations?: number;     // default: 2
  maxArchitectIterations?: number;     // default: 5
  maxQaCycles?: number;                // default: 5
  maxValidationRounds?: number;        // default: 3
  parallelExecutors?: number;          // default: 5
  pauseAfterExpansion?: boolean;       // default: false
  pauseAfterPlanning?: boolean;        // default: false
  skipQa?: boolean;                    // default: false
  skipValidation?: boolean;            // default: false
  autoCommit?: boolean;                // default: false
  validationArchitects?: ValidationVerdictType[];
}
```

### State Management

```typescript
// Initialize session
initAutopilot(directory: string, idea: string, sessionId?: string, config?: Partial<AutopilotConfig>): AutopilotState

// Read/write state
readAutopilotState(directory: string): AutopilotState | null
writeAutopilotState(directory: string, state: AutopilotState): boolean
clearAutopilotState(directory: string): boolean

// Check status
isAutopilotActive(directory: string): boolean

// Phase transitions
transitionPhase(directory: string, newPhase: AutopilotPhase): AutopilotState | null
transitionRalphToUltraQA(directory: string, sessionId: string): TransitionResult
transitionUltraQAToValidation(directory: string): TransitionResult
transitionToComplete(directory: string): TransitionResult
transitionToFailed(directory: string, error: string): TransitionResult

// Update phase data
updateExpansion(directory: string, updates: Partial<AutopilotExpansion>): boolean
updatePlanning(directory: string, updates: Partial<AutopilotPlanning>): boolean
updateExecution(directory: string, updates: Partial<AutopilotExecution>): boolean
updateQA(directory: string, updates: Partial<AutopilotQA>): boolean
updateValidation(directory: string, updates: Partial<AutopilotValidation>): boolean

// Metrics
incrementAgentCount(directory: string, count?: number): boolean

// Paths
getSpecPath(directory: string): string  // .omc/autopilot/spec.md
getPlanPath(directory: string): string  // .omc/plans/autopilot-impl.md
```

### Prompt Generation

```typescript
// Phase-specific prompts
getExpansionPrompt(idea: string): string
getDirectPlanningPrompt(specPath: string): string
getExecutionPrompt(planPath: string): string
getQAPrompt(): string
getValidationPrompt(specPath: string): string

// Generic phase prompt
getPhasePrompt(phase: string, context: object): string

// Transition prompts
getTransitionPrompt(fromPhase: string, toPhase: string): string
```

### Validation Coordination

```typescript
export type ValidationVerdictType = 'functional' | 'security' | 'quality';
export type ValidationVerdict = 'APPROVED' | 'REJECTED' | 'NEEDS_FIX';

// Record verdicts
recordValidationVerdict(directory: string, type: ValidationVerdictType, verdict: ValidationVerdict, issues?: string[]): boolean

// Get status
getValidationStatus(directory: string): ValidationCoordinatorResult | null

// Control validation rounds
startValidationRound(directory: string): boolean
shouldRetryValidation(directory: string, maxRounds?: number): boolean
getIssuesToFix(directory: string): string[]

// Prompts and display
getValidationSpawnPrompt(specPath: string): string
formatValidationResults(state: AutopilotState): string
```

### Summaries

```typescript
// Generate summary
generateSummary(directory: string): AutopilotSummary | null

// Format summaries
formatSummary(summary: AutopilotSummary): string
formatCompactSummary(state: AutopilotState): string
formatFailureSummary(state: AutopilotState, error?: string): string
formatFileList(files: string[], title: string, maxFiles?: number): string
```

### Cancellation & Resume

```typescript
// Cancel and preserve progress
cancelAutopilot(directory: string): CancelResult
clearAutopilot(directory: string): CancelResult

// Resume
canResumeAutopilot(directory: string): { canResume: boolean; state?: AutopilotState; resumePhase?: string }
resumeAutopilot(directory: string): { success: boolean; message: string; state?: AutopilotState }

// Display
formatCancelMessage(result: CancelResult): string
```

### Usage Example

```typescript
import {
  initAutopilot,
  getPhasePrompt,
  readAutopilotState,
  transitionRalphToUltraQA,
  getValidationStatus,
  generateSummary,
  formatSummary
} from '@/hooks/autopilot';

// Initialize session
const idea = 'Create a REST API for todo management with authentication';
const state = initAutopilot(process.cwd(), idea, 'ses_abc123');

// Get expansion phase prompt
const prompt = getPhasePrompt('expansion', { idea });

// Monitor progress
const currentState = readAutopilotState(process.cwd());
console.log(`Phase: ${currentState?.phase}`);
console.log(`Agents spawned: ${currentState?.total_agents_spawned}`);

// Transition phases
if (currentState?.phase === 'execution' && currentState.execution.ralph_completed_at) {
  const result = transitionRalphToUltraQA(process.cwd(), 'ses_abc123');
  if (result.success) {
    console.log('Transitioned to QA phase');
  }
}

// Check validation
const validationStatus = getValidationStatus(process.cwd());
if (validationStatus?.allApproved) {
  const summary = generateSummary(process.cwd());
  if (summary) {
    console.log(formatSummary(summary));
  }
}
```

### State Persistence

All state is persisted to `.omc/state/autopilot-state.json` and includes:

- Active status and current phase
- Original user idea
- Phase-specific progress (expansion, planning, execution, qa, validation)
- Files created and modified
- Agent spawn count and metrics
- Phase duration tracking
- Session binding

---

## See Also

- [CHANGELOG.md](../CHANGELOG.md) - Version history
- [ARCHITECTURE.md](./ARCHITECTURE.md) - System architecture
- [MIGRATION.md](./MIGRATION.md) - Migration guide
- [Agent Definitions](../src/agents/definitions.ts) - Agent configuration
