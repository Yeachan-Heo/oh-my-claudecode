/**
 * Ralph Hook - Consolidated Module
 *
 * Self-referential work loop with PRD support, progress tracking, and architect verification.
 * All ralph-related functionality is now consolidated in this single module.
 */
export { readRalphState, writeRalphState, clearRalphState, clearLinkedUltraworkState, incrementRalphIteration, createRalphLoopHook, isUltraQAActive, detectNoPrdFlag, stripNoPrdFlag, detectCriticModeFlag, stripCriticModeFlag, normalizeRalphCriticMode, getTeamPhaseDirective, hasPrd, getPrdCompletionStatus, getRalphContext, setCurrentStory, enablePrdMode, recordStoryProgress, recordPattern, shouldCompleteByPrd, type RalphLoopState, type RalphCriticMode, type RalphLoopOptions, type RalphLoopHook, type PRD, type PRDStatus, type UserStory } from './loop.js';
export { readPrd, writePrd, findPrdPath, getPrdPath, getOmcPrdPath, getSessionPrdPath, getLegacyStatePrdPath, getPrdStatus, markStoryComplete, markStoryIncomplete, markStoryArchitectVerified, getStory, getNextStory, createPrd, createSimplePrd, initPrd, ensurePrdForStartup, formatPrdStatus, formatStory, formatPrd, formatNextStoryPrompt, PRD_FILENAME, PRD_EXAMPLE_FILENAME, type UserStoryInput } from './prd.js';
export { readProgress, readProgressRaw, parseProgress, findProgressPath, getProgressPath, getOmcProgressPath, initProgress, appendProgress, addPattern, getPatterns, getRecentLearnings, formatPatternsForContext, formatProgressForContext, formatLearningsForContext, getProgressContext, PROGRESS_FILENAME, PATTERNS_HEADER, ENTRY_SEPARATOR, type ProgressEntry, type CodebasePattern, type ProgressLog } from './progress.js';
export { readVerificationState, writeVerificationState, clearVerificationState, startVerification, recordArchitectFeedback, getArchitectVerificationPrompt, getArchitectRejectionContinuationPrompt, detectArchitectApproval, detectArchitectRejection, type VerificationState } from './verifier.js';
//# sourceMappingURL=index.d.ts.map