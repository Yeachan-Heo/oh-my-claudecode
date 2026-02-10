/**
 * Ralph Verifier
 *
 * Adds architect verification to ralph completion claims.
 * When ralph claims completion, an architect verification phase is triggered.
 *
 * Flow:
 * 1. Ralph claims task is complete
 * 2. System enters verification mode
 * 3. Architect agent is invoked to verify the work
 * 4. If architect approves -> truly complete, use /oh-my-claudecode:cancel to exit
 * 5. If architect finds flaws -> continue ralph with architect feedback
 */

import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync } from 'fs';
import { join } from 'path';
import { resolveSessionStatePath, ensureSessionStateDir } from '../../lib/worktree-paths.js';

export interface VerificationState {
  /** Whether verification is pending */
  pending: boolean;
  /** The completion claim that triggered verification */
  completion_claim: string;
  /** Number of verification attempts */
  verification_attempts: number;
  /** Max verification attempts before force-accepting */
  max_verification_attempts: number;
  /** Architect feedback from last verification */
  architect_feedback?: string;
  /** Whether architect approved */
  architect_approved?: boolean;
  /** Timestamp of verification request */
  requested_at: string;
  /** Original ralph task */
  original_task: string;
}

const DEFAULT_MAX_VERIFICATION_ATTEMPTS = 3;

/**
 * Get verification state file path
 * When sessionId is provided, uses session-scoped path.
 */
function getVerificationStatePath(directory: string, sessionId?: string): string {
  if (sessionId) {
    return resolveSessionStatePath('ralph-verification', sessionId, directory);
  }
  return join(directory, '.omc', 'ralph-verification.json');
}

/**
 * Read verification state
 * @param sessionId - When provided, reads from session-scoped path only (no legacy fallback)
 */
export function readVerificationState(directory: string, sessionId?: string): VerificationState | null {
  const statePath = getVerificationStatePath(directory, sessionId);
  if (!existsSync(statePath)) {
    return null;
  }
  try {
    return JSON.parse(readFileSync(statePath, 'utf-8'));
  } catch {
    return null;
  }
}

/**
 * Write verification state
 */
export function writeVerificationState(directory: string, state: VerificationState, sessionId?: string): boolean {
  const statePath = getVerificationStatePath(directory, sessionId);

  if (sessionId) {
    ensureSessionStateDir(sessionId, directory);
  } else {
    const stateDir = join(directory, '.omc');
    if (!existsSync(stateDir)) {
      try {
        mkdirSync(stateDir, { recursive: true });
      } catch {
        return false;
      }
    }
  }

  try {
    writeFileSync(statePath, JSON.stringify(state, null, 2));
    return true;
  } catch {
    return false;
  }
}

/**
 * Clear verification state
 * @param sessionId - When provided, clears session-scoped state only
 */
export function clearVerificationState(directory: string, sessionId?: string): boolean {
  const statePath = getVerificationStatePath(directory, sessionId);
  if (existsSync(statePath)) {
    try {
      unlinkSync(statePath);
      return true;
    } catch {
      return false;
    }
  }
  return true;
}

/**
 * Start verification process
 */
export function startVerification(
  directory: string,
  completionClaim: string,
  originalTask: string,
  sessionId?: string
): VerificationState {
  const state: VerificationState = {
    pending: true,
    completion_claim: completionClaim,
    verification_attempts: 0,
    max_verification_attempts: DEFAULT_MAX_VERIFICATION_ATTEMPTS,
    requested_at: new Date().toISOString(),
    original_task: originalTask
  };

  writeVerificationState(directory, state, sessionId);
  return state;
}

/**
 * Record architect feedback
 */
export function recordArchitectFeedback(
  directory: string,
  approved: boolean,
  feedback: string,
  sessionId?: string
): VerificationState | null {
  const state = readVerificationState(directory, sessionId);
  if (!state) {
    return null;
  }

  state.verification_attempts += 1;
  state.architect_approved = approved;
  state.architect_feedback = feedback;

  if (approved) {
    // Clear state on approval
    clearVerificationState(directory, sessionId);
    return { ...state, pending: false };
  }

  // Check if max attempts reached
  if (state.verification_attempts >= state.max_verification_attempts) {
    clearVerificationState(directory, sessionId);
    return { ...state, pending: false };
  }

  // Continue verification loop
  writeVerificationState(directory, state, sessionId);
  return state;
}

/**
 * Generate architect verification prompt
 */
export function getArchitectVerificationPrompt(state: VerificationState): string {
  return `<ralph-verification>

[ARCHITECT VERIFICATION REQUIRED - Attempt ${state.verification_attempts + 1}/${state.max_verification_attempts}]

The agent claims the task is complete. Before accepting, YOU MUST verify with Architect.

**Original Task:**
${state.original_task}

**Completion Claim:**
${state.completion_claim}

${state.architect_feedback ? `**Previous Architect Feedback (rejected):**\n${state.architect_feedback}\n` : ''}

## MANDATORY VERIFICATION STEPS

1. **Spawn Architect Agent** for verification:
   \`\`\`
   Task(subagent_type="architect", prompt="Verify this task completion claim...")
   \`\`\`

2. **Architect must check:**
   - Are ALL requirements from the original task met?
   - Is the implementation complete, not partial?
   - Are there any obvious bugs or issues?
   - Does the code compile/run without errors?
   - Are tests passing (if applicable)?

3. **Based on Architect's response:**
   - If APPROVED: Output \`<architect-approved>VERIFIED_COMPLETE</architect-approved>\`, then run \`/oh-my-claudecode:cancel\` to cleanly exit
   - If REJECTED: Continue working on the identified issues

</ralph-verification>

---

`;
}

/**
 * Generate continuation prompt after architect rejection
 */
export function getArchitectRejectionContinuationPrompt(state: VerificationState): string {
  return `<ralph-continuation-after-rejection>

[ARCHITECT REJECTED - Continue Working]

Architect found issues with your completion claim. You must address them.

**Architect Feedback:**
${state.architect_feedback}

**Original Task:**
${state.original_task}

## INSTRUCTIONS

1. Address ALL issues identified by Architect
2. Do NOT claim completion again until issues are fixed
3. When truly done, another Architect verification will be triggered
4. After Architect approves, run \`/oh-my-claudecode:cancel\` to cleanly exit

Continue working now.

</ralph-continuation-after-rejection>

---

`;
}

/**
 * Check if text contains architect approval
 */
export function detectArchitectApproval(text: string): boolean {
  return /<architect-approved>.*?VERIFIED_COMPLETE.*?<\/architect-approved>/is.test(text);
}

/**
 * Check if text contains architect rejection indicators
 */
export function detectArchitectRejection(text: string): { rejected: boolean; feedback: string } {
  // Look for explicit rejection patterns
  const rejectionPatterns = [
    /architect.*?(rejected|found issues|not complete|incomplete)/i,
    /issues? (found|identified|detected)/i,
    /not yet complete/i,
    /missing.*?(implementation|feature|test)/i,
    /bug.*?(found|detected|identified)/i,
    /error.*?(found|detected|identified)/i
  ];

  for (const pattern of rejectionPatterns) {
    if (pattern.test(text)) {
      // Extract feedback (rough heuristic)
      const feedbackMatch = text.match(/(?:architect|feedback|issue|problem|error|bug)[:\s]+([^.]+\.)/i);
      return {
        rejected: true,
        feedback: feedbackMatch ? feedbackMatch[1] : 'Architect found issues with the implementation.'
      };
    }
  }

  return { rejected: false, feedback: '' };
}
