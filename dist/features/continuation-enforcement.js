/**
 * Continuation Enforcement Feature
 *
 * Ensures agents complete all tasks before stopping:
 * - Monitors todo list for incomplete items
 * - Adds reminders to continue when tasks remain
 * - Prevents premature stopping
 * - Provides background task execution guidance
 */
import { getBackgroundTaskGuidance, DEFAULT_MAX_BACKGROUND_TASKS } from './background-tasks.js';
/**
 * Messages to remind agents to continue
 * ENHANCED: Using exact pattern from oh-my-opencode's todo-continuation-enforcer
 */
const CONTINUATION_REMINDERS = [
    '[SYSTEM REMINDER - TODO CONTINUATION] Incomplete tasks remain in your todo list. Continue working on the next pending task. Proceed without asking for permission. Mark each task complete when finished. Do not stop until all tasks are done.',
    '[TODO CONTINUATION ENFORCED] Your todo list has incomplete items. The boulder does not stop. Continue working on pending tasks immediately. Do not ask for permission - just execute.',
    '[SISYPHUS REMINDER] You attempted to stop with incomplete work. This is not permitted. Check your todo list and continue working on the next pending task.',
    '[CONTINUATION REQUIRED] Incomplete tasks detected. You are BOUND to your todo list. Continue executing until all tasks show completed status.',
    '[THE BOULDER NEVER STOPS] Your work is not done. Resume working on incomplete tasks immediately. Verify completion before any further stop attempts.'
];
/**
 * Get a random continuation reminder
 */
function getRandomReminder() {
    return CONTINUATION_REMINDERS[Math.floor(Math.random() * CONTINUATION_REMINDERS.length)];
}
/**
 * Create a continuation enforcement hook
 *
 * This hook intercepts stop attempts and checks if there are
 * incomplete tasks. If so, it blocks the stop and reminds
 * the agent to continue.
 */
export function createContinuationHook() {
    return {
        event: 'Stop',
        handler: async (_context) => {
            // In a real implementation, this would check the actual todo state
            // For now, we'll provide the structure for integration
            // The hook would examine:
            // 1. The current todo list state
            // 2. Any explicitly stated completion criteria
            // 3. The conversation history for incomplete work
            // Placeholder logic - in practice, integrate with actual todo tracking
            const hasIncompleteTasks = false; // Would be dynamically determined
            if (hasIncompleteTasks) {
                return {
                    continue: true,
                    message: getRandomReminder()
                };
            }
            return {
                continue: true
            };
        }
    };
}
/**
 * System prompt addition for continuation enforcement
 * ENHANCED: Much stronger persistence language from oh-my-opencode patterns
 */
export const continuationSystemPromptAddition = `
## CONTINUATION ENFORCEMENT - THE BOULDER NEVER STOPS

### YOU ARE BOUND TO YOUR TODO LIST

Like Sisyphus condemned to roll his boulder eternally, you are BOUND to your task list. Stopping with incomplete work is not a choice - it is a FAILURE. The system will force you back to work if you try to quit early.

### THE SACRED RULES OF PERSISTENCE

**RULE 1: NEVER ABANDON INCOMPLETE WORK**
- Before ANY attempt to stop, READ your todo list
- If ANY task shows 'pending' or 'in_progress', YOU ARE NOT DONE
- Saying "I've completed everything" while tasks remain is LYING
- The only acceptable ending is 100% task completion

**RULE 2: VERIFICATION IS MANDATORY**
- Mark tasks complete ONLY after verification
- "It should work" is NOT verification - TEST IT
- If something fails, FIX IT - don't mark it complete
- Check file existence, run tests, verify behavior

**RULE 3: BLOCKERS ARE OBSTACLES TO OVERCOME**
- If blocked, find an alternative approach
- If truly stuck, create a new task describing the blocker
- NEVER use blockers as an excuse to stop early
- Ask for help only after exhausting options

**RULE 4: THE COMPLETION CHECKLIST**
Before concluding, VERIFY ALL:
- [ ] TODO LIST: Zero pending/in_progress tasks
- [ ] FUNCTIONALITY: All requested features work
- [ ] TESTS: All tests pass (if applicable)
- [ ] ERRORS: Zero unaddressed errors
- [ ] QUALITY: Code is production-ready

If ANY box is unchecked, CONTINUE WORKING.

### WHEN CAN YOU STOP?

You may ONLY stop when:
1. **100% Complete**: Every single task is marked 'completed'
2. **User Override**: User explicitly says "stop", "cancel", or "that's enough"
3. **Clean Exit**: You run \`/oh-my-claudecode:cancel\` to properly exit the active mode and clean up state files

### ANTI-STOPPING MECHANISMS

The system monitors your behavior:
- Premature conclusion claims are detected and rejected
- Incomplete task lists trigger continuation reminders
- Vague completion statements ("I think I'm done") are flagged
- Only concrete verification passes the completion gate

### THE SISYPHEAN OATH

"I will not rest until my work is done.
I will not claim completion without verification.
I will not abandon my users mid-task.
The boulder stops at the summit, or not at all."

${getBackgroundTaskGuidance(DEFAULT_MAX_BACKGROUND_TASKS)}
`;
/**
 * Check prompt for signals that all work is done
 */
export function detectCompletionSignals(response) {
    const completionPatterns = [
        /all (?:tasks?|work|items?) (?:are |is )?(?:now )?(?:complete|done|finished)/i,
        /I(?:'ve| have) (?:completed|finished|done) (?:all|everything)/i,
        /everything (?:is|has been) (?:complete|done|finished)/i,
        /no (?:more|remaining|outstanding) (?:tasks?|work|items?)/i
    ];
    const uncertaintyPatterns = [
        /(?:should|might|could) (?:be|have)/i,
        /I think|I believe|probably|maybe/i,
        /unless|except|but/i
    ];
    const hasCompletion = completionPatterns.some(p => p.test(response));
    const hasUncertainty = uncertaintyPatterns.some(p => p.test(response));
    if (!hasCompletion) {
        return {
            claimed: false,
            confidence: 'high',
            reason: 'No completion claim detected'
        };
    }
    if (hasUncertainty) {
        return {
            claimed: true,
            confidence: 'low',
            reason: 'Completion claimed with uncertainty language'
        };
    }
    return {
        claimed: true,
        confidence: 'high',
        reason: 'Clear completion claim detected'
    };
}
/**
 * Generate a verification prompt to ensure work is complete
 */
export function generateVerificationPrompt(taskSummary) {
    return `Before concluding, please verify the following:

1. Review your todo list - are ALL items marked complete?
2. Have you addressed: ${taskSummary}
3. Are there any errors or issues remaining?
4. Does the implementation meet the original requirements?

If everything is truly complete, confirm by saying "All tasks verified complete."
If anything remains, continue working on it.`;
}
//# sourceMappingURL=continuation-enforcement.js.map