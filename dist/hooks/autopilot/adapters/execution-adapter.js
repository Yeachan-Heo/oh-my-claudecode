/**
 * EXECUTION Stage Adapter
 *
 * Wraps team-based and solo execution into the pipeline stage adapter interface.
 *
 * When execution='team', delegates to the /team orchestrator for multi-worker execution.
 * When execution='solo', uses direct executor agents in the current session.
 */
import { resolveAutopilotPlanPath } from "../../../config/plan-output.js";
export const EXECUTION_COMPLETION_SIGNAL = "PIPELINE_EXECUTION_COMPLETE";
const CLI_TEAM_AGENT_TYPES = new Set(["codex", "gemini", "grok", "cursor", "antigravity"]);
function uniqueRequestedAgentTypes(agentTypes) {
    return [...new Set((agentTypes ?? []).filter(Boolean))];
}
function hasCliTeamAgentTypes(agentTypes) {
    return agentTypes.some((agentType) => CLI_TEAM_AGENT_TYPES.has(agentType));
}
function formatCliTeamAgentSpec(agentTypes) {
    const cliTypes = agentTypes.filter((agentType) => CLI_TEAM_AGENT_TYPES.has(agentType));
    const preferred = cliTypes.length > 0 ? cliTypes[0] : "cursor";
    return `1:${preferred}`;
}
function getCliTeamRuntimeGuidance(agentTypes, planPath) {
    const requested = agentTypes.join(", ");
    const agentSpec = formatCliTeamAgentSpec(agentTypes);
    const cursorGuidance = agentTypes.includes("cursor")
        ? `

### Cursor Availability

Before launching Cursor workers, verify \`cursor-agent\` is installed and authenticated. If it is unavailable, stop and report: install/authenticate \`cursor-agent\` for Cursor worker support. Do not silently fall back to Claude-only execution in a way that hides the missing Cursor dependency.`
        : "";
    return `### CLI Team Runtime Required

Configured autopilot team worker types include CLI-backed workers: ${requested}. For executor-style implementation work, use the tmux CLI team runtime instead of in-process Claude-only Task subagents.

Use one of these equivalent surfaces from the lead session:

\`\`\`sh
omc team ${agentSpec} "<implementation task from ${planPath}>"
\`\`\`

Or from Claude Code slash commands:

\`\`\`text
/omc-teams ${agentSpec} "<implementation task from ${planPath}>"
\`\`\`

Requested worker types: ${requested}. Keep these CLI workers executor-style only: implementation, file edits, build/test fixes, and other plan execution tasks. Keep reviewer, critic, security-review, validation verdict, and final approval roles on the native Claude/OMC reviewer agents unless this repository explicitly adds safe role support for that CLI worker type.${cursorGuidance}`;
}
export const executionAdapter = {
    id: "execution",
    name: "Execution",
    completionSignal: EXECUTION_COMPLETION_SIGNAL,
    shouldSkip(_config) {
        // Execution stage is never skipped - it's the core of the pipeline
        return false;
    },
    getPrompt(context) {
        const planPath = context.planPath || resolveAutopilotPlanPath();
        const isTeam = context.config.execution === "team";
        const requestedAgentTypes = uniqueRequestedAgentTypes(context.config.team?.agentTypes);
        const useCliTeamRuntime = isTeam && hasCliTeamAgentTypes(requestedAgentTypes);
        if (isTeam) {
            const teamRuntimeGuidance = useCliTeamRuntime
                ? getCliTeamRuntimeGuidance(requestedAgentTypes, planPath)
                : `Use Claude Code's implicit agent team to execute tasks in parallel:`;
            return `## PIPELINE STAGE: EXECUTION (Team Mode)

Execute the implementation plan using multi-worker team execution.

### Setup

Read the implementation plan at: \`${planPath}\`

### Team Execution

${teamRuntimeGuidance}

${useCliTeamRuntime ? `1. **Launch CLI executor workers** with \`omc team\` or \`/omc-teams\` using the requested agent types.
2. **Decompose executor-style implementation tasks** from the implementation plan and pass them to CLI workers.
3. **Monitor tmux/team output** and integrate completed implementation changes.
4. **Keep review/critic/security/verdict work native**; do not assign those roles to Cursor/CLI workers.
5. **Coordinate** dependencies between tasks.` : `1. **Use the implicit team** provided by Claude Code when \`CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1\` is enabled; do not call removed \`TeamCreate\`/\`TeamDelete\` tools.
2. **Track work in TodoWrite or the active task list** from the implementation plan.
3. **Spawn executor teammates directly** with the Agent/Task tool using distinct \`name\` values (for example, \`name="worker-1"\`). Do not rely on \`team_name\`; Claude Code 2.1.178+ accepts it only as ignored legacy metadata.
4. **Monitor progress** as teammates complete tasks.
5. **Coordinate** dependencies between tasks.`}

### Output Contract

Every teammate response must stay concise: return ONLY a short execution summary under 100 words covering what changed, files touched, verification status, and blockers. Store bulky logs/details in files or artifacts and reference them briefly.

### Agent Selection

${useCliTeamRuntime ? `Use the requested CLI worker spec for executor-style implementation tasks only. Keep task prompts framed as implementation/build/test-fix work; do not ask Cursor/CLI workers to act as reviewers, critics, security reviewers, or final verdict agents.` : `Match agent types to task complexity:
- Simple tasks (single file, config): \`executor\` with \`model="haiku"\`
- Standard implementation: \`executor\` with \`model="sonnet"\`
- Complex work (architecture, refactoring): \`executor\` with \`model="opus"\`
- Build issues: \`debugger\` with \`model="sonnet"\`
- Test creation: \`test-engineer\` with \`model="sonnet"\`
- UI work: \`designer\` with \`model="sonnet"\``}

### Progress Tracking

Track progress through the task list:
- Mark tasks \`in_progress\` when starting
- Mark tasks \`completed\` when verified
- Add discovered tasks as they emerge

### Completion

When ALL tasks from the plan are implemented:

Signal: ${EXECUTION_COMPLETION_SIGNAL}
`;
        }
        // Solo execution mode
        return `## PIPELINE STAGE: EXECUTION (Solo Mode)

Execute the implementation plan using single-session execution.

### Setup

Read the implementation plan at: \`${planPath}\`

### Solo Execution

Execute tasks sequentially (or with limited parallelism via background agents):

1. Read and understand each task from the plan
2. Execute tasks in dependency order
3. Use executor agents for independent tasks that can run in parallel
4. Track progress in the TODO list

### Output Contract

Every spawned executor response must return ONLY a short execution summary under 100 words covering what changed, files touched, verification status, and blockers. Store bulky logs/details in files or artifacts and reference them briefly.

### Agent Spawning

\`\`\`
// For simple tasks (single file, straightforward logic)
Task(subagent_type="oh-my-claudecode:executor", model="haiku", prompt="...")

// For standard implementation (feature, multiple methods)
Task(subagent_type="oh-my-claudecode:executor", model="sonnet", prompt="...")

// For complex work (architecture, debugging, refactoring)
Task(subagent_type="oh-my-claudecode:executor", model="opus", prompt="...")
\`\`\`

### Progress Tracking

Update TODO list as tasks complete:
- Mark task \`in_progress\` when starting
- Mark task \`completed\` when done
- Add new tasks if discovered during implementation

### Completion

When ALL tasks from the plan are implemented:

Signal: ${EXECUTION_COMPLETION_SIGNAL}
`;
    },
};
//# sourceMappingURL=execution-adapter.js.map