/**
 * Nikoflow Hook - Consolidated Module
 *
 * Enforced phase-gated methodology loop implementing "Niko Flow v2.1"
 * (grilling → ADR → PRD → tickets → execute → verify). Sibling of the ralph
 * mode: same Stop-hook enforcement pattern, plus an explicit phase dimension.
 */

export {
  // State management
  readNikoflowState,
  writeNikoflowState,
  clearNikoflowState,
  incrementNikoflowIteration,

  // Loop control
  createNikoflowLoopHook,

  // Depth / phase helpers
  detectDepthFlag,
  stripNikoflowFlags,
  materializePhases,

  // Role → model routing (TSK-010)
  detectRoleFlags,
  resolveRoles,
  isCodexRoleSpec,
  NIKOFLOW_DEFAULT_ROLES,
  NIKOFLOW_NATIVE_MODELS,
  NIKOFLOW_CODEX_SPECS,
  NIKOFLOW_MODEL_FALLBACK,
  type NikoflowRoles,
  getCurrentPhase,
  isNikoflowComplete,
  setNikoflowDepth,
  advanceNikoflowPhase,

  // Gate correlation (TSK-003)
  mintGateRequest,
  rotateGateRequest,
  clearGateRequest,
  recordNikoflowUserPrompt,
  readNikoflowUserTurnAt,
  userRepliedAfterMint,
  isNikoflowUserTurnFresh,

  // Verify convergence (TSK-006)
  recordVerifyPass,

  // Livelock guards (R1)
  bumpVerifyNoVerdict,
  resetVerifyNoVerdict,
  bumpExecuteStall,
  resetExecuteStall,

  // Constants
  NIKOFLOW_DEPTHS,
  NIKOFLOW_PHASES,
  NIKOFLOW_VERIFY_SCORE_THRESHOLD,
  NIKOFLOW_VERIFY_MAX_PASSES,
  NIKOFLOW_VERIFY_MAX_NO_VERDICT,
  NIKOFLOW_EXECUTE_MAX_STALL,

  // Types
  type NikoflowDepth,
  type NikoflowState,
  type NikoflowLoopOptions,
  type NikoflowLoopHook,
} from "./loop.js";

export {
  getDepthSelectionPrompt,
  getPhasePrompt,
} from "./prompts.js";

export {
  detectNikoflowGate,
  NIKOFLOW_GATE_PAYLOADS,
  HUMAN_GATE_PHASES,
  type GateMatch,
} from "./gates.js";

export {
  normalizeTicketsFile,
  lintTicketsRaw,
  lintTicketsFile,
  readTickets,
  writeTickets,
  clearTickets,
  validateTicketDag,
  getNextTicket,
  allTicketsDone,
  markTicketStatus,
  isTicketDeadlock,
  type NikoflowTicket,
  type NikoflowTicketsFile,
  type TicketStatus,
  type DagValidation,
} from "./tickets.js";

export {
  getExecuteTicketPrompt,
  getVerifyPrompt,
  renderReviewerSpawn,
  renderPanel,
} from "./prompts.js";

export {
  detectPbtFramework,
  pbtObligation,
  type PbtFramework,
  type PbtStatus,
  type PbtDetection,
  type PbtObligation,
} from "./pbt.js";

export {
  ticketWorktreeRelPath,
  ticketWorktreePath,
  ticketWorktreeBranch,
  ticketWorktreeCreateCmd,
  ticketWorktreeMergeCmd,
  ticketWorktreeRemoveCmd,
} from "./worktree.js";
