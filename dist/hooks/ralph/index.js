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
readRalphState, writeRalphState, clearRalphState, clearLinkedUltraworkState, incrementRalphIteration, 
// Loop control
createRalphLoopHook, isUltraQAActive, 
// PRD flag helpers
detectNoPrdFlag, stripNoPrdFlag, 
// Team coordination
getTeamPhaseDirective, 
// PRD integration
hasPrd, getPrdCompletionStatus, getRalphContext, setCurrentStory, enablePrdMode, recordStoryProgress, recordPattern, shouldCompleteByPrd } from './loop.js';
// ============================================================================
// Ralph PRD (Product Requirements Document)
// ============================================================================
export { 
// File operations
readPrd, writePrd, findPrdPath, getPrdPath, getOmcPrdPath, 
// PRD status & operations
getPrdStatus, markStoryComplete, markStoryIncomplete, getStory, getNextStory, 
// PRD creation
createPrd, createSimplePrd, initPrd, 
// Formatting
formatPrdStatus, formatStory, formatPrd, formatNextStoryPrompt, 
// Constants
PRD_FILENAME, PRD_EXAMPLE_FILENAME } from './prd.js';
// ============================================================================
// Ralph Progress (Memory Persistence)
// ============================================================================
export { 
// File operations
readProgress, readProgressRaw, parseProgress, findProgressPath, getProgressPath, getOmcProgressPath, 
// Progress operations
initProgress, appendProgress, addPattern, 
// Context getters
getPatterns, getRecentLearnings, formatPatternsForContext, formatProgressForContext, formatLearningsForContext, getProgressContext, 
// Constants
PROGRESS_FILENAME, PATTERNS_HEADER, ENTRY_SEPARATOR } from './progress.js';
// ============================================================================
// Ralph Verifier (Architect Verification)
// ============================================================================
export { 
// State management
readVerificationState, writeVerificationState, clearVerificationState, 
// Verification workflow
startVerification, recordArchitectFeedback, 
// Prompts & detection
getArchitectVerificationPrompt, getArchitectRejectionContinuationPrompt, detectArchitectApproval, detectArchitectRejection } from './verifier.js';
//# sourceMappingURL=index.js.map