import { expect } from 'vitest';

export const STANDARD_MISSING_PROMPT_ERROR = "Either 'prompt' (inline) or 'prompt_file' (file path) is required";

export function expectMissingPromptError(text: string): void {
  expect(text).toContain(STANDARD_MISSING_PROMPT_ERROR);
}

export function expectNoMissingPromptError(text: string): void {
  expect(text).not.toContain(STANDARD_MISSING_PROMPT_ERROR);
}
