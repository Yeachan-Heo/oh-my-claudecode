/**
 * Ralph Hook - Consolidated Module
 *
 * Self-referential work loop with PRD support, progress tracking, and architect verification.
 * All ralph-related functionality is now consolidated in this single module.
 */

// ============================================================================
// Ralph Loop
// ============================================================================

export {
  // State management
  readRalphState,
  writeRalphState,
  clearRalphState,
  clearLinkedUltraworkState,
  incrementRalphIteration,

  // Loop control
  createRalphLoopHook,
  detectCompletionPromise,
  isUltraQAActive,

  // PRD integration
  hasPrd,
  getPrdCompletionStatus,
  getRalphContext,
  setCurrentStory,
  enablePrdMode,
  recordStoryProgress,
  recordPattern,
  shouldCompleteByPrd,

  // Types
  type RalphLoopState,
  type RalphLoopOptions,
  type RalphLoopHook,
  type PRD,
  type PRDStatus,
  type UserStory
} from './loop.js';

// ============================================================================
// Ralph PRD (Product Requirements Document)
// ============================================================================

export {
  // File operations
  readPrd,
  writePrd,
  findPrdPath,
  getPrdPath,
  getOmcPrdPath,

  // PRD status & operations
  getPrdStatus,
  markStoryComplete,
  markStoryIncomplete,
  getStory,
  getNextStory,

  // PRD creation
  createPrd,
  createSimplePrd,
  initPrd,

  // Formatting
  formatPrdStatus,
  formatStory,
  formatPrd,
  formatNextStoryPrompt,

  // Constants
  PRD_FILENAME,
  PRD_EXAMPLE_FILENAME,

  // Types (re-export with aliases to avoid conflicts)
  type UserStoryInput
} from './prd.js';

// ============================================================================
// Ralph Progress (Memory Persistence)
// ============================================================================

export {
  // File operations
  readProgress,
  readProgressRaw,
  parseProgress,
  findProgressPath,
  getProgressPath,
  getOmcProgressPath,

  // Progress operations
  initProgress,
  appendProgress,
  addPattern,

  // Context getters
  getPatterns,
  getRecentLearnings,
  formatPatternsForContext,
  formatProgressForContext,
  formatLearningsForContext,
  getProgressContext,

  // Constants
  PROGRESS_FILENAME,
  PATTERNS_HEADER,
  ENTRY_SEPARATOR,

  // Types
  type ProgressEntry,
  type CodebasePattern,
  type ProgressLog
} from './progress.js';

// ============================================================================
// Ralph Verifier (Architect Verification)
// ============================================================================

export {
  // State management
  readVerificationState,
  writeVerificationState,
  clearVerificationState,

  // Verification workflow
  startVerification,
  recordArchitectFeedback,

  // Prompts & detection
  getArchitectVerificationPrompt,
  getArchitectRejectionContinuationPrompt,
  detectArchitectApproval,
  detectArchitectRejection,

  // Types
  type VerificationState
} from './verifier.js';

// ============================================================================
// Ralph Fresh-Context (Fresh Subagent per Iteration)
// ============================================================================

export {
  // Helper functions
  isRalphFreshActive,
  isStandardRalphActive,

  // Configuration
  DEFAULT_FRESH_CONFIG,

  // Core types
  type RalphFreshHandoff,
  type RalphFreshConfig,
  type RalphFreshPrd,
  type RalphFreshProgress,
  type RalphFreshGit,
  type RalphFreshStuckDetection,
  type RalphFreshError
} from './fresh.js';

export {
  // Handoff operations
  initHandoff,
  readHandoff,
  writeHandoff,
  refreshHandoffFromFiles,
  getHandoffPath,
  clearHandoff
} from './fresh-handoff.js';

export {
  // Prompt generation
  generateIterationPrompt
} from './fresh-prompt.js';
