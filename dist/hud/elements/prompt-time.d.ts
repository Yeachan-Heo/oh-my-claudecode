/**
 * OMC HUD - Prompt Time Element
 *
 * Renders elapsed time since the last user prompt submission.
 * Recorded by the keyword-detector hook on UserPromptSubmit.
 */
/**
 * Render elapsed time since prompt submission.
 *
 * Format: ⏱13s  or  ⏱1m23s  or  ⏱2h3m
 * Falls back to HH:MM:SS timestamp if now is not provided.
 */
export declare function renderPromptTime(promptTime: Date | null, now?: Date): string | null;
//# sourceMappingURL=prompt-time.d.ts.map