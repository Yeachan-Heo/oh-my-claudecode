/**
 * Pipeline Orchestrator
 *
 * The core of the configurable pipeline that unifies autopilot/ultrawork/ultrapilot
 * into a single sequenced workflow: RALPLAN -> EXECUTION -> RALPH -> QA.
 *
 * Each stage is implemented by a PipelineStageAdapter and can be skipped
 * via PipelineConfig. The orchestrator manages state transitions, signal
 * detection, and prompt generation.
 *
 * @see https://github.com/Yeachan-Heo/oh-my-claudecode/issues/1130
 */

import { createHash } from "crypto";
import type { AutopilotWorkflowProfileV1 } from "../../shared/types.js";

import type {
  PipelineConfig,
  PipelineContext,
  PipelineStageAdapter,
  PipelineStageState,
  PipelineTracking,
  PipelinePhase,
  PipelineStageId,
  WorkflowProfileStages,
  WorkflowDescriptor,
  StageStatus,
} from "./pipeline-types.js";
import {
  DEFAULT_PIPELINE_CONFIG,
  STAGE_ORDER,
  DEPRECATED_MODE_ALIASES,
} from "./pipeline-types.js";
import { ALL_ADAPTERS, getAdapterById } from "./adapters/index.js";
import {
  readAutopilotState,
  writeAutopilotState,
  initAutopilot,
} from "./state.js";
import type { AutopilotState, AutopilotConfig } from "./types.js";
import {
  resolveAutopilotPlanPath,
  resolveOpenQuestionsPlanPath,
} from "../../config/plan-output.js";
import { validateNamedWorkflowStateStructure } from "./named-workflow-resume-validator.js";


// ============================================================================
// CONFIGURATION
// ============================================================================

/**
 * Resolve a PipelineConfig from user-provided partial config, merging with defaults.
 *
 * Also handles deprecated mode aliases: if the user invoked 'ultrawork' or 'ultrapilot',
 * the corresponding config overrides are applied.
 */
export function resolvePipelineConfig(
  userConfig?: Partial<PipelineConfig>,
  deprecatedMode?: string,
): PipelineConfig {
  let config = { ...DEFAULT_PIPELINE_CONFIG };

  // Apply deprecated mode alias overrides
  if (deprecatedMode && deprecatedMode in DEPRECATED_MODE_ALIASES) {
    const alias = DEPRECATED_MODE_ALIASES[deprecatedMode];
    config = { ...config, ...alias.config };
  }

  // Apply user overrides
  if (userConfig) {
    if (userConfig.planning !== undefined)
      config.planning = userConfig.planning;
    if (userConfig.execution !== undefined)
      config.execution = userConfig.execution;
    if (userConfig.verification !== undefined)
      config.verification = userConfig.verification;
    if (userConfig.qa !== undefined) config.qa = userConfig.qa;
    if (userConfig.team !== undefined) {
      config.team = { ...(config.team ?? {}), ...userConfig.team };
    }
  }

  return config;
}

const WORKFLOW_STAGE_SEQUENCES = [
  ["ralplan", "execution"],
  ["ralplan", "execution", "ralph"],
  ["ralplan", "execution", "qa"],
  ["ralplan", "execution", "ralph", "qa"],
] as const;

function isWorkflowStageSequence(stages: string[]): boolean {
  return WORKFLOW_STAGE_SEQUENCES.some(
    (sequence) =>
      stages.length === sequence.length &&
      stages.every((stage, index) => stage === sequence[index]),
  );
}
const RESERVED_WORKFLOW_NAMES = new Set([
  "autopilot",
  "ralplan",
  "execution",
  "ralph",
  "qa",
  "autoresearch",
  "ultraqa",
  "merge-readiness",
  "self-improve",
  "ultrawork",
  "ultragoal",
  "ultrapilot",
  "swarm",
  "pipeline",
  "plan",
  "team",
  "cancel",
  "deep-interview",
  "deepsearch",
  "ultrathink",
  "tdd",
  "code-review",
  "security-review",
  "analyze",
  "search",
  "default",
]);

/** Serialize JSON values with object keys sorted recursively in lexical order. */
export function canonicalizeJson(value: unknown): string {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "string"
  ) {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value))
      throw new TypeError("Canonical JSON requires finite numbers");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalizeJson).join(",")}]`;
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalizeJson(record[key])}`)
      .join(",")}}`;
  }
  throw new TypeError("Canonical JSON requires JSON-compatible values");
}

/** Return the canonical, closed v1 shape or null for malformed profile input. */
export function normalizeWorkflowProfile(
  profile: unknown,
): { version: 1; stages: WorkflowProfileStages } | null {
  if (!profile || typeof profile !== "object" || Array.isArray(profile))
    return null;
  const record = profile as Record<string, unknown>;
  if (record.version !== 1 || !Array.isArray(record.stages)) return null;
  if (Object.keys(record).some((key) => key !== "version" && key !== "stages"))
    return null;
  const stages = record.stages;
  if (!stages.every((stage) => typeof stage === "string")) return null;
  if (!isWorkflowStageSequence(stages as string[])) return null;
  return {
    version: 1,
    stages: [...stages] as unknown as WorkflowProfileStages,
  };
}

/** Build the deterministic SHA-256 descriptor persisted for a named workflow run. */
export function createWorkflowDescriptor(
  workflowName: string,
  profile: AutopilotWorkflowProfileV1 | unknown,
): WorkflowDescriptor | null {
  if (
    !/^[a-z][a-z0-9-]{0,62}$/.test(workflowName) ||
    RESERVED_WORKFLOW_NAMES.has(workflowName)
  )
    return null;
  const normalized = normalizeWorkflowProfile(profile);
  if (!normalized) return null;
  const canonical = canonicalizeJson({
    descriptorVersion: 1,
    workflowName,
    profileVersion: 1,
    stages: normalized.stages,
  });
  return {
    descriptorVersion: 1,
    workflowName,
    profileVersion: 1,
    stages: normalized.stages,
    profileHash: createHash("sha256").update(canonical).digest("hex"),
  };
}

/** Verify that an on-disk descriptor still matches its canonical contents. */
export function verifyWorkflowDescriptor(
  descriptor: unknown,
): descriptor is WorkflowDescriptor {
  if (
    !descriptor ||
    typeof descriptor !== "object" ||
    Array.isArray(descriptor)
  )
    return false;
  const record = descriptor as Record<string, unknown>;
  const expectedKeys = [
    "descriptorVersion",
    "profileHash",
    "profileVersion",
    "stages",
    "workflowName",
  ];
  if (
    Object.keys(record).length !== expectedKeys.length ||
    expectedKeys.some((key) => !(key in record)) ||
    record.descriptorVersion !== 1 ||
    typeof record.workflowName !== "string" ||
    typeof record.profileHash !== "string"
  ) {
    return false;
  }
  const expected = createWorkflowDescriptor(record.workflowName, {
    version: record.profileVersion,
    stages: record.stages,
  });
  return expected !== null && expected.profileHash === record.profileHash;
}

/**
 * Check if the invocation is from a deprecated mode and return the deprecation warning.
 */
export function getDeprecationWarning(mode: string): string | null {
  if (mode in DEPRECATED_MODE_ALIASES) {
    return DEPRECATED_MODE_ALIASES[mode].message;
  }
  return null;
}

// ============================================================================
// PIPELINE STATE MANAGEMENT
// ============================================================================

/**
 * Build the initial pipeline tracking state from a resolved config.
 * Creates stage entries for all stages, marking skipped stages as 'skipped'.
 */
export function buildPipelineTracking(
  config: PipelineConfig,
): PipelineTracking {
  const _adapters = getActiveAdapters(config);
  const stages: PipelineStageState[] = STAGE_ORDER.map((stageId) => {
    const adapter = getAdapterById(stageId);
    const isActive = adapter && !adapter.shouldSkip(config);
    return {
      id: stageId,
      status: isActive
        ? ("pending" as StageStatus)
        : ("skipped" as StageStatus),
      iterations: 0,
    };
  });

  // Find the first non-skipped stage
  const firstActiveIndex = stages.findIndex((s) => s.status !== "skipped");

  return {
    pipelineConfig: config,
    stages,
    currentStageIndex: firstActiveIndex >= 0 ? firstActiveIndex : 0,
    trackingRevision: 0,
    activationBoundary: null,
    completionObservations: [],
  };
}

/**
 * Get the ordered list of active (non-skipped) adapters for a given config.
 */
export function getActiveAdapters(
  config: PipelineConfig,
): PipelineStageAdapter[] {
  return ALL_ADAPTERS.filter((adapter) => !adapter.shouldSkip(config));
}

function hasNamedWorkflowMarkers(state: AutopilotState): boolean {
  return ["workflow", "workflowRunId", "pipelineTracking"].some((marker) =>
    Object.prototype.hasOwnProperty.call(state, marker),
  );
}

/**
 * Read pipeline tracking from an autopilot state.
 * Returns null if the state doesn't have pipeline tracking.
 */
export function readPipelineTracking(
  state: AutopilotState,
): PipelineTracking | null {
  return state.pipelineTracking ?? state.pipeline ?? null;
}

/**
 * Write pipeline tracking into an autopilot state and persist to disk.
 */
export function writePipelineTracking(
  directory: string,
  tracking: PipelineTracking,
  sessionId?: string,
): boolean {
  const state = readAutopilotState(directory, sessionId);
  if (!state) return false;

  if (hasNamedWorkflowMarkers(state)) return false;
  state.pipeline = tracking;
  return writeAutopilotState(directory, state, sessionId);
}

// ============================================================================
// PIPELINE INITIALIZATION
// ============================================================================

/**
 * Initialize a new pipeline-based autopilot session.
 *
 * This is the unified entry point that replaces separate initAutopilot calls
 * for autopilot, ultrawork, and ultrapilot.
 *
 * @param directory - Working directory
 * @param idea - The user's original idea/task
 * @param sessionId - Session ID for state isolation
 * @param autopilotConfig - Standard autopilot config overrides
 * @param pipelineConfig - Pipeline-specific configuration
 * @param deprecatedMode - If invoked via deprecated mode name (ultrawork/ultrapilot)
 * @returns The initialized autopilot state, or null if startup was blocked
 */
export function initPipeline(
  directory: string,
  idea: string,
  sessionId?: string,
  autopilotConfig?: Partial<AutopilotConfig>,
  pipelineConfig?: Partial<PipelineConfig>,
  deprecatedMode?: string,
): AutopilotState | null {
  // Resolve pipeline config
  const resolvedConfig = resolvePipelineConfig(pipelineConfig, deprecatedMode);

  // Initialize the base autopilot state
  const state = initAutopilot(directory, idea, sessionId, autopilotConfig);
  if (!state) return null;

  // Build and attach pipeline tracking
  const tracking = buildPipelineTracking(resolvedConfig);

  // Mark the first active stage as active
  if (
    tracking.currentStageIndex >= 0 &&
    tracking.currentStageIndex < tracking.stages.length
  ) {
    tracking.stages[tracking.currentStageIndex].status = "active";
    tracking.stages[tracking.currentStageIndex].startedAt =
      new Date().toISOString();
  }

  // Persist legacy pipeline tracking alongside autopilot state.
  state.pipeline = tracking;
  writeAutopilotState(directory, state, sessionId);

  return state;
}

// ============================================================================
// STAGE TRANSITIONS
// ============================================================================

/**
 * Get the current pipeline stage adapter.
 * Returns null if the pipeline is in a terminal state or all stages are done.
 */
export function getCurrentStageAdapter(
  tracking: PipelineTracking,
): PipelineStageAdapter | null {
  const { stages, currentStageIndex } = tracking;

  if (currentStageIndex < 0 || currentStageIndex >= stages.length) {
    return null;
  }

  const currentStage = stages[currentStageIndex];
  if (currentStage.status === "skipped" || currentStage.status === "complete") {
    // Find next active stage
    return getNextStageAdapter(tracking);
  }

  return getAdapterById(currentStage.id) ?? null;
}

/**
 * Get the next non-skipped stage adapter after the current one.
 * Returns null if no more stages remain.
 */
export function getNextStageAdapter(
  tracking: PipelineTracking,
): PipelineStageAdapter | null {
  const { stages, currentStageIndex } = tracking;

  for (let i = currentStageIndex + 1; i < stages.length; i++) {
    if (stages[i].status !== "skipped") {
      return getAdapterById(stages[i].id) ?? null;
    }
  }

  return null;
}

/**
 * Advance the pipeline to the next stage.
 *
 * Marks the current stage as complete, finds the next non-skipped stage,
 * and marks it as active. Returns the new current stage adapter, or null
 * if the pipeline is complete.
 */
/**
 * Advance one workflow stage only when the observed transition token still
 * matches persisted progress. A repeated Stop event becomes a no-op.
 */

export function advanceStage(
  directory: string,
  sessionId?: string,
): { adapter: PipelineStageAdapter | null; phase: PipelinePhase } {
  const state = readAutopilotState(directory, sessionId);
  if (!state) return { adapter: null, phase: "failed" };

  if (hasNamedWorkflowMarkers(state)) {
    return { adapter: null, phase: "failed" };
  }

  const tracking = readPipelineTracking(state);
  if (!tracking) return { adapter: null, phase: "failed" };

  const { stages, currentStageIndex } = tracking;

  // A completed transition must not be repeated by a later Stop observation.
  if (currentStageIndex < 0 || currentStageIndex >= stages.length) {
    return { adapter: null, phase: "complete" };
  }
  const currentStage = stages[currentStageIndex];
  if (currentStage.status !== "active") {
    return {
      adapter: getCurrentStageAdapter(tracking),
      phase: currentStage.id,
    };
  }
  currentStage.status = "complete";
  currentStage.completedAt = new Date().toISOString();

  // Call onExit if the adapter supports it
  const currentAdapter = getAdapterById(currentStage.id);
  if (currentAdapter?.onExit) {
    const context = buildContext(state, tracking);
    currentAdapter.onExit(context);
  }

  // Find next non-skipped stage
  let nextIndex = -1;
  for (let i = currentStageIndex + 1; i < stages.length; i++) {
    if (stages[i].status !== "skipped") {
      nextIndex = i;
      break;
    }
  }

  if (nextIndex < 0) {
    // All stages complete — pipeline is done
    tracking.currentStageIndex = stages.length;
    advanceTrackingRevision(state, tracking);
    writePipelineTracking(directory, tracking, sessionId);
    return { adapter: null, phase: "complete" };
  }

  // Activate next stage
  tracking.currentStageIndex = nextIndex;
  stages[nextIndex].status = "active";
  stages[nextIndex].startedAt = new Date().toISOString();
  advanceTrackingRevision(state, tracking);

  writePipelineTracking(directory, tracking, sessionId);

  // Call onEnter if the adapter supports it
  const nextAdapter = getAdapterById(stages[nextIndex].id)!;
  if (nextAdapter.onEnter) {
    const context = buildContext(state, tracking);
    nextAdapter.onEnter(context);
  }

  return { adapter: nextAdapter, phase: stages[nextIndex].id };
}

/**
 * Mark the current stage as failed and the pipeline as failed.
 */
export function failCurrentStage(
  directory: string,
  error: string,
  sessionId?: string,
): boolean {
  const state = readAutopilotState(directory, sessionId);
  if (!state) return false;

  const tracking = readPipelineTracking(state);
  if (!tracking) return false;

  const { stages, currentStageIndex } = tracking;
  if (currentStageIndex >= 0 && currentStageIndex < stages.length) {
    stages[currentStageIndex].status = "failed";
    stages[currentStageIndex].error = error;
    advanceTrackingRevision(state, tracking);
  }

  return writePipelineTracking(directory, tracking, sessionId);
}

/**
 * Increment the iteration counter for the current stage.
 */
export function incrementStageIteration(
  directory: string,
  sessionId?: string,
): boolean {
  const state = readAutopilotState(directory, sessionId);
  if (!state) return false;

  const tracking = readPipelineTracking(state);
  if (!tracking) return false;

  const { stages, currentStageIndex } = tracking;
  if (currentStageIndex >= 0 && currentStageIndex < stages.length) {
    stages[currentStageIndex].iterations++;
    advanceTrackingRevision(state, tracking);
  }

  return writePipelineTracking(directory, tracking, sessionId);
}

// ============================================================================
// SIGNAL DETECTION FOR PIPELINE
// ============================================================================

/**
 * Get the completion signal expected for the current pipeline stage.
 */
export function getCurrentCompletionSignal(
  tracking: PipelineTracking,
): string | null {
  const { stages, currentStageIndex } = tracking;
  if (currentStageIndex < 0 || currentStageIndex >= stages.length) return null;

  const adapter = getAdapterById(stages[currentStageIndex].id);
  return adapter?.completionSignal ?? null;
}

/**
 * Map from all pipeline completion signals to their stage IDs.
 */
export function getSignalToStageMap(): Map<string, PipelineStageId> {
  const map = new Map<string, PipelineStageId>();
  for (const adapter of ALL_ADAPTERS) {
    map.set(adapter.completionSignal, adapter.id);
  }
  return map;
}

// ============================================================================
// PROMPT GENERATION
// ============================================================================

/**
 * Generate the continuation prompt for the current pipeline stage.
 * This is the primary output consumed by the enforcement hook.
 */
export function generatePipelinePrompt(
  directory: string,
  sessionId?: string,
): string | null {
  const state = readAutopilotState(directory, sessionId);
  if (!state) return null;
  const namedWorkflow = hasNamedWorkflowMarkers(state);
  const tracking = namedWorkflow
    ? validateNamedWorkflowStateStructure(state, sessionId)?.tracking ?? null
    : readPipelineTracking(state);
  if (!tracking) return null;

  const adapter = getCurrentStageAdapter(tracking);
  if (!adapter) return null;

  const context = buildContext(state, tracking);
  return adapter.getPrompt(context);
}

/**
 * Generate a stage transition prompt when advancing between stages.
 */
export function generateTransitionPrompt(
  fromStage: PipelineStageId,
  toStage: PipelineStageId | "complete",
): string {
  if (toStage === "complete") {
    return `## PIPELINE COMPLETE

All pipeline stages have completed successfully!

Signal: AUTOPILOT_COMPLETE
`;
  }

  const toAdapter = getAdapterById(toStage);
  const toName = toAdapter?.name ?? toStage;

  return `## PIPELINE STAGE TRANSITION: ${fromStage.toUpperCase()} -> ${toStage.toUpperCase()}

The ${fromStage} stage is complete. Transitioning to: **${toName}**

`;
}

// ============================================================================
// PIPELINE STATUS & INSPECTION
// ============================================================================

/**
 * Get a summary of the pipeline's current status for display.
 */
export function getPipelineStatus(tracking: PipelineTracking): {
  currentStage: PipelineStageId | null;
  completedStages: PipelineStageId[];
  pendingStages: PipelineStageId[];
  skippedStages: PipelineStageId[];
  isComplete: boolean;
  progress: string;
} {
  const completed: PipelineStageId[] = [];
  const pending: PipelineStageId[] = [];
  const skipped: PipelineStageId[] = [];
  let current: PipelineStageId | null = null;

  for (const stage of tracking.stages) {
    switch (stage.status) {
      case "complete":
        completed.push(stage.id);
        break;
      case "active":
        current = stage.id;
        break;
      case "pending":
        pending.push(stage.id);
        break;
      case "skipped":
        skipped.push(stage.id);
        break;
    }
  }

  const activeStages = tracking.stages.filter((s) => s.status !== "skipped");
  const completedCount = completed.length;
  const totalActive = activeStages.length;
  const isComplete = current === null && pending.length === 0;
  const progress = `${completedCount}/${totalActive} stages`;

  return {
    currentStage: current,
    completedStages: completed,
    pendingStages: pending,
    skippedStages: skipped,
    isComplete,
    progress,
  };
}

/**
 * Format pipeline status for HUD display.
 */
export function formatPipelineHUD(tracking: PipelineTracking): string {
  const status = getPipelineStatus(tracking);
  const parts: string[] = [];

  for (const stage of tracking.stages) {
    const adapter = getAdapterById(stage.id);
    const name = adapter?.name ?? stage.id;
    switch (stage.status) {
      case "complete":
        parts.push(`[OK] ${name}`);
        break;
      case "active":
        parts.push(`[>>] ${name} (iter ${stage.iterations})`);
        break;
      case "pending":
        parts.push(`[..] ${name}`);
        break;
      case "skipped":
        parts.push(`[--] ${name}`);
        break;
      case "failed":
        parts.push(`[!!] ${name}`);
        break;
    }
  }

  return `Pipeline ${status.progress}: ${parts.join(" | ")}`;
}

// ============================================================================
// HELPERS
function advanceTrackingRevision(
  _state: AutopilotState,
  tracking: PipelineTracking,
): void {
  tracking.trackingRevision += 1;
}

// ============================================================================

/**
 * Build a PipelineContext from autopilot state and pipeline tracking.
 */
function buildContext(
  state: AutopilotState,
  tracking: PipelineTracking,
): PipelineContext {
  const namedWorkflow = hasNamedWorkflowMarkers(state);
  return {
    idea: namedWorkflow
      ? state.prompt || ""
      : state.originalIdea || state.prompt || "",
    directory: state.project_path || process.cwd(),
    sessionId: state.session_id,
    ...(namedWorkflow
      ? {}
      : {
          specPath: state.expansion?.spec_path || ".omc/autopilot/spec.md",
          planPath: state.planning?.plan_path || resolveAutopilotPlanPath(),
          openQuestionsPath: resolveOpenQuestionsPlanPath(),
        }),
    config: tracking.pipelineConfig ?? DEFAULT_PIPELINE_CONFIG,
  };
}

/**
 * Check if a state has pipeline tracking (i.e. was initialized via the new pipeline).
 */
export function hasPipelineTracking(state: AutopilotState): boolean {
  return readPipelineTracking(state) !== null;
}
