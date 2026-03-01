/**
 * RALPLAN Stage Adapter
 *
 * Wraps the existing ralplan (consensus planning) and direct planning modules
 * into the pipeline stage adapter interface.
 *
 * This stage handles: spec creation + implementation plan creation.
 * When planning='ralplan', uses consensus-driven planning with Planner/Architect/Critic.
 * When planning='direct', uses the simpler Architect+Critic approach.
 */
import { getExpansionPrompt, getDirectPlanningPrompt } from '../prompts.js';
export const RALPLAN_COMPLETION_SIGNAL = 'PIPELINE_RALPLAN_COMPLETE';
export const ralplanAdapter = {
    id: 'ralplan',
    name: 'Planning (RALPLAN)',
    completionSignal: RALPLAN_COMPLETION_SIGNAL,
    shouldSkip(config) {
        return config.planning === false;
    },
    getPrompt(context) {
        const specPath = context.specPath || '.omc/autopilot/spec.md';
        const planPath = context.planPath || '.omc/plans/autopilot-impl.md';
        if (context.config.planning === 'ralplan') {
            return `## PIPELINE STAGE: RALPLAN (Consensus Planning)

Your task: Expand the idea into a detailed spec and implementation plan using consensus-driven planning.

**Original Idea:** "${context.idea}"

### Part 1: Idea Expansion (Spec Creation)

${getExpansionPrompt(context.idea)}

### Part 2: Consensus Planning

After the spec is created at \`${specPath}\`, invoke the RALPLAN consensus workflow:

Use the \`/oh-my-claudecode:ralplan\` skill to create a consensus-driven implementation plan.
The plan should be saved to: \`${planPath}\`

The RALPLAN process will:
1. **Planner** creates initial implementation plan from the spec
2. **Architect** reviews for technical feasibility and design quality
3. **Critic** challenges assumptions and identifies gaps
4. Iterate until consensus is reached

### Completion

When both the spec AND the consensus plan are complete and approved:

Signal: ${RALPLAN_COMPLETION_SIGNAL}
`;
        }
        // Direct planning mode (simpler approach)
        return `## PIPELINE STAGE: PLANNING (Direct)

Your task: Expand the idea into a spec and create an implementation plan.

**Original Idea:** "${context.idea}"

### Part 1: Idea Expansion

${getExpansionPrompt(context.idea)}

### Part 2: Direct Planning

After the spec is saved, create the implementation plan:

${getDirectPlanningPrompt(specPath)}

Save the plan to: \`${planPath}\`

### Completion

When both the spec AND the plan are complete:

Signal: ${RALPLAN_COMPLETION_SIGNAL}
`;
    },
};
//# sourceMappingURL=ralplan-adapter.js.map