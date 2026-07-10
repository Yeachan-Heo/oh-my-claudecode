/**
 * Merge Readiness Stage Adapter
 *
 * Runs after implementation verification and QA, before pipeline completion.
 * This stage checks human explainability of the delivered change; it is not a
 * substitute for tests, review, risk acceptance, or maintainer approval.
 *
 * The adapter delegates to the SAME runtime as the standalone /merge-readiness
 * command (runtime is the backbone): onEnter seeds state, getPrompt instructs
 * the AI to drive the unified MCQ flow, and the completion signal is emitted
 * ONLY on pass.
 */

import { createInitialMergeReadinessState } from "../../merge-readiness/runtime.js";
import type {
  PipelineStageAdapter,
  PipelineConfig,
  PipelineContext,
} from "../pipeline-types.js";

export const MERGE_READINESS_COMPLETION_SIGNAL =
  "PIPELINE_MERGE_READINESS_COMPLETE";

export const mergeReadinessAdapter: PipelineStageAdapter = {
  id: "merge-readiness",
  name: "Merge Readiness",
  completionSignal: MERGE_READINESS_COMPLETION_SIGNAL,

  shouldSkip(config: PipelineConfig): boolean {
    return !config.mergeReadiness;
  },

  onEnter(context: PipelineContext): void {
    // Seed runtime state so the Stop-hook gate arms immediately. The AI drives
    // content generation + MCQ presentation; the runtime owns scoring/gate.
    createInitialMergeReadinessState(
      context.directory,
      context.idea || "autopilot change",
      context.sessionId,
    );
  },

  getPrompt(context: PipelineContext): string {
    const specPath = context.specPath || ".omc/autopilot/spec.md";
    const planPath = context.planPath || ".omc/plans/autopilot-impl.md";
    const directory = context.directory;
    const sessionId = context.sessionId;

    return `## PIPELINE STAGE: MERGE READINESS (Post-task, Pre-merge)

The implementation, verification, and QA stages have completed. Before marking this change merge-ready, run the unified merge-readiness runtime flow. The runtime (TS hook code) is the backbone: it owns state, objective MCQ scoring, the Stop-hook gate, and the durable artifact. You (the AI) own content generation + MCQ presentation.

This gate checks whether a human can explain the change. It does NOT replace tests, QA, code review, security review, risk acceptance, maintainer approval, or merge approval.

### Inputs

- Original spec: \`${specPath}\`
- Implementation plan: \`${planPath}\`
- Changed files, test output, QA output, and review evidence from completed pipeline stages
- Runtime state has already been seeded (onEnter called createInitialMergeReadinessState).

### Step 1: Read Evidence

The runtime has already collected git diff, changed files, and .omc artifacts into state. Read the merge-readiness state file to see the evidence and the active profile/threshold/maxRounds/required dimensions.

### Step 2: Generate Explanation Doc + MCQs (AI content step)

Generate, from the actual diff + evidence (NOT templates):

1. A 5-section explanation narrative:
   - **Why** - why this change was made
   - **What Changed** - what user/system behavior changed
   - **Tradeoffs** - what was chosen, deferred, or rejected
   - **Risks Considered** - risks already considered and how they were handled
   - **Team Understanding** - how the team should understand/maintain this change
2. A set of MCQs (one correct option each, with correctOptionId + rationale):
   - Up to the profile max rounds (quick 3 / standard 5 / deep 8)
   - Distributed across the required dimensions (why/change/tradeoff/risk/team; quick = why/change/risk)
   - Testing understanding of THIS change, not implementation trivia (no function names, line numbers, variable names, private helpers)
   - Each question: { id, dimension, stem, options: [{id,text}...], correctOptionId, rationale? }

Submit the doc + MCQs through the supported \`merge_readiness_set_content\` action. Do not write a mode-state JSON file or call an internal runtime helper directly. Invalid content remains recoverable and reports validation errors.

### Step 3: Present MCQs One-Per-Round (deep-interview style)

For each MCQ (one per round), present it via AskUserQuestion with the literal marker \`[MERGE READINESS:<question-id>]\` in the question text and the option ids/text as choices. The bridge correlates only that marked native result to the current question and the runtime scores it objectively.

### Step 4: Gate Semantics (runtime-owned)

The runtime finalizes the result once all required MCQs are answered:
- **pass**: correctness rate >= threshold AND every required dimension covered
- **paused**: all required answered but correctness rate below threshold
- **blocked**: missing minimal evidence (no diff/change signal)
- **overridden**: an explicit \`/merge-readiness --override <reason>\` soft bypass; this is distinct from pass

Thresholds: quick 0.70 / standard 0.80 / deep 0.90.

The Stop-hook (Priority 1.9) blocks the session while result is pending/paused/blocked and releases on pass.

### Step 5: Completion

Emit the completion signal only when the runtime result is \`pass\` or \`overridden\`:

Signal: ${MERGE_READINESS_COMPLETION_SIGNAL}

On \`paused\` or \`blocked\`, do NOT emit the completion signal. The Stop-hook will keep blocking; surface the artifact path and the gap to the operator.

### Merge Boundary

Passing this gate only means the human can explain the change. It does not approve merge and does not bypass any review or approval authority. The durable artifact is written to \`.omc/artifacts/merge-readiness/<timestamp>-<slug>.md\`.

Runtime helpers live in \`src/hooks/merge-readiness/runtime.ts\` (${directory}).
Session: ${sessionId ?? "(none)"}.
`;
  },
};
