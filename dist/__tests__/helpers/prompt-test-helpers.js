import { expect } from 'vitest';
export const STANDARD_MISSING_PROMPT_ERROR = "Either 'prompt' (inline) or 'prompt_file' (file path) is required";
export function expectMissingPromptError(text) {
    expect(text).toContain(STANDARD_MISSING_PROMPT_ERROR);
}
export function expectNoMissingPromptError(text) {
    expect(text).not.toContain(STANDARD_MISSING_PROMPT_ERROR);
}
//# sourceMappingURL=prompt-test-helpers.js.map