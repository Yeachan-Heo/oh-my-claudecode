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

import { randomUUID } from 'crypto';
import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync } from 'fs';
import { join } from 'path';
import { resolveSessionStatePath, ensureSessionStateDir, getOmcRoot } from '../../lib/worktree-paths.js';
import { formatOmcCliInvocation } from '../../utils/omc-cli-rendering.js';
import type { UserStory } from './prd.js';
import type { RalphCriticMode } from './loop.js';

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
  /** Whether this verification is gating a single story or full completion */
  verification_scope?: 'story' | 'completion';
  /** Story under review when verification_scope === 'story' */
  story_id?: string;
  /** Reviewer mode to use for verification */
  critic_mode?: RalphCriticMode;
  /** Unique request id used to correlate approvals to the current verification attempt */
  request_id?: string;
}

const DEFAULT_MAX_VERIFICATION_ATTEMPTS = 3;
const DEFAULT_RALPH_CRITIC_MODE: RalphCriticMode = 'architect';

function createVerificationRequestId(): string {
  return randomUUID();
}

function getCriticMode(mode?: RalphCriticMode): RalphCriticMode {
  return mode ?? DEFAULT_RALPH_CRITIC_MODE;
}

function getCriticLabel(mode?: RalphCriticMode): string {
  switch (getCriticMode(mode)) {
    case 'critic':
      return 'Critic';
    case 'codex':
      return 'Codex critic';
    default:
      return 'Architect';
  }
}

function getVerificationAgentStep(mode?: RalphCriticMode): string {
  switch (getCriticMode(mode)) {
    case 'critic':
      return `1. **Spawn Critic Agent** for verification:
   \`\`\`
   Task(subagent_type="critic", prompt="Critically review this task completion claim...")
   \`\`\``;
    case 'codex':
      return `1. **Run an external Codex critic review**:
   \`\`\`
   ${formatOmcCliInvocation('ask codex --agent-prompt critic "<verification prompt covering the task, completion claim, and acceptance criteria>"')}
   \`\`\`
   Use the Codex output as the reviewer verdict before deciding pass/fix.`;
    default:
      return `1. **Spawn Architect Agent** for verification:
   \`\`\`
   Task(subagent_type="architect", prompt="Verify this task completion claim...")
   \`\`\``;
  }
}

/**
 * Get verification state file path
 * When sessionId is provided, uses session-scoped path.
 */
function getVerificationStatePath(directory: string, sessionId?: string): string {
  if (sessionId) {
    return resolveSessionStatePath('ralph-verification', sessionId, directory);
  }
  return join(getOmcRoot(directory), 'ralph-verification.json');
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
    const state = JSON.parse(readFileSync(statePath, 'utf-8')) as VerificationState;
    if (!state.request_id) {
      state.request_id = createVerificationRequestId();
      writeVerificationState(directory, state, sessionId);
    }
    return state;
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
    const stateDir = getOmcRoot(directory);
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
  criticMode?: RalphCriticMode,
  sessionId?: string,
  currentStory?: UserStory
): VerificationState {
  const state: VerificationState = {
    pending: true,
    completion_claim: completionClaim,
    verification_attempts: 0,
    max_verification_attempts: DEFAULT_MAX_VERIFICATION_ATTEMPTS,
    requested_at: new Date().toISOString(),
    original_task: originalTask,
    verification_scope: currentStory ? 'story' : 'completion',
    story_id: currentStory?.id,
    critic_mode: getCriticMode(criticMode),
    request_id: createVerificationRequestId()
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
 * When a currentStory is provided, includes its specific acceptance criteria for targeted verification.
 */
export function getArchitectVerificationPrompt(state: VerificationState, currentStory?: UserStory): string {
  const criticLabel = getCriticLabel(state.critic_mode);
  const approvalTag = `<ralph-approved critic="${getCriticMode(state.critic_mode)}" request-id="${state.request_id}"${state.story_id ? ` story-id="${state.story_id}"` : ''}>VERIFIED_COMPLETE</ralph-approved>`;
  const storySection = currentStory ? `
**Current Story: ${currentStory.id} - ${currentStory.title}**
${currentStory.description}

**Acceptance Criteria to Verify:**
${currentStory.acceptanceCriteria.map((c, i) => `${i + 1}. ${c}`).join('\n')}

IMPORTANT: This review gates Ralph's progression to the next story/complete state. Verify EACH acceptance criterion above is met. Do not verify based on general impressions — check each criterion individually with concrete evidence.
` : '';

  return `<ralph-verification>

[${criticLabel.toUpperCase()} VERIFICATION REQUIRED - Attempt ${state.verification_attempts + 1}/${state.max_verification_attempts}]

The agent claims the task is complete. Before accepting, YOU MUST verify with ${criticLabel}.

**Original Task:**
${state.original_task}

**Completion Claim:**
${state.completion_claim}

${state.architect_feedback ? `**Previous ${criticLabel} Feedback (rejected):**\n${state.architect_feedback}\n` : ''}
${storySection}
## MANDATORY VERIFICATION STEPS

${getVerificationAgentStep(state.critic_mode)}

2. **${criticLabel} must check:**${currentStory ? `
   - Verify EACH acceptance criterion listed above is met with fresh evidence
   - Run the relevant tests/builds to confirm criteria pass` : `
   - Are ALL requirements from the original task met?
   - Is the implementation complete, not partial?`}
   - Are there any obvious bugs or issues?
   - Does the code compile/run without errors?
   - Are tests passing (if applicable)?
   - Return ONLY a concise review summary under 100 words with verdict, evidence highlights, files checked, and blockers. Do not paste long logs inline.

3. **Based on ${criticLabel}'s response:**
   - If APPROVED: Output the exact correlated approval tag \`${approvalTag}\`, then run \`/oh-my-claudecode:cancel\` to cleanly exit
   - If REJECTED: Continue working on the identified issues

</ralph-verification>

---

`;
}

/**
 * Generate continuation prompt after architect rejection
 */
export function getArchitectRejectionContinuationPrompt(state: VerificationState): string {
  const criticLabel = getCriticLabel(state.critic_mode);
  return `<ralph-continuation-after-rejection>

[${criticLabel.toUpperCase()} REJECTED - Continue Working]

${criticLabel} found issues with your completion claim. You must address them.

**${criticLabel} Feedback:**
${state.architect_feedback}

**Original Task:**
${state.original_task}

## INSTRUCTIONS

1. Address ALL issues identified by ${criticLabel}
2. Do NOT claim completion again until issues are fixed${state.story_id ? `, and do not progress story ${state.story_id} until it passes review` : ''}
3. When truly done, another ${criticLabel} verification will be triggered
4. After ${criticLabel} approves, run \`/oh-my-claudecode:cancel\` to cleanly exit

Continue working now.

</ralph-continuation-after-rejection>

---

`;
}

/**
 * Check if text contains architect approval
 */
function extractApprovalAttribute(attributes: string, attributeName: string): string | undefined {
  const match = new RegExp(`\\b${attributeName}=(["'])(.*?)\\1`, 'i').exec(attributes);
  return match?.[2];
}

function stripInjectedApprovalExamples(text: string): string {
  return text
    .replace(/<ralph-verification>[\s\S]*?<\/ralph-verification>/gi, ' ')
    .replace(/`<(?:architect-approved|ralph-approved)\b[\s\S]*?<\/(?:architect-approved|ralph-approved)>`/gi, ' ');
}

export function detectArchitectApproval(
  text: string,
  expected?: Pick<VerificationState, 'request_id' | 'story_id'>
): boolean {
  const sanitizedText = stripInjectedApprovalExamples(text);
  const matches = sanitizedText.matchAll(/<(?:architect-approved|ralph-approved)\b([^>]*)>.*?VERIFIED_COMPLETE.*?<\/(?:architect-approved|ralph-approved)>/gis);

  for (const match of matches) {
    const attributes = match[1] ?? '';

    if (!expected) {
      return true;
    }

    if (!expected.request_id) {
      continue;
    }

    const requestId = extractApprovalAttribute(attributes, 'request-id');
    if (requestId !== expected.request_id) {
      continue;
    }

    if (expected.story_id) {
      const storyId = extractApprovalAttribute(attributes, 'story-id');
      if (storyId !== expected.story_id) {
        continue;
      }
    }

    return true;
  }

  return false;
}

/**
 * Check if text contains architect rejection indicators
 */
export function detectArchitectRejection(text: string): { rejected: boolean; feedback: string } {
  // Look for explicit rejection patterns
  const rejectionPatterns = [
    /(architect|critic|codex|reviewer).*?(rejected|found issues|not complete|incomplete)/i,
    /issues? (found|identified|detected)/i,
    /not yet complete/i,
    /missing.*?(implementation|feature|test)/i,
    /bug.*?(found|detected|identified)/i,
    /error.*?(found|detected|identified)/i
  ];

  for (const pattern of rejectionPatterns) {
    if (pattern.test(text)) {
      // Extract feedback (rough heuristic)
      const feedbackMatch = text.match(/(?:architect|critic|codex|reviewer|feedback|issue|problem|error|bug)[:\s]+([^.]+\.)/i);
      return {
        rejected: true,
        feedback: feedbackMatch ? feedbackMatch[1] : 'Architect found issues with the implementation.'
      };
    }
  }

  return { rejected: false, feedback: '' };
}
